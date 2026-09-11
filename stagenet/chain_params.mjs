/**
 * chain_params.mjs -- diff the ledger parameters the CHAIN is running against
 * LedgerParameters.initialParameters(), the genesis defaults the SDK uses.
 *
 * Why this matters: the wallet computes fees and the time-to-dismiss check
 * against initialParameters() unless an app goes out of its way to fetch the
 * live ones. On Stagenet those two disagree in 143 lines of the transaction cost
 * model. The LIMITS agree (time_to_dismiss_per_byte 2us, min 15ms) and the DUST
 * parameters agree exactly -- it is specifically the per-operation cost model
 * that differs, which is what fee estimation and dismissal both key off.
 *
 * Usage: node chain_params.mjs [--full]
 */
import { parseHexLedgerParameters } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import * as ledger from '@midnightntwrk/ledger-v9';

const INDEXER = process.env.MN_INDEXER_HTTP
  ?? 'https://indexer.stagenet.shielded.tools/api/v4/graphql';

const r = await fetch(INDEXER, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: '{ block { height ledgerParameters } }' }),
});
const { data } = await r.json();
if (!data?.block?.ledgerParameters) throw new Error('indexer returned no ledgerParameters');

const chain = parseHexLedgerParameters(data.block.ledgerParameters);
const genesis = ledger.LedgerParameters.initialParameters();
const a = chain.toString().split('\n');
const b = genesis.toString().split('\n');

console.log(`block height: ${data.block.height}`);
console.log(`chain dust  : ${chain.dust.toString().replace(/\s+/g, ' ')}`);
console.log(`genesis dust: ${genesis.dust.toString().replace(/\s+/g, ' ')}`);

let diffs = 0;
const show = process.argv.includes('--full') ? Infinity : 12;
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] === b[i]) continue;
  if (++diffs <= show) {
    console.log(`L${i}\n  chain:   ${(a[i] ?? '').trim()}\n  genesis: ${(b[i] ?? '').trim()}`);
  }
}
console.log(`TOTAL DIFFERING LINES: ${diffs}${diffs > show ? ` (showing ${show}; --full for all)` : ''}`);
