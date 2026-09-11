/**
 * harvest.mjs -- collect fee-price observations from stagenet's own traffic.
 *
 * The price stored with block N reflects block N's fullness (verified: the block
 * carrying our 569,482 B transfer itself read 10.0279, and the next, empty, read
 * 10). So the per-block multiplier is price_N / price_{N-1}, and inverting the
 * spec's curve gives the fullness the NODE reported:
 *
 *     mult = 1 + price_adjustment(fullness, a);  a = 100
 *     fullness = logistic(100 * (mult - 1))
 *
 * Using the ratio rather than assuming a baseline of 10 keeps it correct when
 * high-fullness blocks are consecutive and the price is compounding.
 *
 * Fees are collected too: fee = overall_price * bracket, so bracket = fee/price
 * gives each transaction's normalized cost without downloading `raw`.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { parseHexLedgerParameters } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

const INDEXER = 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
const LOOKBACK = Number(process.argv[2] ?? 6000);
const BATCH = Number(process.argv[3] ?? 6);
const OUT = process.argv[4] ?? 'harvest.jsonl';

const q = async (query) => {
  const r = await fetch(INDEXER, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 160));
  return j.data;
};
const priceOf = (hex) => {
  const m = parseHexLedgerParameters(hex).toString().match(/overall_price:\s*FixedPoint\(([^)]+)\)/);
  return m ? Number(m[1]) : NaN;
};

const tip = (await q('{ block { height } }')).block.height;
const from = tip - LOOKBACK;
console.log(`harvesting stagenet blocks ${from}..${tip} (${LOOKBACK} blocks)`);
writeFileSync(OUT, '');

const blocks = new Map();
let done = 0;
for (let start = from; start <= tip; start += BATCH) {
  const parts = [];
  for (let i = 0; i < BATCH && start + i <= tip; i++) {
    parts.push(`b${i}: block(offset:{height:${start + i}}) { height ledgerParameters
      transactions { __typename ... on RegularTransaction { hash fee } } }`);
  }
  let data;
  try { data = await q(`{ ${parts.join(' ')} }`); } catch { continue; }
  for (const b of Object.values(data).filter(Boolean)) {
    const txs = (b.transactions ?? []);
    blocks.set(b.height, {
      height: b.height, price: priceOf(b.ledgerParameters), txs: txs.length,
      fees: txs.filter((t) => t.fee != null).map((t) => ({ hash: t.hash, fee: String(t.fee) })),
    });
  }
  done += BATCH;
  if (done % 600 === 0) console.log(`  ...${done}/${LOOKBACK}`);
}

const heights = [...blocks.keys()].sort((a, b) => a - b);
const logistic = (x) => 1 / (1 + Math.exp(-x));
let moved = 0;
for (const h of heights) {
  const cur = blocks.get(h), prev = blocks.get(h - 1);
  if (!cur || !prev || !isFinite(cur.price) || !isFinite(prev.price)) continue;
  const mult = cur.price / prev.price;
  const rec = { height: h, txs: cur.txs, price: cur.price, prevPrice: prev.price, mult,
                impliedFullness: mult > 1 ? logistic(100 * (mult - 1)) : null,
                fees: cur.fees };
  appendFileSync(OUT, JSON.stringify(rec) + '\n');
  if (mult > 1.0000001) moved++;
}
console.log(`\nwrote ${OUT}: ${heights.length} blocks, ${moved} with an upward price move`);
