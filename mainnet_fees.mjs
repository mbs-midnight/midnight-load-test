/**
 * mainnet_fees.mjs -- who is actually paying fees on MAINNET, and how much? (port of stagenet/tx_fees.mjs)
 *
 * overall_price has been pinned at the genesis value 10 for stagenet's whole
 * history, so fee VARIATION there can only come from transaction mix. If the
 * chain is near-empty, our own load-test transactions may dominate the mean the
 * explorer reports. Batches 50 blocks per request via GraphQL aliases.
 */
const INDEXER = 'https://indexer.mainnet.midnight.network/api/v4/graphql';
const q = async (query) => {
  const r = await fetch(INDEXER, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
};
const tip = (await q('{ block { height } }')).block.height;
const LOOKBACK = Number(process.argv[2] ?? 1200);
const BATCH = Number(process.argv[3] ?? 8);   // indexer rejects large alias batches: "Query is too complex."
let blocks = 0, nonEmpty = 0, txs = 0;
const fees = [];
for (let start = tip - LOOKBACK; start <= tip; start += BATCH) {
  const parts = [];
  for (let i = 0; i < BATCH && start + i <= tip; i++) {
    parts.push(`b${i}: block(offset:{height:${start + i}}) { height transactions { __typename ... on RegularTransaction { hash fee } } }`);
  }
  let data;
  try { data = await q(`{ ${parts.join(' ')} }`); } catch (e) { console.error('BATCH ERR', String(e.message).slice(0,200)); continue; }
  for (const k of Object.keys(data)) {
    const b = data[k];
    if (!b) continue;
    blocks++;
    const t = b.transactions ?? [];
    if (t.length) { nonEmpty++; txs += t.length; }
    for (const x of t) if (x.fee != null) fees.push({ h: b.height, hash: x.hash, fee: BigInt(x.fee) });
  }
}
const DUST = 1e15;
console.log(`tip ${tip}, sampled ${blocks} blocks (${tip - LOOKBACK}..${tip})`);
console.log(`non-empty blocks: ${nonEmpty} (${(100 * nonEmpty / (blocks || 1)).toFixed(2)}%)   transactions: ${txs}`);
if (fees.length) {
  const nums = fees.map((f) => Number(f.fee) / DUST).sort((a, b) => a - b);
  const sum = nums.reduce((a, b) => a + b, 0);
  const sp = fees.map((f) => f.fee).sort((a, b) => (a < b ? -1 : 1));
  console.log(`fees in SPECK: n=${sp.length}  min ${sp[0]}  median ${sp[Math.floor(sp.length/2)]}  max ${sp[sp.length-1]}`);
  const hist = new Map();
  for (const f of sp) hist.set(String(f), (hist.get(String(f)) ?? 0) + 1);
  console.log('distinct fee values observed:');
  for (const [v, n] of [...hist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v.padStart(24)} SPECK  x${n}`);
  }
  console.log(`\nmost recent 12 fee-paying transactions:`);
  for (const f of fees.slice(-12)) console.log(`  block ${f.h}  ${(Number(f.fee)/DUST).toFixed(6)} DUST  ${f.hash.slice(0,24)}`);
} else console.log('no fees observed in window');
