/**
 * decompose.mjs -- for a given block, download each transaction's `raw`, rebuild
 * it locally, and compute its five cost dimensions against the chain's live
 * parameters. Answers which dimension actually binds, which the indexer cannot.
 *
 * Motivation: a third-party ContractDeploy of only 28,282 bytes -- 2.83% of
 * block_usage -- produced a node-reported fullness of 58.49%. So `bytes /
 * block_usage` is not the fullness proxy for anything that is not
 * byte-dominated, and the binding dimension has to be measured, not assumed.
 *
 * Usage: node decompose.mjs <height> [<height> ...]
 */
import * as ledger from '@midnightntwrk/ledger-v9';
import { parseHexLedgerParameters } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

const INDEXER = 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
const q = async (query) => {
  const r = await fetch(INDEXER, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return j.data;
};

const params = parseHexLedgerParameters(
  (await q('{ block { ledgerParameters } }')).block.ledgerParameters);
// Block limits, read off the live parameters rather than assumed.
const lim = {};
for (const m of params.toString()
  .match(/block_limits: SyntheticCost \{[^}]*\}/s)[0]
  .matchAll(/([a-z_]+):\s*([0-9.]+)(s|ms|µs|ns|ps)?/g)) {
  const [, k, v, u] = m;
  const scale = { s: 1e12, ms: 1e9, 'µs': 1e6, ns: 1e3, ps: 1 }[u] ?? 1;
  lim[k] = Number(v) * scale;
}
console.log('live block limits:', JSON.stringify(lim));

for (const h of process.argv.slice(2)) {
  const b = (await q(`{ block(offset:{height:${h}}) { height transactions {
      __typename ... on RegularTransaction { hash fee raw contractActions { __typename } } } } }`)).block;
  if (!b) { console.log(`\nblock ${h}: not found`); continue; }
  console.log(`\n=== block ${b.height} ===`);
  for (const t of b.transactions ?? []) {
    if (!t.raw) { console.log(`  ${t.__typename}: no raw`); continue; }
    const bytes = t.raw.length / 2;
    const kind = (t.contractActions ?? []).map((a) => a.__typename).join(',') || 'transfer';
    let dims = null;
    for (const [S, P, B] of [
      // Marker discriminants, from the ledger-v9 typings: SignatureEnabled.instance
      // is 'signature', not 'signatureEnabled'. An on-chain transaction is
      // Transaction<SignatureEnabled, Proof, Binding>.
      ['signature', 'proof', 'binding'],
    ]) {
      try {
        const raw = Uint8Array.from(t.raw.match(/.{2}/g).map((x) => parseInt(x, 16)));
        const tx = ledger.Transaction.deserialize(S, P, B, raw);
        const c = tx.cost(params, false);
        dims = { read_time: Number(c.readTime), compute_time: Number(c.computeTime),
                 block_usage: Number(c.blockUsage), bytes_written: Number(c.bytesWritten),
                 bytes_churned: Number(c.bytesChurned) };
      } catch (e) { dims = { error: String(e?.message ?? e).slice(0, 90) }; }
    }
    console.log(`  ${kind}  ${bytes.toLocaleString()} B  fee ${(Number(t.fee)/1e15).toFixed(6)} DUST`);
    if (dims?.error) { console.log(`    cost: ${dims.error}`); continue; }
    const norm = Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, v / (lim[k] ?? 1)]));
    const bind = Object.entries(norm).sort((a, b) => b[1] - a[1])[0];
    for (const [k, v] of Object.entries(norm)) {
      console.log(`    ${k.padEnd(14)} ${(v * 100).toFixed(3).padStart(8)}%${k === bind[0] ? '  <== binds' : ''}`);
    }
  }
}
