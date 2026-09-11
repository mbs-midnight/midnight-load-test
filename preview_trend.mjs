/**
 * preview_trend.mjs -- sample overall_price across PREVIEW's history (ledger-8).
 *
 * Control for the stagenet result, where overall_price is pinned at the genesis
 * value 10 at every height. If preview's price visibly DECAYS over its history,
 * the adjustment mechanism demonstrably runs on ledger-8 -- which would make
 * stagenet's static price an anomaly rather than a design choice.
 */
import * as ledger from '@midnight-ntwrk/ledger-v8';
const INDEXER = 'https://indexer.preview.midnight.network/api/v4/graphql';
const q = async (query) => {
  const r = await fetch(INDEXER, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return j.data;
};
const dec = (hex) => {
  const bytes = Uint8Array.from(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));
  const s = ledger.LedgerParameters.deserialize(bytes).toString();
  const m = s.match(/overall_price:\s*FixedPoint\(([-0-9.e]+)\)/);
  return m ? Number(m[1]) : NaN;
};
const tip = (await q('{ block { height } }')).block.height;
console.log(`preview tip height ${tip}\n`);
console.log(`${'height'.padStart(8)} ${'overall_price'.padStart(22)}`);
for (const frac of [0, .0005, .001, .002, .005, .01, .02, .05, .1, .25, .5, .75, 1]) {
  const h = Math.max(1, Math.round(tip * frac));
  try {
    const b = (await q(`{ block(offset:{height:${h}}) { height ledgerParameters } }`)).block;
    if (!b) { console.log(`${String(h).padStart(8)} (no block)`); continue; }
    console.log(`${String(b.height).padStart(8)} ${dec(b.ledgerParameters).toExponential(6).padStart(22)}`);
  } catch (e) { console.log(`${String(h).padStart(8)} ERR ${String(e.message).slice(0,70)}`); }
}
