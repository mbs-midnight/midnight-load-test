/**
 * price_trend.mjs -- sample overall_price across stagenet's history.
 *
 * ledgerParameters is a PER-BLOCK field, so this is a direct time series of the
 * fee price. The question it answers: is stagenet's fee level the result of load
 * driving the price up, or simply the genesis value not yet decayed?
 * INITIAL_PARAMETERS sets overall_price = 10 exactly, so "exactly 10" means
 * untouched; anything above means load has moved it.
 */
import { parseHexLedgerParameters } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
const INDEXER = 'https://indexer.stagenet.shielded.tools/api/v4/graphql';

const q = async (query) => {
  const r = await fetch(INDEXER, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return j.data;
};

const tip = (await q('{ block { height timestamp } }')).block;
console.log(`tip height ${tip.height}  ${tip.timestamp}`);

const price = (s) => {
  const m = s.match(/overall_price:\s*FixedPoint\(([-0-9.e]+)\)/);
  return m ? Number(m[1]) : NaN;
};

const heights = [];
for (const frac of [0, .05, .1, .2, .3, .4, .5, .6, .7, .8, .9, .95, .98, .995, 1]) {
  heights.push(Math.max(1, Math.round(tip.height * frac)));
}
console.log(`\n${'height'.padStart(8)} ${'timestamp'.padEnd(26)} ${'overall_price'.padStart(22)} ${'txs'.padStart(4)}`);
for (const h of heights) {
  try {
    const b = (await q(`{ block(offset:{height:${h}}) { height timestamp ledgerParameters transactions { hash } } }`)).block;
    if (!b) { console.log(`${String(h).padStart(8)} (no block)`); continue; }
    const p = price(parseHexLedgerParameters(b.ledgerParameters).toString());
    console.log(`${String(b.height).padStart(8)} ${String(b.timestamp).padEnd(26)} ${p.toExponential(6).padStart(22)} ${String(b.transactions.length).padStart(4)}`);
  } catch (e) { console.log(`${String(h).padStart(8)} ERROR ${String(e.message).slice(0,80)}`); }
}
