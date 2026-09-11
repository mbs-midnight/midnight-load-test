// decompose_all.mjs -- cost every RegularTransaction in a stagenet block range
// (plus an explicit hash list) against the live parameters; emit JSONL.
// Usage: node decompose_all.mjs <from> <to> [hash ...] > shapes_stagenet.jsonl
import * as ledger from '@midnightntwrk/ledger-v9';
import { parseHexLedgerParameters } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
const INDEXER = 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
const q = async (query) => { for (let a=0;a<4;a++){ try{
  const r = await fetch(INDEXER,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query})});
  const j = await r.json(); if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0,200)); return j.data;
  }catch(e){ if(a==3) throw e; await new Promise(r=>setTimeout(r,1500*(a+1))); } } };
const params = parseHexLedgerParameters((await q('{ block { ledgerParameters } }')).block.ledgerParameters);
const lim = {};
for (const m of params.toString().match(/block_limits: SyntheticCost \{[^}]*\}/s)[0].matchAll(/([a-z_]+):\s*([0-9.]+)(s|ms|µs|μs|ns|ps)?/g)) {
  const [, k, v, u] = m; lim[k] = Number(v) * ({ s:1e12, ms:1e9, 'µs':1e6, 'μs':1e6, ns:1e3, ps:1 }[u] ?? 1);
}
console.error('limits', JSON.stringify(lim));
const costTx = (t, height) => {
  const bytes = t.raw.length / 2;
  const kind = (t.contractActions ?? []).map(a=>a.__typename).join(',') || 'transfer';
  try {
    const raw = Uint8Array.from(t.raw.match(/.{2}/g).map(x=>parseInt(x,16)));
    const tx = ledger.Transaction.deserialize('signature','proof','binding', raw);
    const c = tx.cost(params, false);
    const abs = { read_time:Number(c.readTime), compute_time:Number(c.computeTime), block_usage:Number(c.blockUsage), bytes_written:Number(c.bytesWritten), bytes_churned:Number(c.bytesChurned) };
    const pct = Object.fromEntries(Object.entries(abs).map(([k,v])=>[k, 100*v/lim[k]]));
    // shape detail: count offers/outputs where cheap to get
    let detail = {};
    try {
      const s = tx.toString(true);
      detail = { unshieldedInputs:(s.match(/UtxoSpend/g)||[]).length, unshieldedOutputs:(s.match(/UtxoOutput/g)||[]).length,
                 shieldedOutputs:(s.match(/"outputs"/g)||[]).length, deploys:(s.match(/ContractDeploy/g)||[]).length, calls:(s.match(/ContractCall/g)||[]).length };
    } catch {}
    return { height, hash:t.hash, kind, bytes, fee:t.fee, abs, pct, detail };
  } catch (e) { return { height, hash:t.hash, kind, bytes, fee:t.fee, error:String(e?.message??e).slice(0,120) }; }
};
const [from, to, ...hashes] = process.argv.slice(2);
const TXQ = `{ __typename ... on RegularTransaction { hash fee raw contractActions { __typename } } }`;
for (const h of hashes) {
  const d = await q(`{ transactions(offset:{identifier:"${h}"}) { __typename ... on RegularTransaction { hash fee raw block { height } contractActions { __typename } } } }`);
  for (const t of d.transactions ?? []) if (t.raw) console.log(JSON.stringify({ ours:true, ...costTx(t, t.block?.height) }));
}
if (from && to) {
  const B = 8; let n=0;
  for (let s = Number(from); s <= Number(to); s += B) {
    const parts=[]; for (let i=0;i<B && s+i<=Number(to);i++) parts.push(`b${i}: block(offset:{height:${s+i}}) { height transactions ${TXQ} }`);
    let data; try { data = await q(`{ ${parts.join(' ')} }`); } catch (e) { console.error('skip', s, e.message); continue; }
    for (const b of Object.values(data).filter(Boolean)) for (const t of b.transactions ?? []) if (t.raw) { console.log(JSON.stringify(costTx(t, b.height))); n++; }
    if ((s-Number(from)) % 800 === 0) console.error(`...${s} (${n} tx)`);
  }
}
