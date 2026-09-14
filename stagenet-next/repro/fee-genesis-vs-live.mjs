// Defect (the "model" half): LedgerParameters.initialParameters(), the genesis
// defaults compiled into the SDK, is not the cost model any network runs. The
// same transaction prices differently against genesis and against the chain's
// live parameters. Read-only: downloads one recent fee-paying transaction.
import * as ledger from '@midnightntwrk/ledger-v9';
import { parseHexLedgerParameters } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
const URL_ = process.env.MN_INDEXER_HTTP ?? 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
const q = async (query) => { const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) }); return (await r.json()).data; };
const hexb = (h) => Uint8Array.from(h.match(/.{2}/g).map((x) => parseInt(x, 16)));

const tip = (await q('{ block { height ledgerParameters } }')).block;
const live = parseHexLedgerParameters(tip.ledgerParameters);
const genesis = ledger.LedgerParameters.initialParameters();
const a = live.toString().split('\n'), g = genesis.toString().split('\n');
let diff = 0; for (let i = 0; i < Math.max(a.length, g.length); i++) if (a[i] !== g[i]) diff++;
console.log(`live parameters at block ${tip.height} differ from initialParameters() in ${diff} of ${a.length} lines`);

// Find a recent fee-paying transaction to price both ways.
let tx = null, height = null;
for (let h = tip.height; h > tip.height - 3000 && !tx; h -= 8) {
  const parts = Array.from({ length: 8 }, (_, i) => `b${i}: block(offset:{height:${h - i}}) { height transactions { __typename ... on RegularTransaction { hash fee raw } } }`);
  const d = await q(`{ ${parts.join(' ')} }`);
  for (const b of Object.values(d ?? {})) for (const t of b?.transactions ?? []) if (t?.raw && Number(t.fee) > 1) { tx = t; height = b.height; break; }
}
if (!tx) { console.log('RESULT fee-genesis-vs-live: SKIPPED — no fee-paying transaction in the last 3,000 blocks'); process.exit(2); }
const t = ledger.Transaction.deserialize('signature', 'proof', 'binding', hexb(tx.raw));
const feeLive = Number(t.fees(live, false)) / 1e15, feeGen = Number(t.fees(genesis, false)) / 1e15, charged = Number(tx.fee) / 1e15;
console.log(`tx ${tx.hash.slice(0, 12)}… at block ${height}, ${tx.raw.length / 2} B`);
console.log(`  fees(initialParameters()) = ${feeGen.toFixed(4)} DUST`);
console.log(`  fees(live params)         = ${feeLive.toFixed(4)} DUST`);
console.log(`  charged by the chain      = ${charged.toFixed(4)} DUST`);
const off = Math.abs(feeGen / charged - 1), ok = Math.abs(feeLive / charged - 1);
if (off > 0.05 && ok < 0.03) {
  console.log(`RESULT fee-genesis-vs-live: REPRODUCED — genesis model is ${(off * 100).toFixed(0)}% off the charged fee, live model within ${(ok * 100).toFixed(1)}%; ${diff} differing parameter lines`);
  process.exit(0);
}
console.log(`RESULT fee-genesis-vs-live: NOT REPRODUCED — genesis off by ${(off * 100).toFixed(1)}%, live off by ${(ok * 100).toFixed(1)}%`);
process.exit(1);
