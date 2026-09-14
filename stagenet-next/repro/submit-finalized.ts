// Defect: WalletFacade.submitTransaction always waits for FINALITY. The node
// client accepts 'Submitted' | 'InBlock' | 'Finalized' but the facade passes
// 'Finalized' with no parameter, so every submit costs ~3 blocks of wall clock.
// Two parts: the literal in the shipped facade source, and one timed submit of a
// tiny signed self-transfer (spends one transfer fee). Needs a funded stagenet
// wallet and a local proof server.
import { readFileSync } from 'node:fs';
import { buildWallet, waitForRealSync, firstState, NIGHT, transferTx, swapTx, SDK_LINE } from '../src/wallet.js';
import { result } from './_common.js';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The packages' exports maps hide package.json and dist/, so resolve the main
// entry (dist/index.js) and walk from there.
const entry = (name: string) => fileURLToPath(import.meta.resolve(name));
const facadeSrc = readFileSync(entry('@midnight-ntwrk/wallet-sdk-facade'), 'utf8');
const hard = facadeSrc.match(/submitTransaction\([^)]*,\s*'Finalized'\)/)?.[0];
const nodeSrc = readFileSync(join(dirname(entry('@midnight-ntwrk/wallet-sdk-node-client')), 'effect/NodeClient.js'), 'utf8');
const accepts = /waitFor/.test(nodeSrc);
console.log(`facade source: ${hard ?? 'no hardcoded Finalized found'}`);
console.log(`node client sendMidnightTransactionAndWait(…, waitFor) parameterized: ${accepts}`);

console.log(`stack under test: ${SDK_LINE}`);
const seed = process.env.MN_STAGENET_SEED;
if (!seed) { result('submit-finalized', hard ? 'REPRODUCED' : 'NOT REPRODUCED', `${hard ? 'literal present in facade' : 'literal absent'}; timing skipped (MN_STAGENET_SEED not set)`); }
else {
  const b = await buildWallet(seed);
  await waitForRealSync(b.wallet, { label: 'submit' });
  const st = await firstState(b.wallet);
  const recipe = await transferTx(b,
    [{ type: 'unshielded', outputs: [{ type: NIGHT, receiverAddress: st.unshielded.address, amount: 1000n }] }] as any,
    { ttl: new Date(Date.now() + 3_600_000), payFees: true },
  );
  const signed = await b.wallet.signRecipe(recipe as any, (d: Uint8Array) => b.unshieldedKeystore.signDataAsync(d));
  const finalized = await b.wallet.finalizeRecipe(signed);
  const t0 = Date.now();
  const id = await b.wallet.submitTransaction(finalized);
  const s = (Date.now() - t0) / 1000;
  console.log(`submitTransaction returned after ${s.toFixed(1)}s (block time 6 s) — tx ${String(id).slice(0, 14)}…`);
  b.wallet.stop().catch(() => {});
  if (hard && s > 12) result('submit-finalized', 'REPRODUCED', `facade passes 'Finalized' unconditionally; submit blocked ${s.toFixed(1)}s, ~${(s / 6).toFixed(1)} blocks, with no way to ask for InBlock`);
  else if (hard) result('submit-finalized', 'REPRODUCED', `facade passes 'Finalized' unconditionally (this submit took ${s.toFixed(1)}s)`);
  else result('submit-finalized', 'NOT REPRODUCED', `no hardcoded literal; submit took ${s.toFixed(1)}s`);
}
