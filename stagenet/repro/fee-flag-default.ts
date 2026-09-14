// Defect (the "flag" half): ledger-wasm resolves the enforcement argument of
// cost()/fees() as `enforce_time_to_dismiss.unwrap_or(false)`, so the
// time-to-dismiss rule the node applies is off by default client-side.
//
// Shown on a transaction the node is known to reject with 231: a NIGHT swap. The
// check depends on the PROVEN size (the allowance is per byte), so the swap is
// signed and proven here, then costed three ways, and NOT submitted. Needs a
// funded stagenet wallet (MN_STAGENET_SEED) and a local proof server.
import { buildWallet, waitForRealSync, firstState, NIGHT } from '../src/wallet.js';
import { result, liveParams } from './_common.js';

const seed = process.env.MN_STAGENET_SEED;
if (!seed) { result('fee-flag-default', 'SKIPPED', 'MN_STAGENET_SEED not set'); }
else {
  const b = await buildWallet(seed);
  await waitForRealSync(b.wallet, { label: 'fee-flag' });
  const st = await firstState(b.wallet);
  // OUTPUTS shielded outputs raise the guaranteed section's verification cost
  // without adding many bytes, which is what pushes a swap past the allowance.
  const outputs = Number(process.env.OUTPUTS ?? 1);
  const amount = BigInt(process.env.AMOUNT ?? 1_000_000) * BigInt(outputs);
  const recipe: any = await b.wallet.initSwap(
    { unshielded: { [NIGHT]: amount } } as any,
    [{ type: 'shielded', outputs: Array.from({ length: outputs }, () => ({ type: NIGHT, receiverAddress: st.shielded.address, amount: amount / BigInt(outputs) })) }] as any,
    { shieldedSecretKeys: b.zswapSecretKeys, dustSecretKey: b.dustSecretKey },
    { ttl: new Date(Date.now() + 3_600_000), payFees: true },
  );
  const { height, params } = await liveParams();
  const attempt = (tx: any, label: string, flag?: boolean) => {
    try { const c = flag === undefined ? tx.cost(params) : tx.cost(params, flag); return `${label}: ok (compute ${(Number(c.computeTime) / 1e9).toFixed(1)} ms)`; }
    catch (e: any) { return `${label}: THROWS ${String(e?.message ?? e).slice(0, 100)}`; }
  };
  const unproven: any = recipe.transaction;
  console.log(`unproven swap with ${outputs} shielded output(s), ${unproven.serialize().length} B, live params at block ${height}`);
  console.log('  ' + attempt(unproven, 'cost(params, true) on the UNPROVEN tx'));
  const signed = await b.wallet.signRecipe(recipe, (d: Uint8Array) => b.unshieldedKeystore.signDataAsync(d));
  const t0 = Date.now();
  const proven: any = await b.wallet.finalizeRecipe(signed);
  console.log(`proven swap, ${proven.serialize().length} B, proved in ${((Date.now() - t0) / 1000).toFixed(1)}s — not submitted`);
  const lines = [
    attempt(proven, 'cost(params)          '),
    attempt(proven, 'cost(params, false)   ', false),
    attempt(proven, 'cost(params, true)    ', true),
  ];
  let feeDefault = 'n/a';
  try { feeDefault = (Number(proven.fees(params)) / 1e15).toFixed(4) + ' DUST'; } catch (e: any) { feeDefault = 'THROWS ' + String(e?.message ?? e).slice(0, 60); }
  lines.forEach((l) => console.log('  ' + l));
  console.log(`  fees(params) with the default flag: ${feeDefault}`);
  b.wallet.stop().catch(() => {});
  const defaultOk = lines[0].includes(': ok'), explicitThrows = lines[2].includes('THROWS');
  if (defaultOk && explicitThrows) result('fee-flag-default', 'REPRODUCED', 'on the proven swap, cost(params) and fees(params) pass while cost(params, true) throws OutsideTimeToDismiss — the check the node applies is off unless the caller opts in');
  else if (!explicitThrows) result('fee-flag-default', 'NOT REPRODUCED', 'cost(params, true) did not throw on the proven swap either; this transaction fits the time-to-dismiss allowance');
  else result('fee-flag-default', 'NOT REPRODUCED', lines.join(' | '));
}
