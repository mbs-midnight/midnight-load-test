/**
 * shielded_check.ts -- report each wallet's SHIELDED balance and coins.
 *
 * Shielded funds are invisible to the indexer by address -- that is the point of
 * shielded. The only way to confirm receipt is to build the wallet and let its
 * own shielded sub-wallet decrypt what belongs to it. So this pays a real sync,
 * unlike fleet_audit.ts which only reads the unshielded side.
 *
 *   npx tsx src/shielded_check.ts --wallets fleet.json --only w001,w002 [--watch-s 420]
 */
import { readFileSync } from 'node:fs';
import { buildWallet, NETWORK_ID } from './providers.js';

const args: Record<string, string> = {};
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) args[a[i].slice(2)] = a[++i];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const prog = (p: any) => p
  ? `applied=${p.appliedIndex ?? 0} relevant=${p.highestRelevantWalletIndex ?? 0} conn=${p.isConnected}`
  : 'n/a';

async function main() {
  const wallets: { label: string; seed: string }[] =
    JSON.parse(readFileSync(args.wallets ?? 'fleet.json', 'utf8'));
  const want = args.only ? new Set(args.only.split(',').map((s) => s.trim())) : null;
  const sel = wallets.filter((w) => !want || want.has(w.label));
  const watchS = Number(args['watch-s'] ?? 420);
  console.log(`network=${NETWORK_ID}  checking shielded balances for ${sel.map((w) => w.label).join(', ')}\n`);

  for (const spec of sel) {
    let b: any;
    try { b = await buildWallet(spec.seed); }
    catch (e: any) { console.log(`  [${spec.label}] build failed: ${e?.message?.slice(0, 120)}`); continue; }

    let latest: any;
    const sub = b.wallet.state().subscribe((st: any) => { latest = st; });
    const t0 = Date.now();
    let done = false;
    // Settle when the shielded sub-wallet is connected and caught up. An empty
    // read only becomes a verdict after the full window -- a shielded wallet
    // that is still scanning looks identical to one with no funds.
    while (Date.now() - t0 < watchS * 1000) {
      const sh = latest?.shielded;
      const p = sh?.progress;
      if (p) {
        const applied = BigInt(p.appliedIndex ?? 0);
        const relevant = BigInt(p.highestRelevantWalletIndex ?? 0);
        const lag = relevant > applied ? relevant - applied : 0n;
        const coins = (sh?.availableCoins ?? []).length;
        if (Boolean(p.isConnected) && applied > 0n && lag === 0n) { done = true; break; }
        if ((Date.now() - t0) % 30000 < 1100) {
          process.stdout.write(`\r  [${spec.label}] shielded ${prog(p)} coins=${coins}   `);
        }
      }
      await sleep(1000);
    }
    const st = latest;
    const sh = st?.shielded ?? {};
    const coins: any[] = sh.availableCoins ?? [];
    const balances = sh.balances ?? {};
    console.log(`\n=== ${spec.label} ${done ? '' : '(NOT fully synced -- treat empty as UNKNOWN)'}`);
    console.log(`  shielded progress: ${prog(sh.progress)}`);
    console.log(`  shielded coins   : ${coins.length}`);
    const entries = Object.entries(balances);
    if (!entries.length) console.log('  shielded balances: (none)');
    for (const [tok, val] of entries) console.log(`  balance: ${val}  token ${String(tok).slice(0, 28)}...`);
    for (const c of coins.slice(0, 8)) {
      console.log(`    coin value=${c?.value ?? c?.coin?.value ?? '?'} type=${String(c?.type ?? c?.coin?.type ?? '?').slice(0, 24)}...`);
    }
    try { sub.unsubscribe?.(); } catch { /* ignore */ }
    try { await b.wallet.stop?.(); } catch { /* ignore */ }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
