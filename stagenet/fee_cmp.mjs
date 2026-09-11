import { parseHexLedgerParameters } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import * as ledger from '@midnightntwrk/ledger-v9';
const INDEXER = process.env.MN_INDEXER_HTTP ?? 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
const r = await fetch(INDEXER, { method:'POST', headers:{'content-type':'application/json'},
  body: JSON.stringify({ query:'{ block { height ledgerParameters } }' }) });
const { data } = await r.json();
const chain = parseHexLedgerParameters(data.block.ledgerParameters).toString();
const genesis = ledger.LedgerParameters.initialParameters().toString();
// Pull the fee_prices / limits blocks out of the debug dump for both.
const section = (s, name) => {
  const i = s.indexOf(name);
  if (i < 0) return `(${name} not found)`;
  return s.slice(i, i + 700).split('\n').slice(0, 22).join('\n');
};
for (const name of ['fee_prices', 'FeePrices', 'price_adjustment', 'limits: TransactionLimits']) {
  const a = section(chain, name), b = section(genesis, name);
  if (a.startsWith('(')) continue;
  console.log(`######## ${name} — CHAIN`); console.log(a);
  console.log(`######## ${name} — GENESIS`); console.log(b);
}
