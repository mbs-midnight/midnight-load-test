/**
 * shielded_probe.ts -- measure what a SHIELDED transfer actually costs.
 *
 * The one number that decides whether the shielded route works. On-chain
 * evidence says a shielded tx is ~5,122 bytes per zswap event, so ~97 outputs
 * would be half a block -- versus ~1.2 bytes per output for unshielded, where
 * output count is useless as a fullness dial. If shielded proving is cheap, a
 * couple of wallets hold 50% fullness. If a multi-output zswap proof takes
 * minutes, the arithmetic collapses.
 *
 * Deliberately ONE transaction per run. This is a shared testnet.
 *
 *   npx tsx src/shielded_probe.ts --only w001 --outputs 4 [--dump-only] [--sign]
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { ttlOneHour } from '@midnight-ntwrk/midnight-js-utils';
import { buildWallet, NETWORK_ID } from './providers.js';

const args: Record<string, string> = {};
const flags = new Set<string>();
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    if (a[i + 1] === undefined || a[i + 1].startsWith('--')) flags.add(k); else args[k] = a[++i];
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describeError(e: any): string {
  const parts: string[] = []; const seen = new Set<any>();
  const eff = (o: any) => { for (const s of Object.getOwnPropertySymbols(o ?? {})) if (String(s).includes('Cause')) return (o as any)[s]; };
  const walk = (c: any, d: number, p: string) => {
    if (!c || d > 8 || seen.has(c)) return; seen.add(c);
    if (typeof c === 'string') { parts.push(`${p} "${c.slice(0, 200)}"`); return; }
    const b: string[] = [];
    if (c.message) b.push(String(c.message).slice(0, 250));
    if (c._tag) b.push(`_tag=${c._tag}`);
    if (c.code) b.push(`code=${c.code}`);
    if (typeof c.error === 'string') b.push(`error=${c.error.slice(0, 200)}`);
    if (b.length) parts.push(`${p} ${b.join('  ')}`);
    for (const [k, v] of [['cause', c.cause], ['error', c.error], ['effect', eff(c)]] as const)
      if (v && typeof v === 'object') walk(v, d + 1, `${p}.${k}`);
  };
  walk(e, 0, '[e]'); return parts.join(' | ') || String(e);
}

async function main() {
  const label = args.only ?? 'w001';
  const outputs = Number(args.outputs ?? 4);
  const wallets: { label: string; seed: string }[] =
    JSON.parse(readFileSync(args.wallets ?? 'fleet.json', 'utf8'));
  const spec = wallets.find((w) => w.label === label);
  if (!spec) throw new Error(`no wallet '${label}'`);

  console.log(`network=${NETWORK_ID}  wallet=${label}  outputs=${outputs}` +
    (flags.has('dump-only') ? '  DUMP ONLY' : ''));
  const b = await buildWallet(spec.seed);

  let latest: any;
  b.wallet.state().subscribe((st: any) => { latest = st; });
  const t0 = Date.now();
  for (;;) {
    const sh = latest?.shielded, p = sh?.progress;
    if (p) {
      const a = BigInt(p.appliedIndex ?? 0), r = BigInt(p.highestRelevantWalletIndex ?? 0);
      const lag = r > a ? r - a : 0n;
      if (Boolean(p.isConnected) && a > 0n && lag === 0n && (sh.availableCoins ?? []).length > 0) break;
    }
    if (Date.now() - t0 > 900_000) throw new Error('shielded wallet did not sync with coins in 900s');
    await sleep(1000);
  }

  const sh = latest.shielded;
  const coins: any[] = sh.availableCoins ?? [];
  const balances: Record<string, bigint> = sh.balances ?? {};
  const addr = sh.address;
  console.log(`\nshielded state:`);
  console.log(`  coins   : ${coins.length}`);
  for (const [tok, val] of Object.entries(balances)) console.log(`  balance : ${val}  token=${tok}`);
  console.log(`  address : ${String((addr as any)?.constructor?.name ?? typeof addr)}`);
  console.log(`  dust    : ${(latest?.dust?.availableCoins ?? []).length} avail`);

  const entries = Object.entries(balances).filter(([, v]) => BigInt(v as any) > 0n);
  if (!entries.length) throw new Error('no shielded balance to spend');
  const [tokenType, rawBal] = entries[0];
  const total = BigInt(rawBal as any);
  const per = total / BigInt(outputs);
  if (per <= 0n) throw new Error(`balance ${total} cannot split into ${outputs} non-zero outputs`);
  console.log(`\nplan: self-transfer ${outputs} x ${per} (of ${total}) token=${tokenType.slice(0, 20)}...`);
  if (flags.has('dump-only')) { await b.wallet.stop?.(); return; }

  // --to <label>: send to ANOTHER wallet's shielded address instead of our own.
  //
  // Every failing probe so far was a SELF-transfer. Lace demonstrably sends
  // shielded tokens to other addresses successfully, so "shielded is broken" is
  // too broad a claim -- the distinguishing variable may be self vs. third-party
  // recipient, which changes how inputs and outputs relate in the zswap offer.
  let dest: any = addr;
  if (args.to) {
    const other = wallets.find((w) => w.label === args.to);
    if (!other) throw new Error(`--to '${args.to}' not in wallet file`);
    const ob = await buildWallet(other.seed);
    const t1 = Date.now();
    for (;;) {
      const st2 = await new Promise<any>((res) => {
        const sub = ob.wallet.state().subscribe((x: any) => { res(x); try { sub.unsubscribe?.(); } catch {} });
        setTimeout(() => res(null), 10000);
      });
      if (st2?.shielded?.address) { dest = st2.shielded.address; break; }
      if (Date.now() - t1 > 300_000) throw new Error(`could not read ${args.to} shielded address`);
      await sleep(2000);
    }
    console.log(`  destination: ${args.to}'s shielded address (NOT self)`);
    try { await ob.wallet.stop?.(); } catch { /* ignore */ }
  }

  const outs = Array.from({ length: outputs }, () => ({
    type: tokenType, receiverAddress: dest, amount: per,
  }));

  const tBuild = Date.now();
  const recipe = await b.wallet.transferTransaction(
    [{ type: 'shielded', outputs: outs } as any],
    { shieldedSecretKeys: b.zswapSecretKeys, dustSecretKey: b.dustSecretKey },
    { ttl: ttlOneHour(), payFees: true },
  );
  const buildMs = Date.now() - tBuild;

  // Shielded inputs are authorised by zk proofs, not signatures, so signRecipe
  // should be unnecessary here -- and registration taught us that signing where
  // nothing is expected yields error 192 just as a MISSING signature does.
  // Default off; --sign to test the other way.
  let toFinalize: any = recipe;
  let signMs = 0;
  if (flags.has('sign')) {
    const tS = Date.now();
    toFinalize = await b.wallet.signRecipe(recipe,
      (d: Uint8Array) => b.unshieldedKeystore.signData(d));
    signMs = Date.now() - tS;
  }

  console.log(`\nbuilt in ${buildMs}ms${flags.has('sign') ? `, signed in ${signMs}ms` : ''} -- PROVING (the number we came for)...`);
  const tProve = Date.now();
  const finalized = await b.wallet.finalizeRecipe(toFinalize);
  const proveMs = Date.now() - tProve;
  console.log(`PROVE: ${proveMs}ms (${(proveMs / 1000).toFixed(1)}s)`);

  const tSub = Date.now();
  let txId: string | undefined; let err: string | undefined;
  try { txId = await b.wallet.submitTransaction(finalized); }
  catch (e: any) { err = describeError(e); }
  const submitMs = Date.now() - tSub;

  console.log(`\n===== SHIELDED PROBE RESULT =====`);
  console.log(`  outputs   : ${outputs}`);
  console.log(`  build     : ${buildMs}ms`);
  if (flags.has('sign')) console.log(`  sign      : ${signMs}ms`);
  console.log(`  PROVE     : ${proveMs}ms`);
  console.log(`  submit    : ${submitMs}ms`);
  console.log(`  total     : ${buildMs + signMs + proveMs + submitMs}ms`);
  console.log(txId ? `  txId      : ${txId}` : `  FAILED    : ${err}`);
  appendFileSync('shielded_probe.jsonl', JSON.stringify({
    wallet: label, outputs, buildMs, signMs, proveMs, submitMs, txId, error: err,
    t: new Date().toISOString(),
  }) + '\n');
  await b.wallet.stop?.();
}
main().then(() => process.exit(0)).catch((e) => { console.error(describeError(e)); process.exit(1); });
