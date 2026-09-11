/**
 * fleet_audit.ts -- fast "how many lanes are actually live" report.
 *
 * WHY NOT wallet_status.ts: that tool waits for the FULL facade sync, and the
 * DUST sub-wallet needs ~5-6 min per wallet on preview. Across 24 wallets that
 * is hours, and booting them all at once is the documented OOM.
 *
 * The insight that makes this fast: everything needed to size a load test lives
 * on the UNSHIELDED sub-wallet, which syncs in seconds --
 *   - native NIGHT balance (token type all-zeros)     -> can it transact at all
 *   - meta.registeredForDustGeneration per UTXO       -> will it have DUST
 * DUST balance itself is then IMPLIED: a NIGHT UTXO registered more than ~7 days
 * ago sits at max cap, and the cap is 5 DUST per NIGHT (measured on w001:
 * 5000 NIGHT -> 25000 DUST cap). So we report implied dust and never pay the
 * dust sync cost. Use `npm run diag:dust` on a specific wallet to confirm.
 *
 *   npx tsx src/fleet_audit.ts --wallets fleet.json [--batch 6] [--wait-s 60]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildWallet, NETWORK_ID } from './providers.js';

const STARS_PER_NIGHT = 1_000_000n;
const DUST_CAP_PER_NIGHT = 5n; // measured: 5000 NIGHT -> 25000 DUST max cap

const args: Record<string, string> = {};
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) args[a[i].slice(2)] = a[++i];
}
const isNight = (t: unknown) => { const s = String(t ?? ''); return s === '' || /^0+$/.test(s); };
const fmtNight = (raw: bigint) => (raw / STARS_PER_NIGHT).toString();

interface Row {
  label: string; nightStar: bigint; registeredStar: bigint;
  utxos: number; nightUtxos: number; registeredUtxos: number;
  otherTokens: number; impliedDust: bigint; connected: boolean; note: string;
}

async function auditOne(spec: { label: string; seed: string }, waitS: number): Promise<Row> {
  const row: Row = {
    label: spec.label, nightStar: 0n, registeredStar: 0n, utxos: 0, nightUtxos: 0,
    registeredUtxos: 0, otherTokens: 0, impliedDust: 0n, connected: false, note: '',
  };
  let b: any;
  try { b = await buildWallet(spec.seed); }
  catch (e: any) { row.note = `build failed: ${e?.message?.slice(0, 80)}`; return row; }

  try {
    let latest: any;
    const sub = b.wallet.state().subscribe((st: any) => { latest = st; });
    const t0 = Date.now();
    // Settle when the unshielded wallet is connected AND caught up AND has coins.
    // A genuinely EMPTY wallet is also connected+caught-up at 0/0 forever, which
    // is indistinguishable from mid-sync -- so an empty read only becomes a
    // verdict after the full grace period, never early.
    for (;;) {
      const st = latest;
      const pr = st?.unshielded?.progress;
      if (pr) {
        const applied = BigInt(pr.appliedIndex ?? 0);
        const relevant = BigInt(pr.highestRelevantWalletIndex ?? 0);
        const lag = relevant > applied ? relevant - applied : applied - relevant;
        row.connected = Boolean(pr.isConnected);
        const coins = st?.unshielded?.availableCoins ?? [];
        if (row.connected && lag === 0n && coins.length > 0) break;
      }
      if (Date.now() - t0 > waitS * 1000) { row.note = 'no NIGHT seen within grace period'; break; }
      await new Promise((r) => setTimeout(r, 1000));
    }

    const coins: any[] = latest?.unshielded?.availableCoins ?? [];
    row.utxos = coins.length;
    for (const c of coins) {
      const v = BigInt(c?.utxo?.value ?? 0);
      if (isNight(c?.utxo?.type)) {
        row.nightUtxos++;
        row.nightStar += v;
        if (c?.meta?.registeredForDustGeneration) { row.registeredUtxos++; row.registeredStar += v; }
      } else row.otherTokens++;
    }
    row.impliedDust = (row.registeredStar / STARS_PER_NIGHT) * DUST_CAP_PER_NIGHT;
    try { sub.unsubscribe?.(); } catch { /* ignore */ }
  } finally {
    // Stop immediately -- the dust sub-wallet is still grinding through history
    // in the background and is exactly the memory hog we are avoiding.
    try { await b.wallet.stop?.(); } catch { /* ignore */ }
  }
  return row;
}

async function main() {
  const wallets: { label: string; seed: string }[] =
    JSON.parse(readFileSync(args.wallets ?? 'fleet.json', 'utf8'));
  const batch = Number(args.batch ?? 6);
  // 90s default. 45s was too short once wallets held 25 coins instead of 1: three
// freshly-split wallets (w006-w008) reported "no NIGHT" while the indexer showed
// 27 UTXOs each. An empty read is only a verdict AFTER the grace period, so too
// short a grace produces confident-looking false negatives.
const waitS = Number(args['wait-s'] ?? 90);
  console.log(`network=${NETWORK_ID}  auditing ${wallets.length} wallets, batch=${batch}, grace=${waitS}s\n`);

  const rows: Row[] = [];
  for (let i = 0; i < wallets.length; i += batch) {
    const slice = wallets.slice(i, i + batch);
    process.stdout.write(`  batch ${i / batch + 1}: ${slice.map((w) => w.label).join(' ')} ... `);
    const t0 = Date.now();
    rows.push(...await Promise.all(slice.map((w) => auditOne(w, waitS))));
    console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  console.log(`\n${'label'.padEnd(7)}${'NIGHT'.padStart(10)}${'registered'.padStart(12)}` +
    `${'~DUST'.padStart(10)}${'utxos'.padStart(7)}${'other'.padStart(7)}  note`);
  for (const r of rows) {
    console.log(`${r.label.padEnd(7)}${fmtNight(r.nightStar).padStart(10)}` +
      `${fmtNight(r.registeredStar).padStart(12)}${r.impliedDust.toString().padStart(10)}` +
      `${String(r.nightUtxos).padStart(7)}${String(r.otherTokens).padStart(7)}  ${r.note}`);
  }

  const live = rows.filter((r) => r.registeredStar > 0n);
  const fundedUnreg = rows.filter((r) => r.nightStar > 0n && r.registeredStar === 0n);
  const empty = rows.filter((r) => r.nightStar === 0n);
  console.log(`\n===== fleet =====`);
  console.log(`  LIVE lanes (registered NIGHT -> DUST): ${live.length}/${rows.length}`);
  console.log(`    ${live.map((r) => r.label).join(', ') || '(none)'}`);
  console.log(`  funded but NOT registered:             ${fundedUnreg.length}` +
    (fundedUnreg.length ? `  -> npm run delegate -- --wallets <file> --only <label>` : ''));
  console.log(`    ${fundedUnreg.map((r) => r.label).join(', ') || '(none)'}`);
  console.log(`  no NIGHT at all:                       ${empty.length}`);
  console.log(`    ${empty.map((r) => r.label).join(', ') || '(none)'}`);
  const totalNight = rows.reduce((a, r) => a + r.nightStar, 0n);
  console.log(`\n  total native NIGHT across fleet: ${fmtNight(totalNight)} NIGHT`);
  console.log(`  implied total DUST at cap:       ${rows.reduce((a, r) => a + r.impliedDust, 0n)} DUST`);

  writeFileSync(args.out ?? 'fleet_audit.json', JSON.stringify(
    rows.map((r) => ({ ...r, nightStar: r.nightStar.toString(),
      registeredStar: r.registeredStar.toString(), impliedDust: r.impliedDust.toString() })), null, 2));
  console.log(`\nwrote ${args.out ?? 'fleet_audit.json'}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
