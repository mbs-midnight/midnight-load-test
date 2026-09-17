/**
 * providers.ts — network config, wallet construction, and provider assembly.
 *
 * Uses the @midnight-ntwrk/wallet-sdk BARREL package (v1.1.0), which re-exports
 * wallet-sdk-facade and friends through one dependency. Importing the individual
 * sub-packages directly is no longer the recommended path.
 *
 * EVERY API CALL BELOW WAS VERIFIED against the installed v1.1.0 type definitions:
 *   HDWallet.fromSeed(Uint8Array) -> {type:'seedOk', hdWallet} | {type:'seedError'}
 *   .selectAccount(n).selectRoles([...]).deriveKeysAt(i)
 *        -> {type:'keysDerived', keys} | {type:'keyOutOfBounds'}
 *   Roles = { NightExternal:0, NightInternal:1, Dust:2, Zswap:3, Metadata:4 }
 *   ledger.ZswapSecretKeys.fromSeed(Uint8Array)
 *   ledger.DustSecretKey.fromSeed(Uint8Array)
 *   createKeystore(secretKey: Uint8Array, networkId)
 *   PublicKey.fromKeyStore(keystore)
 *   ShieldedWallet(config).startWithSecretKeys(zswapKeys)
 *   UnshieldedWallet(config).startWithPublicKey(publicKey)
 *   DustWallet(config).startWithSecretKey(dustKey, dustParameters)
 *   WalletFacade.init({ configuration, shielded, unshielded, dust })
 *   facade.balanceUnboundTransaction(tx, {shieldedSecretKeys, dustSecretKey}, {ttl})
 *   facade.finalizeRecipe(recipe) / facade.submitTransaction(tx)
 *   facade.waitForSyncedState()
 *
 * NOTE on docs drift: the Counter CLI tutorial and the facade's own README show
 * `new WalletFacade(shielded, unshielded, dust)` then `await wallet.start(...)`.
 * In the installed v4.0.1 facade the constructor is PRIVATE and `WalletFacade.init()`
 * is the entry point. We use init(). If a future version makes the constructor
 * public again, this is the one function to revisit.
 *
 * CRITICAL BUILD REQUIREMENT -- ledger-v8 MUST be deduped. midnight-js-protocol
 * pins @midnight-ntwrk/ledger-v8 to exactly 8.1.0 while the wallet SDK asks for
 * ^8.1.0 (resolving to 8.1.1), so npm installs TWO copies. Their types are
 * nominally incompatible (private `type_` field), which makes balanceTx/submitTx
 * fail to satisfy WalletProvider/MidnightProvider with a wall of unreadable
 * errors. package.json carries:
 *     "overrides": { "@midnight-ntwrk/ledger-v8": "8.1.0" }
 * Verify with: find node_modules -type d -name ledger-v8   (must print ONE path)
 *
 * Config field names, also verified against installed types:
 *   networkId
 *   indexerClientConnection: { indexerHttpUrl, indexerWsUrl?, keepAlive? }
 *   provingServerUrl: URL      <-- Arkhia ZKPaas goes here
 *   relayURL: URL              <-- node RPC, used for submission
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { ttlOneHour } from '@midnight-ntwrk/midnight-js-utils';

import * as ledger from '@midnight-ntwrk/ledger-v8';
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

import {
  type WalletProvider,
  type MidnightProvider,
  type UnboundTransaction,
} from '@midnight-ntwrk/midnight-js-types';
import { WebSocket as WsPolyfill } from 'ws';

// Wallet sync runs over a GraphQL WebSocket subscription. wallet-sdk-indexer-client
// calls graphql-ws's createClient WITHOUT a webSocketImpl, so graphql-ws falls back
// to globalThis.WebSocket -- whatever is global at that moment decides everything.
//
// Node 22 ships a native WebSocket. Blindly overwriting it with the `ws` package
// (which older docs advise, from before native support existed) can break sync and
// it fails SILENTLY: the SDK also sets shouldRetry:false, so one failed connect is
// permanent and the wallet sits at connected=false / highestIndex=0 forever.
//
// So: only polyfill when there is no native implementation. Set
// MN_FORCE_WS_POLYFILL=1 to override if the wallet reports connected=false and the ws
// package working where native does not.
const hasNativeWebSocket = typeof (globalThis as any).WebSocket === 'function';
const forcePolyfill = process.env.MN_FORCE_WS_POLYFILL === '1';
if (!hasNativeWebSocket || forcePolyfill) {
  (globalThis as any).WebSocket = WsPolyfill;
}
if (process.env.MN_DEBUG_WS === '1') {
  console.error(
    `[ws] native=${hasNativeWebSocket} forcePolyfill=${forcePolyfill} ` +
      `using=${hasNativeWebSocket && !forcePolyfill ? 'native' : 'ws package'}`,
  );
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------
// Network is selected with MN_NETWORK (preprod | preview | qanet), defaulting to
// preprod. Endpoints below are the ones baked into @midnight-ntwrk/testkit-js
// v4.0.4 -- read out of the package, not guessed. networkId matches the string
// testkit uses for each (preview -> 'preview', preprod -> 'preprod').
//
// WHY YOU MIGHT SWITCH: the dust wallet's sync accumulates unboundedly with chain
// history (preprod ~2M blocks OOMs it). A younger network (preview) has far less
// history, which may keep dust sync under the memory ceiling. Confirm the actual
// tip against the indexer [1] before committing -- if preview is also millions of
// blocks deep, it will not help and a local/low-history devnet is the next lever.
type Net = 'preprod' | 'preview' | 'qanet';
const REMOTES: Record<Net, { indexer: string; indexerWs: string; node: string; faucet: string }> = {
  preprod: {
    indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    node: 'wss://rpc.preprod.midnight.network',
    faucet: 'https://faucet.preprod.midnight.network/api/request-tokens',
  },
  preview: {
    indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    node: 'wss://rpc.preview.midnight.network',
    faucet: 'https://faucet.preview.midnight.network/api/request-tokens',
  },
  qanet: {
    indexer: 'https://indexer.qanet.dev.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.qanet.dev.midnight.network/api/v4/graphql/ws',
    node: 'wss://rpc.qanet.dev.midnight.network',
    faucet: 'https://faucet.qanet.dev.midnight.network/api/request-tokens',
  },
};

const SELECTED_NET = (process.env.MN_NETWORK ?? 'preprod') as Net;
if (!REMOTES[SELECTED_NET]) {
  throw new Error(`MN_NETWORK='${SELECTED_NET}' is not one of: ${Object.keys(REMOTES).join(', ')}`);
}
const R = REMOTES[SELECTED_NET];

// testkit uses networkId 'preview'/'preprod' verbatim; qanet runs as 'devnet'.
export const NETWORK_ID = (SELECTED_NET === 'qanet' ? 'devnet' : SELECTED_NET) as
  | 'preprod' | 'preview' | 'devnet';

export const INDEXER_HTTP = process.env.MN_INDEXER_HTTP ?? R.indexer;
export const INDEXER_WS = process.env.MN_INDEXER_WS ?? R.indexerWs;
export const NODE_RPC = (() => {
  const raw = process.env.MN_NODE_RPC ?? R.node;
  if (/^https?:\/\//.test(raw)) {
    // The node client uses @polkadot/api WsProvider, which requires ws://|wss://.
    // Auto-correct a common mistake (https -> wss) rather than fail at submit time.
    const fixed = raw.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');
    console.warn(`[providers] NODE_RPC '${raw}' uses an http scheme; the node needs a ` +
      `websocket URL. Using '${fixed}'. Set MN_NODE_RPC with ws://|wss:// to silence this.`);
    return fixed;
  }
  return raw;
})();
export const FAUCET_URL = process.env.MN_FAUCET ?? R.faucet;
// Proof server has no per-network default -- Arkhia ZKPaas is preprod-specific, and
// preview/qanet need their own proof server (Arkhia endpoint for that net, or a
// local one). Must be set explicitly when not on preprod.
export const PROOF_SERVER_URL =
  process.env.MN_PROOF_SERVER ??
  (SELECTED_NET === 'preprod' ? 'https://starter.arkhia.io/midnight/zkpaas/preprod/' : '');
if (!PROOF_SERVER_URL) {
  console.warn(
    `[providers] MN_NETWORK=${SELECTED_NET} has no default proof server. Set MN_PROOF_SERVER ` +
      `to a proof server that serves ${SELECTED_NET}, or proving will fail.`,
  );
}
/**
 * PROOF SERVER POOL.
 *
 * One proof server saturates at ~5.2 proofs/s using ~6 of 16 cores, and extra
 * concurrency against it just queues (measured: 1.17x from 4 to 24 concurrent).
 * So capacity scales by running SEVERAL servers and spreading wallets across
 * them, not by pushing harder at one.
 *
 * MN_PROOF_SERVERS takes a comma-separated list; wallets are assigned
 * round-robin by index. Falls back to the single MN_PROOF_SERVER.
 *
 * VERSION MATTERS ENORMOUSLY. `midnightnetwork/proof-server:latest` is
 * 7.0.0-rc.1 -- a ledger-7 build -- and against our ledger-v8 SDK it manages
 * 0.53 proofs/s. The correct image is `midnightntwrk/proof-server:8.1.0` (note
 * the org spelling differs by two characters) at 5.2 proofs/s, a 9.8x
 * difference. Check /version before trusting any throughput number.
 */
export const PROOF_SERVERS: string[] = (process.env.MN_PROOF_SERVERS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

export function pickProofServer(index = 0): string {
  const pool = PROOF_SERVERS.length ? PROOF_SERVERS : [PROOF_SERVER_URL];
  return pool[index % pool.length];
}

export const ARKHIA_API_KEY = process.env.ARKHIA_API_KEY ?? '';
export const ARKHIA_API_SECRET = process.env.ARKHIA_API_SECRET ?? '';
console.error(`[providers] network=${SELECTED_NET} networkId=${NETWORK_ID} indexer=${INDEXER_HTTP}`);

setNetworkId(NETWORK_ID);

/**
 * DUST cost parameters, from the deploy guide. These pad the fee estimate so a
 * transaction does not become unpayable between balancing and submission
 * (feeBlocksMargin) and cover balancing-transaction overhead
 * (additionalFeeOverhead, in SPECK -- 3e14 SPECK = 0.3 DUST).
 */
export const DUST_COST_PARAMETERS = {
  // additionalFeeOverhead: how much extra dust to reserve for balancing overhead.
  // This is HIGHLY network-dependent, per the official example-bboard CLI:
  //   - Undeployed/LOCAL network: testkit defaults to 500_000_000_000_000_000n
  //     (=500 DUST). Lower values fail with BalanceCheckOverspend on the node.
  //   - REMOTE networks (preview/preprod): that 500-DUST overhead "requires too
  //     much dust", so the bboard CLI overrides it to 1_000n (essentially nil).
  // We are on remote preview, so default to the tiny remote value. The previous
  // 3e14 (0.3 DUST) was a guess between the two regimes and could still over-
  // reserve against a single small dust coin. Override with MN_FEE_OVERHEAD_SPECK.
  additionalFeeOverhead: BigInt(
    process.env.MN_FEE_OVERHEAD_SPECK ?? (SELECTED_NET === 'qanet' ? 500_000_000_000_000_000n : 1_000n),
  ),
  // WARNING FROM THE LEDGER: feeBlocksMargin is an EXPONENT, not a block count or
  // multiplier. feesWithMargin(params, n) applies an n-block safety margin as a
  // power, so the fee grows roughly geometrically in n. The previous value of 5
  // inflated even a trivial k=14 deploy past 24 DUST and threw "could not balance
  // dust" -- it read like an out-of-funds error but was really an over-margin bug.
  // Keep this SMALL (0-2). 2 gives a modest safety buffer; 0 is the raw fee.
  feeBlocksMargin: Number(process.env.MN_FEE_BLOCKS_MARGIN ?? 2),
};

export function walletConfiguration(proofServerUrl?: string) {
  return {
    networkId: NETWORK_ID,
    indexerClientConnection: {
      indexerHttpUrl: INDEXER_HTTP,
      indexerWsUrl: INDEXER_WS,
    },
    // Arkhia ZKPaas. If preflight reports the endpoint needs an x-api-key header
    // and this config exposes no header hook, run a header-injecting proxy (see indexer_proxy.mjs) and point
    // MN_PROOF_SERVER at the local proxy instead.
    provingServerUrl: new URL(proofServerUrl ?? PROOF_SERVER_URL),
    relayURL: new URL(NODE_RPC),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema),
    costParameters: DUST_COST_PARAMETERS,
    // Sync throughput/memory tuning. SDK defaults are size 10, timeout 1ms,
    // spacing 4ms -- the 4ms inter-batch delay alone caps you at ~2,500
    // events/sec, which is painfully slow against a chain with hundreds of
    // thousands of transaction indices to traverse. Raising size and dropping
    // spacing speeds catch-up at the cost of more memory in flight, so tune with
    // test_sync.ts rather than guessing.
    batchUpdates: {
      size: Number(process.env.MN_BATCH_SIZE ?? 10),
      timeout: Number(process.env.MN_BATCH_TIMEOUT_MS ?? 1),
      spacing: Number(process.env.MN_BATCH_SPACING_MS ?? 4),
    },
  };
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------
const ROLES_NEEDED = [Roles.Zswap, Roles.Dust, Roles.NightExternal] as const;

/**
 * Accepts either a hex seed or a BIP39 mnemonic and returns seed bytes.
 *
 * DANGEROUS BEHAVIOUR THIS GUARDS AGAINST: HDWallet.fromSeed() accepts BOTH
 * 32-byte and 64-byte seeds and returns seedOk for either -- but they derive
 * DIFFERENT wallets. Verified empirically: truncating a 64-byte BIP39 seed to 32
 * bytes yields a completely different coinPublicKey, with no error anywhere. You
 * would fund one address and spend from another, and the only symptom would be a
 * wallet that never sees its funds.
 *
 * So: a mnemonic produces the FULL 64-byte BIP39 seed and is never truncated, and
 * a hex seed must be exactly 32 or 64 bytes -- anything else throws rather than
 * proceeding on a guess.
 */
function seedToBytes(secret: string): Uint8Array {
  const raw = secret.trim();

  // Mnemonic path: more than one whitespace-separated token means words.
  if (/\s/.test(raw)) {
    const words = mnemonicToWords(raw);
    if (!validateMnemonic(raw)) {
      throw new Error(
        `mnemonic failed BIP39 validation (${words.length} words). Check for typos, ` +
          `wrong word order, or a missing word. Expected 24 words normally.`,
      );
    }
    // Full 64-byte seed. Do NOT slice.
    return mnemonicToSeedSync(raw);
  }

  const hex = raw.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(
      'secret must be either a BIP39 mnemonic (space-separated words) or an even-length ' +
        'hex string. Got something that is neither.',
    );
  }
  const bytes = hex.length / 2;
  if (bytes !== 32 && bytes !== 64) {
    throw new Error(
      `hex seed is ${bytes} bytes; expected exactly 32 or 64. Refusing to guess -- ` +
        `HDWallet.fromSeed accepts odd lengths silently and would derive a DIFFERENT ` +
        `wallet than you expect, so a wrong length here is a fund-losing bug, not a warning.`,
    );
  }
  return Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

/** Derive the three role keys this harness needs from a hex seed or mnemonic. */
export function deriveKeysFromSeed(seed: string, account = 0, index = 0) {
  const res = HDWallet.fromSeed(seedToBytes(seed));
  if (res.type !== 'seedOk') {
    throw new Error(`HDWallet.fromSeed failed: ${JSON.stringify(res)}`);
  }
  const derived = res.hdWallet
    .selectAccount(account)
    .selectRoles(ROLES_NEEDED)
    .deriveKeysAt(index);
  if (derived.type !== 'keysDerived') {
    throw new Error(`key derivation failed: ${JSON.stringify(derived)}`);
  }
  // Clear root private material as soon as the role keys are out.
  res.hdWallet.clear();
  return derived.keys;
}

// ---------------------------------------------------------------------------
// Wallet construction
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Wallet state snapshots
// ---------------------------------------------------------------------------
/**
 * Sync once, restore forever after.
 *
 * A cold dust sync now costs 30-45 MINUTES for a fleet: run 3 had 3 of 16
 * wallets ready after 38 minutes, and every run in this harness has paid that
 * tax before producing a single transaction. It is the single biggest obstacle
 * to a long run, and to any iteration at all.
 *
 * Each sub-wallet exposes serializeState()/restore(), so we snapshot after a
 * genuine sync and restore from disk next time. A restored wallet resumes from
 * its saved index and only replays what happened since, rather than from
 * genesis.
 *
 * Snapshots are keyed by label AND network, and record the seed's fingerprint --
 * restoring one wallet's state into another would be a silent fund-losing
 * mix-up, so a mismatch refuses rather than guesses. They contain wallet STATE,
 * not spend keys, but they do reveal balances and history: treat as private.
 */
const SNAPSHOT_DIR = process.env.MN_STATE_DIR ?? '.wallet-state';

interface WalletSnapshot {
  label: string;
  networkId: string;
  seedFingerprint: string;
  savedAt: string;
  shielded?: string;
  unshielded?: string;
  dust?: string;
}

/** Non-reversible fingerprint so a snapshot can be bound to its seed safely. */
function seedFingerprint(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const snapshotPath = (label: string) => pathJoin(SNAPSHOT_DIR, `${label}.${NETWORK_ID}.json`);

export function loadSnapshot(label: string, seed: string): WalletSnapshot | undefined {
  try {
    const f = snapshotPath(label);
    if (!existsSync(f)) return undefined;
    const snap = JSON.parse(readFileSync(f, 'utf8')) as WalletSnapshot;
    if (snap.networkId !== NETWORK_ID) {
      console.warn(`[snapshot] ${label}: network ${snap.networkId} != ${NETWORK_ID}, ignoring`);
      return undefined;
    }
    if (snap.seedFingerprint !== seedFingerprint(seed)) {
      console.warn(`[snapshot] ${label}: seed fingerprint mismatch, ignoring (never restore ` +
        `one wallet's state into another)`);
      return undefined;
    }
    return snap;
  } catch (e: any) {
    console.warn(`[snapshot] ${label}: unreadable (${e?.message?.slice(0, 80)}), ignoring`);
    return undefined;
  }
}

/** Snapshot a SYNCED wallet. Saving an unsynced one just stores a useless state. */
export async function saveSnapshot(
  label: string, seed: string, bundle: WalletBundle,
): Promise<void> {
  try {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const w: any = bundle.wallet;
    const [shielded, unshielded, dust] = await Promise.all([
      w.shielded?.serializeState?.().catch(() => undefined),
      w.unshielded?.serializeState?.().catch(() => undefined),
      w.dust?.serializeState?.().catch(() => undefined),
    ]);
    const snap: WalletSnapshot = {
      label, networkId: NETWORK_ID, seedFingerprint: seedFingerprint(seed),
      savedAt: new Date().toISOString(), shielded, unshielded, dust,
    };
    writeFileSync(snapshotPath(label), JSON.stringify(snap));
  } catch (e: any) {
    console.warn(`[snapshot] ${label}: save failed (${e?.message?.slice(0, 80)})`);
  }
}

export interface WalletBundle {
  wallet: WalletFacade;
  zswapSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: ReturnType<typeof createKeystore>;
}

/**
 * Build and start a wallet from a hex seed. Does NOT wait for sync -- call
 * `await bundle.wallet.waitForSyncedState()` when a synced view is required
 * (deploy needs it; a fee estimate may not).
 */
export async function buildWallet(
  seed: string,
  opts: { proofServerUrl?: string; snapshotLabel?: string } = {},
): Promise<WalletBundle> {
  const keys = deriveKeysFromSeed(seed);

  const zswapSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], NETWORK_ID);

  const configuration = walletConfiguration(opts.proofServerUrl);

  // Restore from a snapshot when one exists for THIS wallet on THIS network.
  // Each sub-wallet falls back to a cold start independently, so a partial or
  // corrupt snapshot degrades to "slow" rather than "broken".
  const snap = opts.snapshotLabel ? loadSnapshot(opts.snapshotLabel, seed) : undefined;
  if (snap) {
    console.error(`[snapshot] ${opts.snapshotLabel}: restoring state saved ${snap.savedAt}` +
      ` (shielded=${!!snap.shielded} unshielded=${!!snap.unshielded} dust=${!!snap.dust})`);
  }

  const wallet = await WalletFacade.init({
    configuration: configuration as any,
    shielded: (config: any) => (snap?.shielded
      ? ShieldedWallet(config).restore(snap.shielded)
      : ShieldedWallet(config).startWithSecretKeys(zswapSecretKeys)),
    unshielded: (config: any) => (snap?.unshielded
      ? UnshieldedWallet(config).restore(snap.unshielded)
      : UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore))),
    dust: (config: any) => (snap?.dust
      ? DustWallet(config).restore(snap.dust)
      : DustWallet(config).startWithSecretKey(
          dustSecretKey,
          ledger.LedgerParameters.initialParameters().dust,
        )),
  });

  // REQUIRED, and easy to miss: WalletFacade.init() only CONSTRUCTS. Its body
  // resolves the services, calls the three sub-wallet factories, and returns
  // `new WalletFacade(...)` -- it never starts anything. facade.start() is what
  // launches the sync loops:
  //
  //     this.shielded.start(shieldedSecretKeys)
  //     this.unshielded.start()
  //     this.dust.start(dustSecretKey)
  //     this.pendingTransactionsService.start()
  //
  // Without it every sub-wallet reports progress 0/0 and isConnected=false
  // FOREVER, with no error -- which looks exactly like a WebSocket problem and
  // sends you debugging the wrong layer. The `startWithSecretKeys` /
  // `startWithPublicKey` / `startWithSecretKey` factory names are misleading:
  // they select a starting STATE, they do not begin syncing.
  await wallet.start(zswapSecretKeys, dustSecretKey);

  return { wallet, zswapSecretKeys, dustSecretKey, unshieldedKeystore };
}

/**
 * Wait for a GENUINELY synced wallet before transacting.
 *
 * The trap: FacadeState.isSynced is isStrictlyComplete() on all three sub-wallets,
 * and isStrictlyComplete() is `isConnected && |relevant - applied| === 0`. On a
 * FRESH wallet mid-sync that is 0/0 -> TRUE, so isSynced flips true before the
 * dust wallet has loaded ANY coins. Balancing then sees zero spendable dust and
 * throws "could not balance dust" even though the funded wallet has ~26 DUST.
 *
 * So we require the dust wallet to have actually advanced: appliedIndex > 0 AND
 * lag 0 AND connected. availableCoins alone is not enough to check here because a
 * brand-new wallet legitimately starts empty; we key off dust progress having
 * moved past genesis, which for a chain with dust history means real sync.
 */
export async function waitForRealSync(
  wallet: WalletFacade,
  opts: { timeoutMs?: number; requireDustCoins?: boolean; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.MN_SYNC_TIMEOUT_MS ?? 600_000);
  const requireDustCoins = opts.requireDustCoins ?? true;
  const label = opts.label ? `[${opts.label}] ` : '';
  const t0 = Date.now();
  let last = '';

  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (ok: boolean, msg?: string) => {
      if (done) return;
      done = true;
      try { sub.unsubscribe?.(); } catch { /* ignore */ }
      clearTimeout(timer);
      ok ? resolve() : reject(new Error(msg));
    };
    const timer = setTimeout(
      () => finish(false,
        `${label}wallet did not reach a real synced state within ${timeoutMs / 1000}s. ` +
        `Last: ${last}. A dust wallet stuck at applied=0 means sync has not progressed; ` +
        `check the indexer WS and give it longer (dust cold-sync ~85s on preview).`),
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
      if (last !== undefined && process.env.MN_DEBUG_SYNC === '1') console.error(`  ${label}${last}`);

      // Real sync: connected, caught up, AND actually advanced past genesis.
      const advanced = applied > 0n && connected && lag === 0n;
      if (!advanced) return;
      if (requireDustCoins && coins === 0) {
        // Advanced but no coins yet -- for a funded+registered wallet the coin
        // should be present once applied>0; keep waiting briefly in case the coin
        // event trails the progress event.
        return;
      }
      finish(true);
    });
  });
}

// ---------------------------------------------------------------------------
// midnight-js provider adapters
// ---------------------------------------------------------------------------
export class SweepWalletProvider implements WalletProvider, MidnightProvider {
  constructor(
    private readonly wallet: WalletFacade,
    private readonly zswapSecretKeys: ledger.ZswapSecretKeys,
    private readonly dustSecretKey: ledger.DustSecretKey,
  ) {}

  getCoinPublicKey() {
    return this.zswapSecretKeys.coinPublicKey;
  }
  getEncryptionPublicKey() {
    return this.zswapSecretKeys.encryptionPublicKey;
  }

  async balanceTx(
    tx: UnboundTransaction,
    ttl: Date = ttlOneHour(),
  ): Promise<ledger.FinalizedTransaction> {
    // DIAGNOSTIC (MN_DEBUG_FEE=1): before balancing, ask the dust sub-wallet what
    // fee it thinks this transaction needs, and compare to spendable dust. This
    // turns a bare "could not balance dust" into the actual numbers: estimated
    // fee vs generatedNow. If estimate >> available, the fee model is off; if
    // estimate is tiny yet it still fails, the failure is NOT about fee size.
    if (process.env.MN_DEBUG_FEE === '1') {
      try {
        const dust: any = (this.wallet as any).dust;
        const st: any = await new Promise((resolve) => {
          const sub = this.wallet.state().subscribe((x: any) => {
            resolve(x); try { sub.unsubscribe?.(); } catch { /* ignore */ }
          });
        });
        const now = new Date();
        const avail = (st?.dust?.availableCoins ?? [])
          .reduce((a: bigint, c: any) => a + BigInt(c?.generatedNow ?? 0), 0n);
        let est = 'n/a';
        try {
          // estimateFee(secretKey, transactions, ttl, currentTime)
          const fee = await dust.estimateFee(this.dustSecretKey, [tx], ttl, now);
          est = String(fee);
        } catch (e: any) {
          est = `estimateFee threw: ${e?.message?.slice(0, 120)}`;
        }
        console.error(`[fee-debug] estimatedFee=${est} SPECK  spendableDust=${avail} SPECK`);
        console.error(`[fee-debug] tx type=${(tx as any)?.constructor?.name ?? typeof tx}`);
        // Dump the tx's own imbalances if reachable -- that is the exact amount
        // the balancer must cover, independent of our estimate.
        try {
          const imb = (tx as any).imbalances?.(0, 0n);
          if (imb) {
            const entries = [...imb.entries()].map(
              ([t, v]: any) => `${t?.tag ?? t}=${v}`,
            );
            console.error(`[fee-debug] tx imbalances: ${entries.join(', ')}`);
          }
        } catch { /* imbalances shape varies */ }
      } catch (e: any) {
        console.error(`[fee-debug] probe failed: ${e?.message?.slice(0, 160)}`);
      }
    }

    const recipe = await this.wallet.balanceUnboundTransaction(
      tx as any,
      { shieldedSecretKeys: this.zswapSecretKeys, dustSecretKey: this.dustSecretKey },
      { ttl },
    );
    return await this.wallet.finalizeRecipe(recipe);
  }

  submitTx(tx: ledger.FinalizedTransaction): Promise<string> {
    return this.wallet.submitTransaction(tx) as unknown as Promise<string>;
  }
}

export function makeProofProvider(zkConfigProvider: any) {
  // If your httpClientProofProvider version accepts a headers option, prefer:
  //   return httpClientProofProvider(PROOF_SERVER_URL, zkConfigProvider, {
  //     headers: { 'x-api-key': ARKHIA_API_KEY } });
  return httpClientProofProvider(PROOF_SERVER_URL, zkConfigProvider);
}

export function makeProviders(opts: {
  contractManagedDir: string;
  circuitNames: readonly string[];
  privateStateStoreName: string;
  /**
   * The PHYSICAL LevelDB directory. MUST be unique per concurrently-running
   * wallet: LevelDB takes an exclusive OS lock on its directory (LOCK file), so
   * two wallets sharing one dir fail with "lock ... already held by process".
   * privateStateStoreName is only a sublevel key INSIDE this dir and does NOT
   * isolate the lock. Pass something per-wallet, e.g. `.mnstate/<label>`.
   */
  midnightDbName: string;
  /**
   * Unique per wallet. It is SHA-256'd into the LevelDB storage path, so two
   * fleet wallets sharing an accountId would share private state and corrupt
   * each other. Pass the wallet address or its fleet label.
   */
  accountId: string;
  walletProvider: SweepWalletProvider;
  passwordProvider?: () => string;
}) {
  const zkConfigProvider = new NodeZkConfigProvider(opts.contractManagedDir);
  return {
    privateStateProvider: levelPrivateStateProvider({
      // Physical DB dir -- unique per wallet so the LevelDB directory lock does
      // not collide across the concurrent fleet.
      midnightDbName: opts.midnightDbName,
      privateStateStoreName: opts.privateStateStoreName,
      signingKeyStoreName: `${opts.privateStateStoreName}-signing-keys`,
      accountId: opts.accountId,
      privateStoragePasswordProvider:
        opts.passwordProvider ?? (() => {
          // The private-state store (LevelDB, encrypted at rest) requires a
          // password of AT LEAST 16 characters. The old 'change-me' default was 9
          // and failed with "Password is shorter than 16 characters". This is a
          // LOCAL at-rest key for benchmark private state, not a network secret,
          // so a fixed dev default is fine; override with MN_PRIVATE_STATE_PASSWORD.
          const pw = process.env.MN_PRIVATE_STATE_PASSWORD ?? 'sweep-harness-local-dev-key';
          if (pw.length < 16) {
            throw new Error(
              `MN_PRIVATE_STATE_PASSWORD must be >= 16 chars (got ${pw.length}). ` +
              'The private-state store enforces this. Set a longer value.',
            );
          }
          return pw;
        }),
    }),
    publicDataProvider: indexerPublicDataProvider(INDEXER_HTTP, INDEXER_WS),
    zkConfigProvider,
    proofProvider: makeProofProvider(zkConfigProvider),
    walletProvider: opts.walletProvider,
    midnightProvider: opts.walletProvider,
  };
}