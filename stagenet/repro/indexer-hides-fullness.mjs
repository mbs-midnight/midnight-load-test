// Defect: the indexer computes block fullness internally and discards it. Its
// GraphQL Block type exposes no fullness or limits, and `ledgerParameters` is an
// opaque hex string that only the ledger WASM can decode. Read-only.
import { parseHexLedgerParameters } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
const URL_ = process.env.MN_INDEXER_HTTP ?? 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
const q = async (query) => { const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) }); return (await r.json()).data; };

const fields = (await q('{ __type(name:"Block") { fields { name type { name kind ofType { name } } } } }')).__type.fields
  .map((f) => `${f.name}:${f.type.name ?? f.type.ofType?.name ?? f.type.kind}`);
console.log('Block fields:', fields.join(' '));
const fullnessLike = fields.filter((f) => /full|limit|usage|cost/i.test(f));
const b = (await q('{ block { height ledgerParameters } }')).block;
const p = parseHexLedgerParameters(b.ledgerParameters).toString();
const limits = p.match(/block_limits: SyntheticCost \{[^}]*\}/s)?.[0].replace(/\s+/g, ' ');
const price = p.match(/overall_price: FixedPoint\([^)]*\)/)?.[0];
console.log(`ledgerParameters is ${b.ledgerParameters.length / 2} bytes of hex; decoded with the ledger WASM: ${limits} ${price}`);
if (fullnessLike.length === 0 && fields.some((f) => f.startsWith('ledgerParameters:HexEncoded'))) {
  console.log(`RESULT indexer-hides-fullness: REPRODUCED — no fullness/limit field on Block at height ${b.height}; limits and overall_price only recoverable by decoding the hex blob client-side`);
  process.exit(0);
}
console.log(`RESULT indexer-hides-fullness: NOT REPRODUCED — fullness-like fields present: ${fullnessLike.join(', ')}`);
process.exit(1);
