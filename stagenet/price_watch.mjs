/**
 * price_watch.mjs -- sample overall_price and block occupancy every block.
 *
 * The exact FixedPoint rendering matters: "FixedPoint(10)" means EXACTLY the
 * genesis value, so any movement at all -- however small -- shows as a different
 * string. That makes this a sensitive test of whether the adjustment runs, not
 * just whether it runs fast.
 */
import { appendFileSync } from 'node:fs';
import { parseHexLedgerParameters } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
const INDEXER = process.env.MN_INDEXER_HTTP ?? 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
const LOG = process.argv[2] ?? 'price_watch.jsonl';
const MINUTES = Number(process.argv[3] ?? 20);

const q = async (query) => {
  const r = await fetch(INDEXER, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return j.data;
};
const priceOf = (hex) => {
  const s = parseHexLedgerParameters(hex).toString();
  const m = s.match(/overall_price:\s*FixedPoint\(([^)]+)\)/);
  return m ? m[1] : '?';
};

const end = Date.now() + MINUTES * 60_000;
let lastH = 0, first = null, seen = 0, nonEmpty = 0;
while (Date.now() < end) {
  try {
    const b = (await q('{ block { height timestamp ledgerParameters transactions { __typename } } }')).block;
    if (b && b.height !== lastH) {
      lastH = b.height;
      const p = priceOf(b.ledgerParameters);
      const n = (b.transactions ?? []).length;
      seen++; if (n) nonEmpty++;
      if (first === null) first = p;
      const rec = { t: new Date().toISOString(), height: b.height, txs: n, overall_price: p,
                    changed: p !== first };
      appendFileSync(LOG, JSON.stringify(rec) + '\n');
      if (p !== first) console.log(`*** PRICE MOVED at ${b.height}: ${first} -> ${p}`);
      else if (seen % 10 === 0) console.log(`  h=${b.height} txs=${n} price=${p} (unchanged, ${nonEmpty}/${seen} non-empty)`);
    }
  } catch { /* transient */ }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(`\nDONE: ${seen} blocks, ${nonEmpty} non-empty, price ${first} -> ${priceOf((await q('{ block { ledgerParameters } }')).block.ledgerParameters)}`);
