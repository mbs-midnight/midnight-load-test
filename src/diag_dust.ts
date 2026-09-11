/**
 * diag_dust.ts -- watch the DUST sub-wallet's sync progress and coin set over
 * time, for ONE wallet, with no timeout gate.
 *
 * wallet_status.ts reads dust balance from whatever state exists when its
 * 180s waitForSyncedState() race expires. If the dust sub-wallet is still
 * catching up at that moment it reports DUST=0 -- indistinguishable from a
 * wallet that genuinely has none. This separates the two: it prints all three
 * sub-wallets' progress every 5s until dust either produces coins or stops
 * advancing, so "unsynced" and "actually zero" look different.
 */
import { readFileSync } from 'node:fs';
import { buildWallet, NETWORK_ID } from './providers.js';

const SPECKS_PER_DUST = 1_000_000_000_000_000n;
const args: Record<string,string> = {};
{
  const a = process.argv.slice(2);
  for (let i=0;i<a.length;i++) if (a[i].startsWith('--')) args[a[i].slice(2)] = a[++i];
}
const watchS = Number(args['watch-s'] ?? 420);

function fmt(raw: bigint, per: bigint, dp: number) {
  const w = raw / per, f = raw % per;
  return `${w}.${f.toString().padStart(per.toString().length-1,'0').slice(0,dp)}`;
}
function prog(p: any) {
  if (!p) return 'n/a';
  const a = BigInt(p.appliedIndex ?? 0), r = BigInt(p.highestRelevantWalletIndex ?? 0),
        h = BigInt(p.highestIndex ?? 0);
  return `applied=${a} relevant=${r} chainHigh=${h} conn=${p.isConnected}`;
}

async function main() {
  const label = args.only ?? 'w001';
  const wallets: {label:string;seed:string}[] = JSON.parse(readFileSync(args.wallets ?? 'fleet.json','utf8'));
  const w = wallets.find((x) => x.label === label);
  if (!w) throw new Error(`no wallet '${label}' in ${args.wallets ?? 'fleet.json'}`);

  console.log(`network=${NETWORK_ID} wallet=${label} watching ${watchS}s\n`);
  const b = await buildWallet(w.seed);

  let latest: any;
  b.wallet.state().subscribe((st: any) => { latest = st; });

  const t0 = Date.now();
  const iv = setInterval(() => {
    const st = latest;
    if (!st) { console.log('  (no state yet)'); return; }
    const el = ((Date.now()-t0)/1000).toFixed(0).padStart(4);
    const d = st.dust ?? {};
    let bal = 0n;
    try { bal = d.balance ? d.balance(new Date()) : 0n; } catch { /* pre-sync */ }
    const avail = d.availableCoins ?? [], pend = d.pendingCoins ?? [], tot = d.totalCoins ?? [];
    let gen = 0n;
    for (const c of avail) gen += BigInt(c?.generatedNow ?? 0);
    console.log(`[${el}s] DUST  ${prog(d.progress)}`);
    console.log(`        balance=${fmt(bal,SPECKS_PER_DUST,6)} coins avail=${avail.length} pend=${pend.length} tot=${tot.length} generatedNow=${fmt(gen,SPECKS_PER_DUST,6)}`);
    for (const c of avail) {
      console.log(`          coin generatedNow=${fmt(BigInt(c?.generatedNow??0),SPECKS_PER_DUST,6)} maxCap=${fmt(BigInt(c?.maxCap??0),SPECKS_PER_DUST,6)} rate=${c?.rate ?? '?'} backing=${c?.backingNight ?? c?.token?.backingNight ?? '?'}`);
    }
    console.log(`        UNSH  ${prog(st.unshielded?.progress)}  utxos=${(st.unshielded?.availableCoins ?? []).length}`);
    console.log(`        SHLD  ${prog(st.shielded?.progress)}`);
  }, 5000);

  await new Promise((r) => setTimeout(r, watchS * 1000));
  clearInterval(iv);
  try { await b.wallet.stop?.(); } catch { /* ignore */ }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
