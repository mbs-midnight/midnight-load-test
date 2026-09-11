/**
 * find_block.mjs -- locate the block holding our high-fullness transaction and
 * read overall_price in it and the blocks after. The price in block N is derived
 * from block N-1's fullness, so a >50% block should be followed by a rise.
 */
import { parseHexLedgerParameters } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
const INDEXER='https://indexer.stagenet.shielded.tools/api/v4/graphql';
const q=async(query)=>{const r=await fetch(INDEXER,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query})});const j=await r.json();if(j.errors)throw new Error(JSON.stringify(j.errors).slice(0,200));return j.data;};
const price=(hex)=>{const s=parseHexLedgerParameters(hex).toString();return s.match(/overall_price:\s*FixedPoint\(([^)]+)\)/)[1];};
const tip=(await q('{ block { height } }')).block.height;
const B=6;
console.log(`${'height'.padStart(8)} ${'txs'.padStart(4)} ${'tx bytes'.padStart(10)} ${'overall_price'.padStart(22)}`);
for(let start=tip-42; start<=tip; start+=B){
  const parts=[];
  for(let i=0;i<B&&start+i<=tip;i++) parts.push(`b${i}: block(offset:{height:${start+i}}) { height ledgerParameters transactions { __typename ... on RegularTransaction { raw } } }`);
  let data; try{ data=await q(`{ ${parts.join(' ')} }`);}catch(e){ continue; }
  for(const b of Object.values(data).filter(Boolean)){
    const txs=b.transactions??[];
    const bytes=txs.reduce((a,t)=>a+((t.raw?.length??0)/2),0);
    const p=price(b.ledgerParameters);
    const flag = p!=='10' ? '   <== PRICE MOVED' : (bytes>500000 ? '   <== our big tx' : '');
    console.log(`${String(b.height).padStart(8)} ${String(txs.length).padStart(4)} ${bytes.toLocaleString().padStart(10)} ${p.padStart(22)}${flag}`);
  }
}
