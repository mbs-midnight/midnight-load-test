/**
 * Decode the ledger parameters PREVIEW is running (ledger-8) and compare its
 * fee configuration to the genesis defaults. This is the control for the
 * Stagenet measurement: Stagenet prices a transaction at ~1.8 DUST while every
 * transaction we ever submitted on preview cost exactly 1 SPECK.
 */
import * as ledger from '@midnight-ntwrk/ledger-v8';
const r = await fetch('https://indexer.preview.midnight.network/api/v4/graphql', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: '{ block { height ledgerParameters } }' }),
});
const { data } = await r.json();
const hex = data.block.ledgerParameters;
const bytes = Uint8Array.from(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));
const chain = ledger.LedgerParameters.deserialize(bytes);
const genesis = ledger.LedgerParameters.initialParameters();
console.log('preview block height:', data.block.height);
const sect = (s, n) => { const i = s.indexOf(n); return i < 0 ? '(none)' : s.slice(i).split('\n').slice(0, 16).join('\n'); };
console.log('######## PREVIEW fee_prices'); console.log(sect(chain.toString(), 'fee_prices'));
console.log('######## ledger-8 GENESIS fee_prices'); console.log(sect(genesis.toString(), 'fee_prices'));
const a = chain.toString().split('\n'), b = genesis.toString().split('\n');
let d = 0; for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) d++;
console.log('TOTAL DIFFERING LINES vs genesis:', d);
