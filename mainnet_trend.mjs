/**
 * mainnet_trend.mjs -- sample overall_price across MAINNET's history (ledger 8.1.2).
 *
 * The question the MPS must answer rather than pose: is the floor-seeking we
 * measured on preview happening on mainnet right now?
 */
import * as ledger from '@midnight-ntwrk/ledger-v8';
const INDEXER = 'https://indexer.mainnet.midnight.network/api/v4/graphql';
const q = async (query) => {
  const r = await fetch(INDEXER, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return j.data;
};
const dec = (hex) => {
  const b = Uint8Array.from(hex.match(/.{2}/g).map((x) => parseInt(x, 16)));
  return ledger.LedgerParameters.deserialize(b).toString();
};
const price = (s) => { const m = s.match(/overall_price:\s*FixedPoint\(([-0-9.e]+)\)/); return m ? m[1] : '?'; };

const tip = (await q('{ block { height timestamp } }')).block;
console.log(`mainnet tip ${tip.height}  ${new Date(Number(tip.timestamp)).toISOString()}\n`);
console.log(`${'height'.padStart(9)}  ${'date'.padEnd(11)} ${'overall_price'.padStart(16)} ${'txs'.padStart(4)}`);
const fracs = [0, .0002, .0005, .001, .002, .005, .01, .05, .1, .2, .35, .5, .65, .8, .9, .97, 1];
for (const f of fracs) {
  const h = Math.max(1, Math.round(tip.height * f));
  try {
    const b = (await q(`{ block(offset:{height:${h}}) { height timestamp ledgerParameters transactions { __typename } } }`)).block;
    if (!b) { console.log(`${String(h).padStart(9)}  (no block)`); continue; }
    const d = new Date(Number(b.timestamp)).toISOString().slice(0, 10);
    console.log(`${String(b.height).padStart(9)}  ${d.padEnd(11)} ${price(dec(b.ledgerParameters)).padStart(16)} ${String((b.transactions ?? []).length).padStart(4)}`);
  } catch (e) { console.log(`${String(h).padStart(9)}  ERR ${String(e.message).slice(0, 60)}`); }
}
