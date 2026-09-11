/**
 * mainnet_shapes.mjs -- do DIFFERENTLY SHAPED mainnet transactions pay different fees?
 *
 * The stagenet explorer shows fees from 0.27 to 13.54 DUST -- a ~50x spread that
 * tracks transaction cost at a constant overall_price of 10. The question for
 * mainnet is whether the same variety of shapes produces any fee variation at
 * all, or whether the floor collapses them all onto the 1-SPECK minimum.
 */
const INDEXER = 'https://indexer.mainnet.midnight.network/api/v4/graphql';
const q = async (query) => {
  const r = await fetch(INDEXER, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return j.data;
};
const tip = (await q('{ block { height } }')).block.height;
const rows = [];
const BATCH = 6;
outer:
for (let start = tip - 3000; start <= tip; start += BATCH) {
  const parts = [];
  for (let i = 0; i < BATCH && start + i <= tip; i++) {
    parts.push(`b${i}: block(offset:{height:${start + i}}) { height transactions { __typename
      ... on RegularTransaction { fee raw contractActions { __typename } } } }`);
  }
  let data;
  try { data = await q(`{ ${parts.join(' ')} }`); } catch { continue; }
  for (const b of Object.values(data).filter(Boolean)) {
  for (const t of b?.transactions ?? []) {
    if (t.fee == null) continue;
    rows.push({ h: b.height, fee: t.fee, bytes: (t.raw?.length ?? 0) / 2,
                actions: (t.contractActions ?? []).map((a) => a.__typename).join(',') || '-' });
    if (rows.length >= 14) break outer;
  }
  }
}
console.log(`${'block'.padStart(9)} ${'bytes'.padStart(8)} ${'fee (SPECK)'.padStart(12)}  actions`);
for (const r of rows) {
  console.log(`${String(r.h).padStart(9)} ${String(r.bytes).padStart(8)} ${String(r.fee).padStart(12)}  ${r.actions}`);
}
const sizes = rows.map((r) => r.bytes);
const feesSet = new Set(rows.map((r) => String(r.fee)));
console.log(`\nn=${rows.length}  size range ${Math.min(...sizes)}..${Math.max(...sizes)} bytes` +
  ` (${(Math.max(...sizes) / Math.min(...sizes)).toFixed(1)}x spread)`);
console.log(`distinct fee values: ${[...feesSet].join(', ')}`);
