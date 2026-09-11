/**
 * prove_bench.ts -- measure the proof server's CONCURRENCY curve, locally.
 *
 * The decisive question for the whole load test: when we fire K proofs at once,
 * does the server run them in parallel or queue them? Measured evidence so far:
 * a dust proof takes 2.3s with 1-2 wallets but 17.6s with 12 -- a 7.6x
 * degradation that capped the fleet at ~0.5 tx/s and ~1% block fullness, no
 * matter how many wallets we added.
 *
 *   serialising  -> container pegs near 100% (one core) -> N containers scale
 *   saturating   -> container approaches 1600% (16 cores) -> need more hardware
 *
 * Nothing is submitted. Recipes are built, proven, then reverted, so this touches
 * the indexer only to sync one wallet and never loads the node or the chain.
 * That also means it can be run freely while rate-limited.
 *
 *   npx tsx src/prove_bench.ts --only w001 --concurrency 1,2,4,8,12
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { ttlOneHour } from '@midnight-ntwrk/midnight-js-utils';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { buildWallet, waitForRealSync, NETWORK_ID, PROOF_SERVER_URL } from './providers.js';

const NIGHT: string = ledger.nativeToken().raw;
const args: Record<string, string> = {};
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) args[a[i].slice(2)] = a[++i];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const snap = (w: any): Promise<any> => new Promise((res) => {
  let s: any; let done = false;
  const f = (v: any) => { if (done) return; done = true; res(v); queueMicrotask(() => { try { s?.unsubscribe?.(); } catch {} }); };
  s = w.state().subscribe(f); setTimeout(() => f(null), 15000);
});
const isNight = (t: unknown) => { const s = String(t ?? ''); return s === '' || s === NIGHT || /^0+$/.test(s); };


/** Walk the cause chain; "Failed to prove transaction" is a wrapper that hides
 *  the server's real response (Effect stores its Cause under a symbol). */
function deepErr(e: any): string {
  const parts: string[] = []; const seen = new Set<any>();
  const eff = (o: any) => { for (const sy of Object.getOwnPropertySymbols(o ?? {})) if (String(sy).includes('Cause')) return (o as any)[sy]; };
  const walk = (c: any, d: number, path: string) => {
    if (!c || d > 8 || seen.has(c)) return; seen.add(c);
    if (typeof c === 'string') { parts.push(`${path}"${c.slice(0, 300)}"`); return; }
    const bits: string[] = [];
    if (c.message) bits.push(String(c.message).slice(0, 300));
    if (c._tag) bits.push(`_tag=${c._tag}`);
    if (c.status) bits.push(`status=${c.status}`);
    if (c.statusCode) bits.push(`statusCode=${c.statusCode}`);
    if (c.response?.status) bits.push(`http=${c.response.status}`);
    if (typeof c.error === 'string') bits.push(`error=${c.error.slice(0, 300)}`);
    if (c.body) bits.push(`body=${String(c.body).slice(0, 300)}`);
    if (bits.length) parts.push(`${path} ${bits.join('  ')}`);
    for (const [k, v] of [['cause', c.cause], ['error', c.error], ['effect', eff(c)]] as const)
      if (v && typeof v === 'object') walk(v, d + 1, `${path}.${k}`);
  };
  walk(e, 0, '[e]');
  return parts.join(' | ') || String(e);
}

async function main() {
  const label = args.only ?? 'w001';
  const levels = (args.concurrency ?? '1,2,4,8,12').split(',').map(Number).filter((n) => n > 0);
  const wallets: { label: string; seed: string }[] =
    JSON.parse(readFileSync(args.wallets ?? 'fleet.json', 'utf8'));
  const spec = wallets.find((w) => w.label === label);
  if (!spec) throw new Error(`no wallet '${label}'`);

  console.log(`proof server: ${PROOF_SERVER_URL}`);
  console.log(`network=${NETWORK_ID} wallet=${label} levels=${levels.join(',')}\n`);
  const b = await buildWallet(spec.seed);
  await waitForRealSync(b.wallet, { label, requireDustCoins: true });
  const st = await snap(b.wallet);
  const coins = (st?.unshielded?.availableCoins ?? []).filter((c: any) => isNight(c?.utxo?.type));
  console.log(`wallet ready: ${coins.length} native coins, ${(st?.dust?.availableCoins ?? []).length} dust coins\n`);

  console.log('  conc  built   wall_s    p50_s  proofs/s   speedup');
  let base = 0;
  for (const k of levels) {
    // Build K recipes first (cheap, ~0.2s each) so the timed section is pure proving.
    const recipes: any[] = [];
    for (let i = 0; i < k; i++) {
      const cur = await snap(b.wallet);
      const av = (cur?.unshielded?.availableCoins ?? []).filter((c: any) => isNight(c?.utxo?.type));
      if (!av.length) break;
      const coin = av.reduce((x: any, c: any) => (BigInt(c.utxo.value) < BigInt(x.utxo.value) ? c : x));
      try {
        const r = await b.wallet.transferTransaction(
          [{ type: 'unshielded', outputs: [{ type: NIGHT, receiverAddress: st.unshielded.address, amount: BigInt(coin.utxo.value) }] }] as any,
          { shieldedSecretKeys: b.zswapSecretKeys, dustSecretKey: b.dustSecretKey },
          { ttl: ttlOneHour(), payFees: true },
        );
        recipes.push(await b.wallet.signRecipe(r, (d: Uint8Array) => b.unshieldedKeystore.signData(d)));
      } catch { break; }
    }
    if (!recipes.length) {
      console.log(`${String(k).padStart(6)}  (could not build recipes -- out of coins or dust)`);
      continue;
    }

    const t0 = Date.now();
    // MUST distinguish success from failure. A swallowed error returns in
    // milliseconds and is indistinguishable from a fast proof -- which briefly
    // made a broken endpoint look like a 20x speedup. Count outcomes explicitly.
    const results = await Promise.all(recipes.map(async (r) => {
      const s = Date.now();
      try { await b.wallet.finalizeRecipe(r); return { ms: Date.now() - s, ok: true, err: '' }; }
      catch (e: any) { return { ms: Date.now() - s, ok: false, err: deepErr(e) }; }
    }));
    const times = results.map((r) => r.ms);
    const okN = results.filter((r) => r.ok).length;
    const firstErr = results.find((r) => !r.ok)?.err ?? '';
    if (okN === 0) {
      console.log(`${String(k).padStart(6)} ${String(recipes.length).padStart(6)}   ALL FAILED`);
      console.log(`        ${firstErr}`);
      for (const r of recipes) { try { await (b.wallet as any).revert?.(r); } catch {} }
      continue;
    }
    const wall = (Date.now() - t0) / 1000;
    const sorted = [...times].sort((a, c) => a - c);
    const p50 = sorted[Math.floor(sorted.length / 2)] / 1000;
    const rate = okN / wall;   // successful proofs only
    if (!base) base = rate;
    console.log(`${String(k).padStart(6)} ${String(recipes.length).padStart(6)} ` +
      `${wall.toFixed(1).padStart(8)} ${p50.toFixed(1).padStart(8)} ` +
      `${rate.toFixed(2).padStart(9)} ${(rate / base).toFixed(2).padStart(8)}x` +
      `  ok=${okN}/${recipes.length}${firstErr ? '  err=' + firstErr.slice(0, 70) : ''}`);
    appendFileSync('prove_bench.jsonl', JSON.stringify({
      concurrency: k, built: recipes.length, ok: okN, firstErr, wallS: wall, p50S: p50, proofsPerSec: rate,
      t: new Date().toISOString(),
    }) + '\n');
    // Release the claimed coins so the next level starts clean.
    for (const r of recipes) { try { await (b.wallet as any).revert?.(r); } catch { /* best effort */ } }
    await sleep(3000);
  }
  await b.wallet.stop?.();
}
main().then(() => process.exit(0)).catch((e) => { console.error(e?.message ?? e); process.exit(1); });
