/**
 * smoke.ts -- Stagenet smoke test for the Midnight 2.0 / ledger-9 stack.
 *
 * Goal: find out whether the two paths that matter on preview still work on the
 * next generation, and in particular whether the SHIELDED path -- which fails
 * with ledger error 170 on every wallet-sdk 1.x build we have tried -- works
 * here. Lace-built shielded transactions succeed on preview while SDK-built ones
 * do not, and Lace is presumed to be on a newer stack, so this is the test that
 * distinguishes "our code is wrong" from "1.x builds invalid shielded txs".
 *
 * Phases:
 *   addr        derive and print addresses (offline, no network, no funds)
 *   status      sync and report NIGHT / shielded / DUST balances
 *   register    register NIGHT UTXOs for DUST generation
 *   unshielded  self-transfer, unshielded segment
 *   shield      move NIGHT from the unshielded pool into the shielded pool
 *   shielded    self-transfer, shielded segment      <- the question
 *   churn       sync once, then submit repeatedly, to put load on the chain
 *   burst       fire N shielded transfers CONCURRENTLY, to co-locate them in one block
 *   sustain     pre-prove a batch, then release one per block, to hold >50% fullness
 */

import { writeFileSync, appendFileSync } from 'node:fs';
import * as ledger from '@midnightntwrk/ledger-v9';
import { parseHexLedgerParameters } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk';
import {
  buildWallet, waitForRealSync, firstState, describeError,
  NIGHT, NETWORK_ID, INDEXER_HTTP, NODE_RPC, PROOF_SERVER,
  type WalletBundle,
} from './wallet.js';

const args = process.argv.slice(2);
const argOf = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const flag = (n: string) => args.includes(`--${n}`);

const PHASE = argOf('phase', 'status')!;
const OUTPUTS = Number(argOf('outputs', '2'));
const LOG = argOf('log', `smoke_${PHASE}.jsonl`)!;

const log = (rec: any) => {
  const line = JSON.stringify({ t: new Date().toISOString(), phase: PHASE, ...rec });
  appendFileSync(LOG, line + '\n');
  console.log(line);
};

/**
 * Transaction TTL.
 *
 * Ledger error 231 is FeeCalculation(OutsideTimeToDismiss): the ledger refuses
 * to PRICE a transaction whose TTL falls outside the window it is willing to
 * hold. One hour is the preview-era `global_ttl` and sits exactly on that
 * boundary, so it is worth being able to vary this rather than assuming.
 */
function txTtl(): Date {
  return new Date(Date.now() + Number(process.env.MN_TTL_MS ?? 60 * 60 * 1000));
}

/**
 * Preflight the proof server -- confirm something is actually listening before
 * we spend a sync waiting to discover otherwise. Proof-server version mismatch
 * was a 9.8x throughput bug on the ledger-8 line, so we want the version too.
 *
 * BUT: 9.0.0-rc.5_experimental REMOVED /version -- every path returns 404, where
 * 8.1.0 served a version string. A 404 therefore still proves the server is up
 * and answering; only a connection error means it is not. We report the version
 * as unavailable rather than failing, and fall back to the image tag we launched.
 */
async function assertProofServer(): Promise<string> {
  try {
    const r = await fetch(`${PROOF_SERVER}/version`, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) return (await r.text()).trim();
    return `listening (HTTP ${r.status}; 9.x serves no /version endpoint)`;
  } catch (e: any) {
    throw new Error(`proof server ${PROOF_SERVER} unreachable: ${e?.message ?? e}`);
  }
}

const sum = (xs: any[], f: (x: any) => bigint) => xs.reduce((a, x) => a + f(x), 0n);

/**
 * Ask the ledger, locally, whether the node will accept this transaction's COST.
 *
 * Ledger error 231 is FeeCalculation(OutsideTimeToDismiss), and the rule is:
 *
 *   allowed  = max(time_to_dismiss_per_byte * est_size, min_time_to_dismiss)
 *   reject if cost_to_dismiss.max_time() > allowed
 *
 * i.e. a transaction may not cost more to VERIFY than its own byte size pays
 * for -- an anti-DoS rule against small-but-expensive transactions.
 *
 * The trap: the WASM binding declares `enforceTimeToDismiss` optional and
 * defaults it to FALSE, so every fee number the wallet computes has the rule
 * switched off. The node switches it ON. The SDK therefore builds, signs,
 * proves and submits transactions that the chain rejects unconditionally, and
 * the client never sees why. Calling cost(params, true) ourselves is the only
 * way to get the numbers before spending a proof on it.
 */
let CHAIN_PARAMS: any = null;

/**
 * Fetch the ledger parameters the CHAIN is actually running.
 *
 * This matters more than it looks. LedgerParameters.initialParameters() is the
 * GENESIS cost model, and on Stagenet it is not what the node uses: diffing the
 * two shows 143 differing lines, with the chain's per-operation costs running
 * roughly 2-14x more expensive (e.g. new_map 2.908us vs 978.652ns). The
 * time_to_dismiss LIMITS are the same in both, and so are the DUST parameters --
 * it is specifically the transaction cost model that diverges.
 *
 * Any fee estimate or dismissal check computed against initialParameters() is
 * therefore computed against a model that materially understates real cost,
 * which is the most likely explanation for a transaction that passes every
 * client-side check and is then rejected by the node with a FeeCalculation error.
 */
async function fetchChainParams(): Promise<any> {
  if (CHAIN_PARAMS) return CHAIN_PARAMS;
  const r = await fetch(INDEXER_HTTP, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ block { height ledgerParameters } }' }),
    signal: AbortSignal.timeout(20_000),
  });
  const j: any = await r.json();
  const hex = j?.data?.block?.ledgerParameters;
  if (!hex) throw new Error('indexer returned no ledgerParameters');
  CHAIN_PARAMS = parseHexLedgerParameters(hex);
  return CHAIN_PARAMS;
}

function costReport(tx: any, params?: any): Record<string, unknown> {
  params = params ?? (ledger as any).LedgerParameters.initialParameters();
  const out: Record<string, unknown> = {};
  // est_size is not exposed on the WASM tx, so measure the real serialized
  // length -- that is what the per-byte allowance is computed from.
  try {
    const ser = (tx as any).serialize?.();
    out.serializedBytes = ser ? (ser.length ?? ser.byteLength ?? -1) : -1;
  } catch { out.serializedBytes = -1; }
  // What the DEFAULT (genesis) limits would allow, for comparison against the
  // numbers the chain actually enforces.
  try {
    const lim = (ledger as any).LedgerParameters.initialParameters().limits;
    out.limits = JSON.parse(JSON.stringify(lim, (_k, v) =>
      typeof v === 'bigint' ? String(v) : v));
  } catch { /* limits shape varies */ }
  // The actual DUST fee, in SPECK. 1 DUST = 1e15 SPECK.
  try {
    const f = tx.fees(params, false);
    out.feeSpeck = String(f);
    out.feeDust = (Number(f) / 1e15).toFixed(6);
  } catch (e: any) { out.feeSpeck = `THROWS: ${String(e?.message ?? e).slice(0, 200)}`; }
  for (const [key, enforce] of [['costUnenforced', false], ['costEnforced', true]] as const) {
    try {
      const c = tx.cost(params, enforce);
      out[key] = JSON.parse(JSON.stringify(c, (_k, v) =>
        typeof v === 'bigint' ? String(v) : v));
    } catch (e: any) {
      out[key] = `THROWS: ${String(e?.message ?? e).slice(0, 300)}`;
    }
  }
  return out;
}

function summarize(st: any) {
  const un = (st?.unshielded?.availableCoins ?? []) as any[];
  const night = un.filter((c) => String(c?.utxo?.type) === NIGHT);
  const registered = night.filter((c) => c?.meta?.registeredForDustGeneration);
  const sh = (st?.shielded?.availableCoins ?? []) as any[];
  const dust = (st?.dust?.availableCoins ?? []) as any[];
  return {
    nightCoins: night.length,
    nightValue: String(sum(night, (c) => BigInt(c?.utxo?.value ?? 0))),
    // Per-UTXO breakdown: NIGHT value (STAR) of each unshielded coin and the
    // DUST generated so far on each dust coin. Both matter for concurrency,
    // because the balancer selects dust smallest-first and drains crumbs.
    nightUtxoStar: night.map((c) => String(c?.utxo?.value ?? 0)).sort((a, b) => Number(BigInt(b) - BigInt(a))),
    dustPerCoin: dust.map((c) => (Number(c?.generatedNow ?? 0) / 1e15).toFixed(3)).sort((a, b) => Number(b) - Number(a)),
    registeredCoins: registered.length,
    shieldedCoins: sh.length,
    shieldedValue: String(sum(sh, (c) => BigInt(c?.value ?? c?.coin?.value ?? 0))),
    dustCoins: dust.length,
    dustPending: (st?.dust?.pendingCoins ?? []).length,
    dustSpeck: String(sum(dust, (c) => BigInt(c?.generatedNow ?? 0))),
  };
}

/**
 * Build -> sign -> prove -> submit.
 *
 * ORDER MATTERS AND IS NOT OBVIOUS. finalizeRecipe only PROVES and BINDS; it
 * never signs. Skipping signRecipe yields ledger error 192, which is the SAME
 * code a double-signed transaction produces -- so 192 tells you the signature
 * is wrong, not which direction. Register/deregister sign internally: calling
 * signRecipe there double-signs and also gives 192.
 *
 * Unshielded inputs are authorised by SIGNATURES, so they need signRecipe.
 * Shielded inputs are authorised by ZK PROOFS, so they do not.
 */
async function buildSignProveSubmit(
  b: WalletBundle,
  groups: any[],
  opts: { sign: boolean },
) {
  const t0 = Date.now();
  const recipe = await b.wallet.transferTransaction(
    groups as any,
    { shieldedSecretKeys: b.zswapSecretKeys, dustSecretKey: b.dustSecretKey },
    { ttl: txTtl(), payFees: true },
  );
  const buildMs = Date.now() - t0;

  let toFinalize: any = recipe;
  let signMs = 0;
  if (opts.sign) {
    const t1 = Date.now();
    // 2.0 adds signDataAsync, which already matches the signer callback shape,
    // so the keystore method can be passed straight through.
    toFinalize = await b.wallet.signRecipe(recipe as any, (data: Uint8Array) =>
      b.unshieldedKeystore.signDataAsync(data),
    );
    signMs = Date.now() - t1;
  }

  const t2 = Date.now();
  const finalized = await b.wallet.finalizeRecipe(toFinalize);
  const proveMs = Date.now() - t2;

  log({ event: 'cost_genesis', ...costReport(finalized) });
  log({ event: 'cost_chain', ...costReport(finalized, await fetchChainParams()) });

  const t3 = Date.now();
  const txId = await b.wallet.submitTransaction(finalized);
  const submitMs = Date.now() - t3;

  return { txId, buildMs, signMs, proveMs, submitMs };
}

async function main() {
  const seed = process.env.MN_STAGENET_SEED;
  if (!seed) throw new Error('MN_STAGENET_SEED is not set (hex seed or BIP39 mnemonic)');

  console.error(
    `[stagenet] networkId=${NETWORK_ID} indexer=${INDEXER_HTTP} node=${NODE_RPC} proof=${PROOF_SERVER}`,
  );

  const b = await buildWallet(seed);
  const state0 = await firstState(b.wallet);
  const unshieldedAddr = state0?.unshielded?.address;
  const shieldedAddr = state0?.shielded?.address;

  // Addresses must be BECH32M for anything external (faucet, explorer, another
  // wallet). The raw state objects stringify to hex or "[object Object]", which
  // silently produces a useless address -- the same class of bug that made every
  // wallet log identical on the ledger-8 line. So encode explicitly:
  //   unshielded -> the keystore's own getBech32Address()
  //   shielded   -> MidnightBech32m.encode(networkId, addr), since ShieldedAddress
  //                 carries a Bech32m codec but no self-stringifying method.
  const bech32Unshielded = () => b.unshieldedKeystore.getBech32Address().asString();
  const bech32Shielded = (a: any) => MidnightBech32m.encode(NETWORK_ID, a).asString();

  if (PHASE === 'addr') {
    const out = {
      networkId: NETWORK_ID,
      unshielded: bech32Unshielded(),
      shielded: shieldedAddr ? bech32Shielded(shieldedAddr) : null,
    };
    writeFileSync('stagenet_addresses.json', JSON.stringify(out, null, 2));
    log({ event: 'addresses', ...out });
    await b.wallet.stop();
    return;
  }

  const version = await assertProofServer();
  log({ event: 'proof_server', version });

  // status/register do not require dust to already exist -- a virgin wallet
  // cannot have any, and requiring it here deadlocks the bootstrap.
  await waitForRealSync(b.wallet, {
    label: 'w',
    requireDustCoins: PHASE !== 'status' && PHASE !== 'register',
  });

  const st = await firstState(b.wallet);
  log({ event: 'synced', ...summarize(st) });

  if (PHASE === 'status') {
    await b.wallet.stop();
    return;
  }

  if (PHASE === 'register') {
    const un = (st?.unshielded?.availableCoins ?? []) as any[];
    const night = un.filter(
      (c) => String(c?.utxo?.type) === NIGHT && !c?.meta?.registeredForDustGeneration,
    );
    if (!night.length) {
      log({ event: 'register_skipped', reason: 'no unregistered NIGHT UTXOs' });
      await b.wallet.stop();
      return;
    }
    const vk = b.unshieldedKeystore.getPublicKey();
    const recipe = await b.wallet.registerNightUtxosForDustGeneration(
      night as any,
      vk,
      (data: Uint8Array) => b.unshieldedKeystore.signDataAsync(data),
    );
    // registerNightUtxos... signs INTERNALLY. Do not call signRecipe here.
    const finalized = await b.wallet.finalizeRecipe(recipe as any);
    const txId = await b.wallet.submitTransaction(finalized);
    log({ event: 'registered', utxos: night.length, txId: String(txId) });
    await b.wallet.stop();
    return;
  }

  if (PHASE === 'shield') {
    // A shielded TRANSFER spends shielded coins, and a faucet-funded wallet has
    // none -- it would fail with "insufficient funds" and tell us nothing about
    // error 170. So first move value across the pool boundary with initSwap:
    // desiredInputs says what goes IN (unshielded NIGHT), desiredOutputs says
    // what comes OUT (a shielded NIGHT coin to ourselves).
    const amount = BigInt(argOf('amount', '1000000')!);
    // Splitting the same value across N outputs adds BYTES without adding much
    // verification cost -- zswap outputs are cheap to verify relative to inputs.
    // Since the time-to-dismiss allowance is per-byte, more outputs RAISES the
    // budget, which is the lever for getting under a 231.
    const n = OUTPUTS;
    const per = amount / BigInt(n);
    // PADDING. The time-to-dismiss allowance is per BYTE, so a transaction that
    // is rejected as "too expensive to verify for its size" can be brought under
    // the bar by making it BIGGER at low verification cost. desiredOutputs is an
    // array of GROUPS, so we can append a second, unshielded group of self-pay
    // outputs: those add bytes and a cheap UTXO insert each, without adding any
    // zswap proof work. --pad N sets how many.
    const pad = Number(argOf('pad', '0'));
    const padPer = 1000n;
    const groups: any[] = [
      { type: 'shielded', outputs: Array.from({ length: n }, () => (
        { type: NIGHT, receiverAddress: shieldedAddr, amount: per })) },
    ];
    if (pad > 0) {
      groups.push({ type: 'unshielded', outputs: Array.from({ length: pad }, () => (
        { type: NIGHT, receiverAddress: unshieldedAddr, amount: padPer })) });
    }
    const t0 = Date.now();
    const recipe = await b.wallet.initSwap(
      { unshielded: { [NIGHT]: per * BigInt(n) + padPer * BigInt(pad) } },
      groups as any,
      { shieldedSecretKeys: b.zswapSecretKeys, dustSecretKey: b.dustSecretKey },
      { ttl: txTtl(), payFees: true },
    );
    const buildMs = Date.now() - t0;
    // The UNSHIELDED side is authorised by a signature, so this one does need
    // signing even though the output is shielded.
    const signed = await b.wallet.signRecipe(recipe as any, (d: Uint8Array) =>
      b.unshieldedKeystore.signDataAsync(d),
    );
    const t1 = Date.now();
    const finalized = await b.wallet.finalizeRecipe(signed);
    const proveMs = Date.now() - t1;
    log({ event: 'cost_genesis', ...costReport(finalized) });
    log({ event: 'cost_chain', ...costReport(finalized, await fetchChainParams()) });
    const t2 = Date.now();
    const txId = await b.wallet.submitTransaction(finalized);
    log({ event: 'shielded_funded', amount: String(amount), txId: String(txId),
          buildMs, proveMs, submitMs: Date.now() - t2 });
    await b.wallet.stop();
    return;
  }

  if (PHASE === 'sustain') {
    /**
     * Hold block fullness above the 50% crossover for consecutive blocks and
     * watch `overall_price` compound.
     *
     * WHY PRE-PROVE. One 68-output shielded transfer is 569,482 bytes -- 56.9% of
     * a block -- and takes ~56s to prove. Blocks are 6s. Sustaining one per block
     * live would need ~10 concurrent proving lanes, which a 16-core host cannot
     * supply; the result would be one full block in every nine and an average
     * fullness near 6%, where the price decays and pins at `min_block_price`.
     *
     * So proving and submission are decoupled: build and prove the whole batch
     * first, holding the finalized transactions, then release them one per block.
     * That produces N genuinely consecutive >50% blocks.
     *
     * TWO LIMITS ON N. Each transaction consumes a dust coin for its fee and
     * shielded coins for its inputs, and coin selection cannot reuse them across
     * unsubmitted transactions -- so N is bounded by the wallet's dust coin count.
     * And the batch must still be inside its TTL when the last one is released,
     * so MN_TTL_MS must exceed proving time plus release time (stagenet's
     * global_ttl is 14 days, so this is a client-side choice only).
     */
    const n = Number(argOf('n', '12'));
    const per = Number(argOf('outputs', '68'));
    const spacingMs = Number(argOf('spacing-ms', '6000'));
    const coins0 = (st?.shielded?.availableCoins ?? []) as any[];
    if (!coins0.length) throw new Error('no shielded coins -- run `npm run mint` first');
    const tokenType = String(coins0[0]?.type ?? coins0[0]?.coin?.type ?? coins0[0]?.color ?? '');
    const dustCoins = (st?.dust?.availableCoins ?? []).length;
    log({ event: 'sustain_start', n, outputsEach: per, tokenType, dustCoins,
          note: n > dustCoins ? 'n exceeds dust coin count -- expect failures' : 'ok' });

    // Phase 1: build and prove everything, submitting nothing.
    const ready: any[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = Date.now();
      try {
        const outs = Array.from({ length: per }, () => ({
          type: tokenType, receiverAddress: shieldedAddr, amount: 1n,
        }));
        const recipe = await b.wallet.transferTransaction(
          [{ type: 'shielded', outputs: outs }] as any,
          { shieldedSecretKeys: b.zswapSecretKeys, dustSecretKey: b.dustSecretKey },
          { ttl: txTtl(), payFees: true },
        );
        const finalized = await b.wallet.finalizeRecipe(recipe as any);
        ready.push(finalized);
        // How many dust coins did THIS build lock? Pending is tracked per dust
        // UTXO (dust-wallet CoreWallet.pendingDust), so this should grow by the
        // number of coins the balancer selected, not jump to the whole wallet.
        const stNow = await firstState(b.wallet);
        log({ event: 'proved', i, ms: Date.now() - t0, ready: ready.length,
              dustAvailable: (stNow?.dust?.availableCoins ?? []).length,
              dustPending: (stNow?.dust?.pendingCoins ?? []).length,
              bytes: (() => { try { return (finalized as any).serialize?.().length ?? -1; } catch { return -1; } })() });
      } catch (e: any) {
        log({ event: 'prove_fail', i, ms: Date.now() - t0, error: describeError(e).slice(0, 250) });
      }
    }
    log({ event: 'proved_all', ready: ready.length });

    // Phase 2: release one per block.
    let ok = 0, fail = 0;
    for (let i = 0; i < ready.length; i++) {
      const t0 = Date.now();
      try {
        const txId = await b.wallet.submitTransaction(ready[i]);
        ok++;
        log({ event: 'released', i, txId: String(txId), ms: Date.now() - t0 });
      } catch (e: any) {
        fail++;
        log({ event: 'release_fail', i, error: describeError(e).slice(0, 250) });
      }
      const wait = spacingMs - (Date.now() - t0);
      if (wait > 0 && i < ready.length - 1) await new Promise((r) => setTimeout(r, wait));
    }
    log({ event: 'sustain_done', proved: ready.length, ok, fail });
    await b.wallet.stop();
    return;
  }

  if (PHASE === 'burst') {
    /**
     * Concurrent submission, to push a single block past the 50% crossover.
     *
     * A single transaction cannot do it if the node caps per-transaction cost
     * below the block limit -- a 110-output transfer at 78.6% of `block_usage`
     * was rejected as "would exhaust the block limits" while every dimension sat
     * under its limit. So the only route above 50% is several transactions
     * landing in the same 6-second block.
     *
     * One wallet normally means one lane, because concurrent transactions
     * collide selecting the same dust coin (error 196, DustDoubleSpend). This
     * wallet holds 17 dust coins, so a handful of lanes should be available.
     * Everything is built, proved and submitted in parallel; whether they land
     * together is up to the node's block assembly, so this may need repeating.
     */
    const n = Number(argOf('n', '2'));
    const per = Number(argOf('outputs', '32'));
    const coins = (st?.shielded?.availableCoins ?? []) as any[];
    if (!coins.length) throw new Error('no shielded coins -- run `npm run mint` first');
    const tokenType = String(coins[0]?.type ?? coins[0]?.coin?.type ?? coins[0]?.color ?? '');
    log({ event: 'burst_start', n, outputsEach: per, tokenType });

    const one = async (i: number) => {
      const outs = Array.from({ length: per }, () => ({
        type: tokenType, receiverAddress: shieldedAddr, amount: 1n,
      }));
      const t0 = Date.now();
      const recipe = await b.wallet.transferTransaction(
        [{ type: 'shielded', outputs: outs }] as any,
        { shieldedSecretKeys: b.zswapSecretKeys, dustSecretKey: b.dustSecretKey },
        { ttl: txTtl(), payFees: true },
      );
      const finalized = await b.wallet.finalizeRecipe(recipe as any);
      const txId = await b.wallet.submitTransaction(finalized);
      return { i, txId: String(txId), ms: Date.now() - t0 };
    };

    const results = await Promise.allSettled(
      Array.from({ length: n }, (_, i) => one(i)),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') log({ event: 'burst_ok', ...r.value });
      else log({ event: 'burst_fail', error: describeError(r.reason).slice(0, 300) });
    }
    log({ event: 'burst_done',
          ok: results.filter((r) => r.status === 'fulfilled').length,
          fail: results.filter((r) => r.status === 'rejected').length });
    await b.wallet.stop();
    return;
  }

  if (PHASE === 'churn') {
    /**
     * Sustained load, to answer one question: does `overall_price` move?
     *
     * Stagenet has sat at the genesis value 10 for 258,000 blocks while preview
     * decayed 10 -> MIN_COST in ~1,300. Either stagenet's price adjustment is
     * not running, or it only runs under conditions an idle chain never meets.
     * Making blocks consistently NON-EMPTY is the discriminator, and it does not
     * require 50% fullness: below the crossover the price should FALL, and at
     * even a few percent fullness that is ~3%/block -- a halving in ~20 blocks.
     *
     * Syncs once and then submits back-to-back; re-syncing per transaction (what
     * the one-shot phases do) wastes most of the wall clock.
     */
    const durationMs = Number(argOf('minutes', '15')) * 60_000;
    const minDust = BigInt(argOf('min-dust-speck', '3000000000000000')!); // 3 DUST
    const deadline = Date.now() + durationMs;
    let ok = 0, fail = 0;
    /**
     * Wait for spendable dust, rather than bailing the first time it reads zero.
     *
     * Right after a submit, the dust coin that paid for it moves to pendingDust
     * and availableCoins drops to zero for a few seconds until the transaction is
     * included and synced. A naive floor check therefore fires on a TRANSIENT
     * zero and stops the run after one transaction -- which is exactly what it
     * did on the first attempt. Only a sustained shortfall means real exhaustion.
     */
    const dustNow = async () => sum(
      ((await firstState(b.wallet))?.dust?.availableCoins ?? []) as any[],
      (c: any) => BigInt(c?.generatedNow ?? 0),
    );
    const waitForDust = async (): Promise<bigint> => {
      const until = Date.now() + 120_000;
      for (;;) {
        const d = await dustNow();
        if (d >= minDust || Date.now() > until) return d;
        await new Promise((r) => setTimeout(r, 3000));
      }
    };
    while (Date.now() < deadline) {
      const dust = await waitForDust();
      if (dust < minDust) {
        log({ event: 'churn_paused', reason: 'dust below floor for 120s', dustSpeck: String(dust) });
        break;
      }
      const groups = [{ type: 'unshielded', outputs: [
        { type: NIGHT, receiverAddress: unshieldedAddr, amount: 1000n },
      ] }];
      try {
        const r = await buildSignProveSubmit(b, groups, { sign: true });
        ok++;
        log({ event: 'churn_ok', n: ok, ...r, txId: String(r.txId), dustSpeck: String(dust) });
      } catch (e: any) {
        fail++;
        log({ event: 'churn_fail', n: fail, error: describeError(e).slice(0, 300) });
      }
    }
    log({ event: 'churn_done', ok, fail });
    await b.wallet.stop();
    return;
  }

  // ---- transfer phases -------------------------------------------------
  const isShielded = PHASE === 'shielded';
  const dest = isShielded ? shieldedAddr : unshieldedAddr;
  if (!dest) throw new Error(`no ${PHASE} address on wallet state`);

  // TOKEN TYPE. The unshielded side spends NIGHT. The shielded side cannot: the
  // faucet only drips unshielded NIGHT and initSwap is blocked by 231, so the
  // only shielded balance this wallet has is a CONTRACT-MINTED token whose type
  // is derived from the minting contract's domain separator. Hardcoding NIGHT
  // there would fail as "insufficient funds" and tell us nothing, so pick the
  // type off an actual coin we hold.
  let tokenType = NIGHT;
  let perOutput = BigInt(argOf('amount', '1')!);
  if (isShielded) {
    const coins = (st?.shielded?.availableCoins ?? []) as any[];
    if (!coins.length) {
      throw new Error('wallet holds no shielded coins -- run `npm run mint` first');
    }
    const byType = new Map<string, bigint>();
    for (const c of coins) {
      const t = String(c?.type ?? c?.coin?.type ?? c?.color ?? '');
      byType.set(t, (byType.get(t) ?? 0n) + BigInt(c?.value ?? c?.coin?.value ?? 0));
    }
    const [best] = [...byType.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1));
    tokenType = best[0];
    const spendable = best[1];
    log({ event: 'shielded_balance', tokenType, total: String(spendable),
          coins: coins.length, types: byType.size });
    // Spend a small, safe slice so the test is about VALIDITY, not balancing.
    const wanted = perOutput * BigInt(OUTPUTS);
    if (wanted > spendable) perOutput = spendable / BigInt(OUTPUTS * 2 || 1);
  }
  const outs = Array.from({ length: OUTPUTS }, () => ({
    type: tokenType, receiverAddress: dest, amount: perOutput,
  }));
  // 2.0 groups outputs by SEGMENT and the caller declares it explicitly. On the
  // 1.x line the segment was inferred from the address type; an explicit
  // declaration is exactly the kind of change that could fix the 170 failure,
  // whose leading hypothesis was a segment_id disagreement between the fee proof
  // and the assembled transaction.
  const groups = [{ type: isShielded ? 'shielded' : 'unshielded', outputs: outs }];

  log({ event: 'attempt', segment: groups[0].type, outputs: OUTPUTS, amount: String(perOutput) });

  try {
    const r = await buildSignProveSubmit(b, groups, { sign: !isShielded });
    log({ event: 'ok', segment: groups[0].type, ...r, txId: String(r.txId) });
  } catch (e: any) {
    log({ event: 'fail', segment: groups[0].type, error: describeError(e).slice(0, 800) });
    await b.wallet.stop().catch(() => {});
    process.exitCode = 1;
    return;
  }

  await b.wallet.stop();
}

main()
  .then(() => {
    // stop() can hang; a bounded exit keeps this from leaving a zombie holding
    // indexer connections, which is how we accumulated 19-hour orphans before.
    setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
  })
  .catch((e) => {
    console.error('FATAL:', describeError(e));
    process.exit(1);
  });
