/**
 * wallet.ts -- Stagenet (Midnight 2.0 / ledger-9) wallet construction.
 *
 * This is a PORT of ../src/providers.ts from the ledger-8 line. Everything that
 * changed between the two generations is called out inline, because the whole
 * point of this sandbox is to find out what a preview upgrade will cost us.
 *
 * WHAT CHANGED FROM ledger-8 / wallet-sdk 1.x
 *   1. ledger package is `@midnightntwrk/ledger-v9` -- note the org name has NO
 *      hyphen, unlike every other package (`@midnight-ntwrk/...`). Typo here
 *      gives a bare "cannot find module".
 *   2. wallet-sdk@2.0.0-beta.2's barrel pins wallet-sdk-utilities to 1.2.0, but
 *      wallet-sdk-facade@5.0.0-beta.2 imports `Clock` from it, which only exists
 *      from 1.2.1. A clean install fails at IMPORT time. package.json carries an
 *      override; see the note there. This is an upstream packaging bug.
 *   3. NetworkId is now a free-form string (`string | typeof mainnet`) rather
 *      than a closed union, so 'stagenet' needs no SDK change.
 *   4. transferTransaction takes GROUPED outputs -- `{type:'shielded'|'unshielded',
 *      outputs: TokenTransfer[]}[]` -- so the caller now declares the segment
 *      explicitly instead of it being inferred from the address type.
 *   5. New: WalletFacade.fetchTermsAndConditions(), a validationService, and an
 *      injectable clock. None are required to transact.
 *
 * WHAT DID NOT CHANGE: init/start split, the balance -> sign -> finalize ->
 * submit pipeline, and the sync-progress traps. Those notes are carried over
 * verbatim because they were expensive to learn and still apply.
 */

import * as ledger from '@midnightntwrk/ledger-v9';
import {
  WalletFacade,
  HDWallet,
  Roles,
  ShieldedWallet,
  UnshieldedWallet,
  DustWallet,
  PublicKey,
  createKeystore,
  InMemoryTransactionHistoryStorage,
  WalletEntrySchema,
  validateMnemonic,
  mnemonicToWords,
} from '@midnight-ntwrk/wallet-sdk';
import { mnemonicToSeedSync } from '@scure/bip39';
import { WebSocket as WsPolyfill } from 'ws';

// Only polyfill when there is no native WebSocket. Node 22 has one; blindly
// overwriting it breaks sync SILENTLY (the SDK sets shouldRetry:false, so one
// failed connect is permanent and the wallet sits at connected=false forever).
if (typeof (globalThis as any).WebSocket !== 'function') {
  (globalThis as any).WebSocket = WsPolyfill;
}

export const NETWORK_ID = process.env.MN_NETWORK_ID ?? 'stagenet';
export const INDEXER_HTTP =
  process.env.MN_INDEXER_HTTP ?? 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
export const INDEXER_WS =
  process.env.MN_INDEXER_WS ?? 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws';
export const NODE_RPC = process.env.MN_NODE_RPC ?? 'wss://rpc.stagenet.shielded.tools';
// Proof server 9.0.0-rc.5_experimental, run locally. NOTE: its CLI changed --
// `--network` is GONE, the only flag is `--num-workers`. The 8.1.0 invocation
// we use on preview fails outright with "unexpected argument '--network'".
export const PROOF_SERVER = process.env.MN_PROOF_SERVER ?? 'http://localhost:6310';
export const FAUCET_API = process.env.MN_FAUCET ?? 'https://faucet.stagenet.shielded.tools/api';

export const NIGHT: string = ledger.nativeToken().raw;

/**
 * DUST cost parameters. Carried over from the ledger-8 harness:
 *   additionalFeeOverhead -- 500 DUST is the testkit default and is meant for
 *     LOCAL networks; on a remote network it "requires too much dust" and the
 *     official bboard CLI overrides it to ~1000 SPECK. Stagenet is remote.
 *   feeBlocksMargin -- an EXPONENT, not a block count. feesWithMargin() applies
 *     it as a power, so the fee grows geometrically. Keep it 0-2; 5 inflated a
 *     trivial deploy past 24 DUST and threw "could not balance dust", which
 *     reads like out-of-funds but is really an over-margin bug.
 */
export const DUST_COST_PARAMETERS = {
  additionalFeeOverhead: BigInt(process.env.MN_FEE_OVERHEAD_SPECK ?? 1_000n),
  feeBlocksMargin: Number(process.env.MN_FEE_BLOCKS_MARGIN ?? 2),
};

export function walletConfiguration() {
  return {
    networkId: NETWORK_ID,
    indexerClientConnection: { indexerHttpUrl: INDEXER_HTTP, indexerWsUrl: INDEXER_WS },
    provingServerUrl: new URL(PROOF_SERVER),
    relayURL: new URL(NODE_RPC),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema),
    costParameters: DUST_COST_PARAMETERS,
    batchUpdates: {
      size: Number(process.env.MN_BATCH_SIZE ?? 200),
      timeout: Number(process.env.MN_BATCH_TIMEOUT_MS ?? 1),
      spacing: Number(process.env.MN_BATCH_SPACING_MS ?? 0),
    },
  };
}

const ROLES_NEEDED = [Roles.Zswap, Roles.Dust, Roles.NightExternal] as const;

/**
 * HDWallet.fromSeed accepts BOTH 32- and 64-byte seeds and returns seedOk for
 * either -- but they derive DIFFERENT wallets, with no error anywhere. You would
 * fund one address and spend from another. So: a mnemonic yields the FULL
 * 64-byte BIP39 seed and is never truncated, and a hex seed must be exactly 32
 * or 64 bytes rather than being silently accepted.
 */
function seedToBytes(secret: string): Uint8Array {
  const raw = secret.trim();
  if (/\s/.test(raw)) {
    if (!validateMnemonic(raw)) {
      throw new Error(`mnemonic failed BIP39 validation (${mnemonicToWords(raw).length} words)`);
    }
    return mnemonicToSeedSync(raw);
  }
  const hex = raw.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('secret must be a BIP39 mnemonic or an even-length hex string');
  }
  const bytes = hex.length / 2;
  if (bytes !== 32 && bytes !== 64) {
    throw new Error(
      `hex seed is ${bytes} bytes; expected exactly 32 or 64. Refusing to guess -- a wrong ` +
        `length derives a DIFFERENT wallet silently, which is a fund-losing bug.`,
    );
  }
  return Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

export function deriveKeysFromSeed(seed: string, account = 0, index = 0) {
  const res = HDWallet.fromSeed(seedToBytes(seed));
  if (res.type !== 'seedOk') throw new Error(`HDWallet.fromSeed failed: ${JSON.stringify(res)}`);
  const derived = res.hdWallet.selectAccount(account).selectRoles(ROLES_NEEDED).deriveKeysAt(index);
  if (derived.type !== 'keysDerived') {
    throw new Error(`key derivation failed: ${JSON.stringify(derived)}`);
  }
  res.hdWallet.clear();
  return derived.keys;
}

export interface WalletBundle {
  wallet: WalletFacade;
  zswapSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: ReturnType<typeof createKeystore>;
}

export async function buildWallet(seed: string): Promise<WalletBundle> {
  const keys = deriveKeysFromSeed(seed);
  const zswapSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  // 2.0 change: createKeystore takes {kind, secret}, not raw bytes. `kind` is the
  // signature scheme and it is now EXPLICIT -- 'schnorr' | 'ecdsa'. Choosing the
  // wrong one silently derives a DIFFERENT address. 'schnorr' is the one to use:
  // the SDK's own deserializer describes ledger-v8 keys as "implicitly schnorr",
  // and V1Builder hardcodes it, so it is what preserves address continuity.
  const unshieldedKeystore = createKeystore(
    { kind: 'schnorr', secret: keys[Roles.NightExternal] }, NETWORK_ID,
  );

  const wallet = await WalletFacade.init({
    configuration: walletConfiguration() as any,
    shielded: (c: any) => ShieldedWallet(c).startWithSecretKeys(zswapSecretKeys),
    unshielded: (c: any) =>
      UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (c: any) =>
      DustWallet(c).startWithSecretKey(
        dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
      ),
  } as any);

  // REQUIRED. init() only CONSTRUCTS -- it resolves services, calls the three
  // sub-wallet factories, and returns the facade. It never starts anything.
  // Without start() every sub-wallet reports 0/0 and isConnected=false FOREVER
  // with no error, which looks exactly like a WebSocket problem and sends you
  // debugging the wrong layer. The startWith* factory names are misleading:
  // they select a starting STATE, they do not begin syncing.
  await wallet.start(zswapSecretKeys, dustSecretKey);
  return { wallet, zswapSecretKeys, dustSecretKey, unshieldedKeystore };
}

export function firstState(wallet: WalletFacade): Promise<any> {
  return new Promise((resolve) => {
    const sub = wallet.state().subscribe((st: any) => {
      resolve(st);
      try { (sub as any).unsubscribe?.(); } catch { /* ignore */ }
    });
  });
}

/**
 * Wait for a GENUINELY synced wallet.
 *
 * The trap: FacadeState.isSynced is isStrictlyComplete() on all three
 * sub-wallets, and that is `isConnected && |relevant - applied| === 0`. On a
 * FRESH wallet mid-sync that is 0/0 -> TRUE, so isSynced flips true before the
 * dust wallet has loaded ANY coins; balancing then throws "could not balance
 * dust" on a funded wallet. So we require dust to have actually advanced past
 * genesis: applied > 0 AND lag 0 AND connected.
 */
export async function waitForRealSync(
  wallet: WalletFacade,
  opts: { timeoutMs?: number; requireDustCoins?: boolean; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.MN_SYNC_TIMEOUT_MS ?? 600_000);
  const requireDustCoins = opts.requireDustCoins ?? true;
  const label = opts.label ? `[${opts.label}] ` : '';
  let last = '';
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (ok: boolean, msg?: string) => {
      if (done) return;
      done = true;
      try { (sub as any).unsubscribe?.(); } catch { /* ignore */ }
      clearTimeout(timer);
      ok ? resolve() : reject(new Error(msg));
    };
    const timer = setTimeout(
      () => finish(false, `${label}no real synced state within ${timeoutMs / 1000}s. Last: ${last}`),
      timeoutMs,
    );
    const sub = wallet.state().subscribe((st: any) => {
      const dp = st?.dust?.progress;
      if (!dp) return;
      const applied = BigInt(dp.appliedIndex ?? 0);
      const relevant = BigInt(dp.highestRelevantWalletIndex ?? 0);
      const connected = Boolean(dp.isConnected);
      const lag = relevant > applied ? relevant - applied : applied - relevant;
      const coins = (st?.dust?.availableCoins ?? []).length;
      last = `dust applied=${applied} relevant=${relevant} lag=${lag} coins=${coins} connected=${connected}`;
      if (process.env.MN_DEBUG_SYNC === '1') console.error(`  ${label}${last}`);
      if (!(applied > 0n && connected && lag === 0n)) return;
      if (requireDustCoins && coins === 0) return;
      finish(true);
    });
  });
}

/**
 * Version-agnostic transaction builders. wallet-sdk 2.0.0-beta.2 takes the
 * secret keys on every transferTransaction/initSwap call; beta.3 holds them
 * from start() and takes only options. The repro scripts call these so the same
 * script runs against both stacks (../stagenet vs ../stagenet-next).
 */
export const SDK_LINE = 'wallet-sdk 2.0.0-beta.2';
export function transferTx(b: WalletBundle, outputs: any[], opts: { ttl: Date; payFees?: boolean }) {
  return b.wallet.transferTransaction(outputs as any,
    { shieldedSecretKeys: b.zswapSecretKeys, dustSecretKey: b.dustSecretKey }, opts as any);
}
export function swapTx(b: WalletBundle, inputs: any, outputs: any[], opts: { ttl: Date; payFees?: boolean }) {
  return b.wallet.initSwap(inputs, outputs as any,
    { shieldedSecretKeys: b.zswapSecretKeys, dustSecretKey: b.dustSecretKey }, opts as any);
}

/** Walk an Effect Cause / nested error to something printable. */
export function describeError(e: any): string {
  const seen = new Set<any>();
  const walk = (x: any, depth = 0): string => {
    if (x == null || depth > 6 || seen.has(x)) return '';
    if (typeof x === 'object') seen.add(x);
    if (typeof x === 'string') return x;
    const parts: string[] = [];
    if (x.message) parts.push(String(x.message));
    for (const k of Object.getOwnPropertySymbols(x)) {
      const v = (x as any)[k];
      const s = walk(v, depth + 1);
      if (s) parts.push(s);
    }
    for (const k of ['cause', 'error', 'defect', 'failure', 'left', 'value']) {
      const s = walk(x[k], depth + 1);
      if (s) parts.push(s);
    }
    return parts.filter(Boolean).join(' | ');
  };
  const out = walk(e);
  return out || String(e);
}
