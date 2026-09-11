// decompose_v8.mjs -- cost every RegularTransaction in the last N blocks of a
// ledger-8 network (mainnet or preview) against that network's live parameters.
// Usage: node decompose_v8.mjs <mainnet|preview> <nblocks> > shapes_<net>.jsonl
import * as ledger from '@midnight-ntwrk/ledger-v8';
const NET = process.argv[2], N = Number(process.argv[3] ?? 3000);
const INDEXER = `https://indexer.${NET}.midnight.network/api/v4/graphql`;
const q = async (query) => { for (let a=0;a<4;a++){ try{
  const r = await fetch(INDEXER,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query})});
  const j = await r.json(); if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0,200)); return j.data;
  }catch(e){ if(a==3) throw e; await new Promise(r=>setTimeout(r,1500*(a+1))); } } };
const hexb = (h)=>Uint8Array.from(h.match(/.{2}/g).map(x=>parseInt(x,16)));
const tipB = (await q('{ block { height ledgerParameters } }')).block;
const params = ledger.LedgerParameters.deserialize(hexb(tipB.ledgerParameters));
const lim = {};
for (const m of params.toString().match(/block_limits: SyntheticCost \{[^}]*\}/s)[0].matchAll(/([a-z_]+):\s*([0-9.]+)(s|ms|µs|μs|ns|ps)?/g)) {
  const [, k, v, u] = m; lim[k] = Number(v) * ({ s:1e12, ms:1e9, 'µs':1e6, 'μs':1e6, ns:1e3, ps:1 }[u] ?? 1);
}
console.error(NET, 'tip', tipB.height, 'limits', JSON.stringify(lim));
const costTx = (t, height) => {
  const bytes = t.raw.length / 2;
  const kind = (t.contractActions ?? []).map(a=>a.__typename).join(',') || 'transfer';
  try {
    const tx = ledger.Transaction.deserialize('signature','proof','binding', hexb(t.raw));
    const c = tx.cost(params, false);
    const abs = { read_time:Number(c.readTime), compute_time:Number(c.computeTime), block_usage:Number(c.blockUsage), bytes_written:Number(c.bytesWritten), bytes_churned:Number(c.bytesChurned) };
    const pct = Object.fromEntries(Object.entries(abs).map(([k,v])=>[k, 100*v/lim[k]]));
    let detail = {};
    try { const s = tx.toString(true);
      detail = { unshieldedInputs:(s.match(/UtxoSpend/g)||[]).length, unshieldedOutputs:(s.match(/UtxoOutput/g)||[]).length, deploys:(s.match(/ContractDeploy/g)||[]).length, calls:(s.match(/ContractCall/g)||[]).length }; } catch {}
    return { net:NET, height, hash:t.hash, kind, bytes, fee:t.fee, abs, pct, detail };
  } catch (e) { return { net:NET, height, hash:t.hash, kind, bytes, fee:t.fee, error:String(e?.message??e).slice(0,120) }; }
};
const TXQ = `{ __typename ... on RegularTransaction { hash fee raw contractActions { __typename } } }`;
const B = 8; let n=0; const from = tipB.height - N, to = tipB.height;
for (let s = from; s <= to; s += B) {
  const parts=[]; for (let i=0;i<B && s+i<=to;i++) parts.push(`b${i}: block(offset:{height:${s+i}}) { height transactions ${TXQ} }`);
  let data; try { data = await q(`{ ${parts.join(' ')} }`); } catch (e) { console.error('skip', s, e.message); continue; }
  for (const b of Object.values(data).filter(Boolean)) for (const t of b.transactions ?? []) if (t.raw) { console.log(JSON.stringify(costTx(t, b.height))); n++; }
  if ((s-from) % 800 === 0) console.error(`...${s} (${n} tx)`);
}
console.error('done', n, 'tx');
