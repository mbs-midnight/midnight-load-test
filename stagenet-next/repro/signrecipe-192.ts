// Two defects in one run.
//  (a) signRecipe is required for unshielded transfers: finalizeRecipe proves
//      but never signs, and submitting yields `Custom error: 192`
//      (InputsSignaturesLengthMismatch). Registrations sign internally, so
//      calling signRecipe there double-signs and yields the SAME 192.
//  (b) SDK errors are catch-alls: e.message is generic and the ledger code sits
//      behind an Effect symbol, so ordinary unwrapping never sees it.
// Proves one tiny self-transfer without signing; the node rejects it, no funds
// move. Needs a funded stagenet wallet and a local proof server.
import { buildWallet, waitForRealSync, firstState, NIGHT, describeError, transferTx, swapTx, SDK_LINE } from '../src/wallet.js';
import { result, ledgerCode } from './_common.js';

console.log(`stack under test: ${SDK_LINE}`);
const seed = process.env.MN_STAGENET_SEED;
if (!seed) { result('signrecipe-192', 'SKIPPED', 'MN_STAGENET_SEED not set'); }
else {
  const b = await buildWallet(seed);
  await waitForRealSync(b.wallet, { label: 'sign192' });
  const st = await firstState(b.wallet);
  const recipe = await transferTx(b,
    [{ type: 'unshielded', outputs: [{ type: NIGHT, receiverAddress: st.unshielded.address, amount: 1000n }] }] as any,
    { ttl: new Date(Date.now() + 3_600_000), payFees: true },
  );
  const finalized = await b.wallet.finalizeRecipe(recipe as any);          // deliberately NO signRecipe
  let outcome = '';
  try {
    const id = await b.wallet.submitTransaction(finalized);
    outcome = `ACCEPTED ${String(id)}`;
  } catch (e: any) {
    const code = ledgerCode(e);
    const ownKeys = Object.keys(e ?? {}), symKeys = Object.getOwnPropertySymbols(e ?? {}).map(String);
    const shallow = `${e?.message ?? e}${e?.cause ? ' | cause: ' + String(e.cause?.message ?? e.cause).slice(0, 60) : ''}`;
    console.log(`  e.message + .cause (what a normal handler sees): ${shallow.slice(0, 160)}`);
    console.log(`  own keys: [${ownKeys.join(', ')}]  symbol keys: [${symKeys.join(', ')}]`);
    console.log(`  full unwrap through symbols: ${describeError(e).slice(0, 220)}`);
    outcome = `code=${code} shallowHasCode=${/Custom error: \d+/.test(shallow)}`;
    b.wallet.stop().catch(() => {});
    if (code === 192) {
      const hidden = !/Custom error: \d+/.test(shallow);
      result('signrecipe-192', 'REPRODUCED', `unsigned transfer rejected with Custom error: 192; ledger code ${hidden ? 'NOT visible on e.message/.cause, only via symbol-keyed cause chain' : 'visible on e.message'}`);
    } else result('signrecipe-192', 'NOT REPRODUCED', `rejected with code=${code}: ${describeError(e).slice(0, 120)}`);
  }
  if (outcome.startsWith('ACCEPTED')) { b.wallet.stop().catch(() => {}); result('signrecipe-192', 'NOT REPRODUCED', `unsigned transfer was accepted: ${outcome}`); }
}
