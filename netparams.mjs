// netparams.mjs -- decode live ledgerParameters on mainnet, preview, stagenet;
// compare block_limits, fee_prices, parallelism_factor, min_block_price, and
// count differing lines in the transaction cost model.
import * as l8 from '@midnight-ntwrk/ledger-v8';
const v9 = await import('/Users/maheshsashital/Midnight/load-test/stagenet/node_modules/@midnightntwrk/ledger-v9/dist/index.js').catch(()=>null);
const pdp = await import('/Users/maheshsashital/Midnight/load-test/stagenet/node_modules/@midnight-ntwrk/midnight-js-indexer-public-data-provider/dist/index.js');
const NETS = {
  mainnet: 'https://indexer.mainnet.midnight.network/api/v4/graphql',
  preview: 'https://indexer.preview.midnight.network/api/v4/graphql',
  stagenet:'https://indexer.stagenet.shielded.tools/api/v4/graphql',
};
const hexb = (h)=>Uint8Array.from(h.match(/.{2}/g).map(x=>parseInt(x,16)));
const out = {};
for (const [n,u] of Object.entries(NETS)) {
  const r = await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'{ block { height timestamp ledgerParameters } }'})});
  const b = (await r.json()).data.block;
  let s, dec;
  try { s = l8.LedgerParameters.deserialize(hexb(b.ledgerParameters)).toString(); dec='ledger-v8'; }
  catch (e) { s = pdp.parseHexLedgerParameters(b.ledgerParameters).toString(); dec='ledger-v9'; }
  out[n] = { height:b.height, dec, s };
  const grab = (re)=> (s.match(re)||[])[0];
  console.log(`\n##### ${n}  height=${b.height}  decoder=${dec}`);
  console.log(grab(/block_limits: SyntheticCost \{[^}]*\}/s));
  console.log(grab(/fee_prices: FeePrices \{[^}]*\}/s));
  console.log(s.split('\n').filter(x=>/parallelism_factor|min_block_price|time_to_dismiss|dust_grace|night_dust_ratio|generation_decay/.test(x)).map(x=>x.trim()).join('\n'));
}
const diff=(a,b)=>{const A=a.split('\n'),B=b.split('\n');let d=0;for(let i=0;i<Math.max(A.length,B.length);i++) if(A[i]!==B[i]) d++;return d;};
console.log('\ndiff lines mainnet vs preview :', diff(out.mainnet.s,out.preview.s));
console.log('diff lines mainnet vs stagenet:', diff(out.mainnet.s,out.stagenet.s));
console.log('total lines', out.mainnet.s.split('\n').length, out.stagenet.s.split('\n').length);
// show the differing lines between mainnet and preview if few
const A=out.mainnet.s.split('\n'),B=out.preview.s.split('\n');
for(let i=0;i<Math.max(A.length,B.length);i++) if(A[i]!==B[i]) console.log(`  L${i} mainnet: ${(A[i]||'').trim()} | preview: ${(B[i]||'').trim()}`);
