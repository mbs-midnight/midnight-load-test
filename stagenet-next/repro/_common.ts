// Shared helpers for the wallet-side reproductions. Kept tiny on purpose: each
// script should read as a self-contained bug report.
import { parseHexLedgerParameters } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { INDEXER_HTTP } from '../src/wallet.js';

export const result = (name: string, verdict: 'REPRODUCED' | 'NOT REPRODUCED' | 'SKIPPED', evidence: string, code?: number) => {
  console.log(`RESULT ${name}: ${verdict} — ${evidence}`);
  const rc = code ?? (verdict === 'REPRODUCED' ? 0 : verdict === 'NOT REPRODUCED' ? 1 : 2);
  // stop() on the facade can hang; a bounded exit keeps the test from leaving a zombie.
  setTimeout(() => process.exit(rc), 1500).unref();
  return rc;
};

export async function gql(query: string, url = INDEXER_HTTP): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

export async function liveParams(): Promise<any> {
  const d = await gql('{ block { height ledgerParameters } }');
  return { height: d.block.height, params: parseHexLedgerParameters(d.block.ledgerParameters) };
}

/** Pull the ledger error code out of an SDK error, wherever it is buried. */
export function ledgerCode(e: any): number | null {
  const seen = new Set<any>();
  const walk = (x: any, depth = 0): string => {
    if (x == null || depth > 7 || seen.has(x)) return '';
    if (typeof x === 'object') seen.add(x);
    if (typeof x === 'string') return x;
    let s = x.message ? String(x.message) : '';
    for (const k of Object.getOwnPropertySymbols(x)) s += ' ' + walk((x as any)[k], depth + 1);
    for (const k of ['cause', 'error', 'defect', 'failure', 'left', 'value']) s += ' ' + walk(x[k], depth + 1);
    return s;
  };
  const m = walk(e).match(/Custom error: (\d+)/);
  return m ? Number(m[1]) : null;
}
