/**
 * params_diff.mjs -- structural diff of the ledger-parameters blob between the
 * mainnet/preview generation (tagged v5) and the stagenet generation (v8).
 */
import * as l8 from '@midnight-ntwrk/ledger-v8';
const q = async (url) => {
  const r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ query:'{ block { height ledgerParameters } }' }) });
  return (await r.json()).data.block;
};
const dec8 = (hex) =>
  l8.LedgerParameters.deserialize(Uint8Array.from(hex.match(/.{2}/g).map(x=>parseInt(x,16)))).toString();

const prev = await q('https://indexer.preview.midnight.network/api/v4/graphql');
const v9 = await import('/Users/maheshsashital/Midnight/load-test/stagenet/node_modules/@midnight-ntwrk/midnight-js-indexer-public-data-provider/dist/index.js');
const stag = await q('https://indexer.stagenet.shielded.tools/api/v4/graphql');
const sSt = v9.parseHexLedgerParameters(stag.ledgerParameters).toString();
const sPv = dec8(prev.ledgerParameters);

// Compare only the top-level scalar fields (skip the big cost_model block).
const fields = (s) => {
  const out = {};
  for (const m of s.matchAll(/^\s{4}([a-z_]+):\s*(.+?),?$/gm)) out[m[1]] = m[2].trim();
  return out;
};
const a = fields(sPv), b = fields(sSt);
const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
console.log(`${'field'.padEnd(42)} ${'preview (v5)'.padEnd(24)} stagenet (v8)`);
for (const k of keys) {
  const mark = a[k] === b[k] ? '  ' : (a[k] === undefined ? '+ ' : b[k] === undefined ? '- ' : '~ ');
  console.log(`${mark}${k.padEnd(40)} ${String(a[k] ?? '(absent)').padEnd(24)} ${b[k] ?? '(absent)'}`);
}
