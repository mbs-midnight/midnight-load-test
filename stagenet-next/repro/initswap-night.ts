// Defect: initSwap with NIGHT is rejected by the node every time: 231
// (FeeCalculation(OutsideTimeToDismiss): the guaranteed section costs more to
// validate than the per-byte allowance) on small transactions, 199
// (InvariantViolation::NightBalance) on larger ones. Builds, signs, PROVES and
// submits one small swap; the node rejects it, so no funds move. Needs a funded
// stagenet wallet and a local proof server.
import { buildWallet, waitForRealSync, firstState, NIGHT, describeError, transferTx, swapTx, SDK_LINE } from '../src/wallet.js';
import { result, ledgerCode } from './_common.js';

console.log(`stack under test: ${SDK_LINE}`);
const seed = process.env.MN_STAGENET_SEED;
if (!seed) { result('initswap-night', 'SKIPPED', 'MN_STAGENET_SEED not set'); }
else {
  const b = await buildWallet(seed);
  await waitForRealSync(b.wallet, { label: 'initswap' });
  const st = await firstState(b.wallet);
  const amount = BigInt(process.env.AMOUNT ?? 1_000_000);
  const t0 = Date.now();
  const recipe = await swapTx(b,
    { unshielded: { [NIGHT]: amount } } as any,
    [{ type: 'shielded', outputs: [{ type: NIGHT, receiverAddress: st.shielded.address, amount }] }] as any,
    { ttl: new Date(Date.now() + 3_600_000), payFees: true },
  );
  const signed = await b.wallet.signRecipe(recipe as any, (d: Uint8Array) => b.unshieldedKeystore.signDataAsync(d));
  const finalized = await b.wallet.finalizeRecipe(signed);
  console.log(`swap of ${amount} STAR built, signed and proven in ${((Date.now() - t0) / 1000).toFixed(1)}s (${finalized.serialize().length} B); submitting…`);
  try {
    const id = await b.wallet.submitTransaction(finalized);
    b.wallet.stop().catch(() => {});
    result('initswap-night', 'NOT REPRODUCED', `the node ACCEPTED the NIGHT swap: ${String(id)}`);
  } catch (e: any) {
    const code = ledgerCode(e);
    console.log(`  e.message         : ${String(e?.message ?? e).slice(0, 80)}`);
    console.log(`  unwrapped cause   : ${describeError(e).slice(0, 200)}`);
    b.wallet.stop().catch(() => {});
    if (code === 231) result('initswap-night', 'REPRODUCED', 'rejected with Custom error: 231 (OutsideTimeToDismiss) — guaranteed section too costly to dismiss');
    else if (code === 199) result('initswap-night', 'REPRODUCED', 'rejected with Custom error: 199 (InvariantViolation::NightBalance) — supply invariant has no shielded term');
    else result('initswap-night', 'NOT REPRODUCED', `rejected with a different error: code=${code} ${describeError(e).slice(0, 120)}`);
  }
}
