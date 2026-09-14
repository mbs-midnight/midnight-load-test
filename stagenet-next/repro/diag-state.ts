// Diagnostic: what does the beta.3 forking wallet actually see after sync?
import { buildWallet, waitForRealSync, firstState, SDK_LINE } from '../src/wallet.js';
console.log(`stack: ${SDK_LINE}`);
const b = await buildWallet(process.env.MN_STAGENET_SEED!);
try { await waitForRealSync(b.wallet, { label: 'diag', timeoutMs: 240_000 }); console.log('waitForRealSync: ok'); }
catch (e: any) { console.log('waitForRealSync: ' + e.message); }
const st: any = await firstState(b.wallet);
console.log('top-level keys:', Object.keys(st));
const J = (x: any, n = 400) => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v)?.slice(0, n);
for (const k of ['shielded', 'unshielded', 'dust']) {
  const w = st[k] ?? {};
  console.log(`${k}: keys=${Object.keys(w).join(',')} protocolVersion=${J(w.protocolVersion)}`);
  const inner = w.state ?? w;
  console.log(`   inner keys=${Object.keys(inner).join(',')}`);
  console.log(`   address=${J(inner.address, 120)} progress=${J(inner.progress, 200)} availableCoins=${(inner.availableCoins ?? []).length}`);
}
const pv = (b.wallet as any).protocolVersions?.() ?? (b.wallet as any).protocolVersions;
console.log('facade protocolVersions:', JSON.stringify(pv, (_, v) => typeof v === 'bigint' ? v.toString() : v));
b.wallet.stop().catch(() => {});
setTimeout(() => process.exit(0), 1500).unref();
