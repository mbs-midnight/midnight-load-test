/**
 * wallet.ts -- Stagenet wallet construction on the NEWEST published 2.0 stack
 * (wallet-sdk 2.0.0-beta.3, midnight-js 5.0.0-beta.8, ledger-v9 1.0.0-rc.4).
 *
 * This is ../../stagenet/src/wallet.ts (the 2026-08-30 pins, wallet-sdk
 * 2.0.0-beta.2) ported to beta.3. Everything that changed between the two betas
 * is called out inline, because none of it is in a changelog yet and each item
 * broke the harness at run time, not compile time.
 *
 * WHAT CHANGED FROM 2.0.0-beta.2
 *   1. Sub-wallet construction. `ShieldedWallet(c).startWithSecretKeys(keys)` and
 *      `DustWallet(c).startWithSecretKey(key, dustParams)` are gone. The factories
 *      now build "forking" wallets that span the ledger-8 -> ledger-9 protocol
 *      boundary and take a SEED (`startWithSeed(seed)`) or key objects for BOTH
 *      ledger versions (`startWithKeys({ v8, v9 })`). A single ledger-9 key object
 *      is no longer accepted anywhere. Calling the old method throws
 *      `TypeError: ... startWithSecretKeys is not a function`.
 *   2. `facade.start(zswapKeys, dustKey)` became `facade.start(material)` where
 *      material is `WalletSeeds` (from `WalletSeeds.fromMasterSeed`) or
 *      `FacadeKeysByEpoch`.
 *   3. `transferTransaction(outputs, secretKeys, options)` and
 *      `initSwap(inputs, outputs, secretKeys, options)` dropped the secretKeys
 *      argument; the facade holds the keys from start(). Passing the old
 *      three-argument form silently treats the keys object as options.
 *   4. No `wallet-sdk-utilities` override is needed: beta.3 pins 1.2.2-beta.0,
 *      which has `Clock`. The beta.2 install defect is fixed here.
 *
 * WHAT DID NOT CHANGE: init/start split, the sync-progress traps, finalizeRecipe
 * proving but not signing, and the error shape. Those notes are carried over.
 */

import * as ledger from '@midnightntwrk/ledger-v9';
import {
  WalletFacade,
  WalletSeeds,
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

if (typeof (globalThis as any).WebSocket !== 'function') {
  (globalThis as any).WebSocket = WsPolyfill;
}

export const SDK_LINE = 'wallet-sdk 2.0.0-beta.3 / midnight-js 5.0.0-beta.8 / ledger-v9 1.0.0-rc.4';
export const NETWORK_ID = process.env.MN_NETWORK_ID ?? 'stagenet';
export const INDEXER_HTTP =
  process.env.MN_INDEXER_HTTP ?? 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
export const INDEXER_WS =
  process.env.MN_INDEXER_WS ?? 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws';
export const NODE_RPC = process.env.MN_NODE_RPC ?? 'wss://rpc.stagenet.shielded.tools';
export const PROOF_SERVER = process.env.MN_PROOF_SERVER ?? 'http://localhost:6310';
export const NIGHT: string = ledger.nativeToken().raw;

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
    throw new Error(`hex seed is ${bytes} bytes; expected exactly 32 or 64.`);
  }
  return Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

export function deriveKeysFromSeed(seed: string, account = 0, index = 0) {
  const res = HDWallet.fromSeed(seedToBytes(seed));
  if (res.type !== 'seedOk') throw new Error(`HDWallet.fromSeed failed: ${JSON.stringify(res)}`);
  const derived = res.hdWallet.selectAccount(account).selectRoles(ROLES_NEEDED).deriveKeysAt(index);
  if (derived.type !== 'keysDerived') throw new Error(`key derivation failed: ${JSON.stringify(derived)}`);
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
  const master = seedToBytes(seed);
  // beta.3: one call derives the three role seeds (account 0, index 0,
  // NightExternal for unshielded by default), which is exactly what the beta.2
  // HDWallet path produced. Checked below so a derivation change cannot silently
  // point the harness at a different wallet.
  const seeds = WalletSeeds.fromMasterSeed(master);
  const keys = deriveKeysFromSeed(seed);
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (!same(seeds.shielded, keys[Roles.Zswap]) || !same(seeds.dust, keys[Roles.Dust]) || !same(seeds.unshielded, keys[Roles.NightExternal])) {
    throw new Error('WalletSeeds.fromMasterSeed derives different role seeds than HDWallet account 0 / index 0 did on beta.2');
  }
  const zswapSecretKeys = ledger.ZswapSecretKeys.fromSeed(seeds.shielded);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(seeds.dust);
  const unshieldedKeystore = createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, NETWORK_ID);

  const wallet = await WalletFacade.init({
    configuration: walletConfiguration() as any,
    shielded: (c: any) => ShieldedWallet(c).startWithSeed(seeds.shielded),
    unshielded: (c: any) => UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (c: any) => DustWallet(c).startWithSeed(seeds.dust),
  } as any);
  // Still REQUIRED: init() constructs, start() launches sync. Now takes the seeds.
  await wallet.start(seeds);
  return { wallet, zswapSecretKeys, dustSecretKey, unshieldedKeystore };
}

/** beta.3 signature: no secretKeys argument; the facade holds them from start(). */
export function transferTx(b: WalletBundle, outputs: any[], opts: { ttl: Date; payFees?: boolean }) {
  return (b.wallet as any).transferTransaction(outputs, opts);
}
export function swapTx(b: WalletBundle, inputs: any, outputs: any[], opts: { ttl: Date; payFees?: boolean }) {
  return (b.wallet as any).initSwap(inputs, outputs, opts);
}

export function firstState(wallet: WalletFacade): Promise<any> {
  return new Promise((resolve) => {
    const sub = wallet.state().subscribe((st: any) => {
      resolve(st);
      try { (sub as any).unsubscribe?.(); } catch { /* ignore */ }
    });
  });
}

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

export function describeError(e: any): string {
  const seen = new Set<any>();
  const walk = (x: any, depth = 0): string => {
    if (x == null || depth > 6 || seen.has(x)) return '';
    if (typeof x === 'object') seen.add(x);
    if (typeof x === 'string') return x;
    const parts: string[] = [];
    if (x.message) parts.push(String(x.message));
    for (const k of Object.getOwnPropertySymbols(x)) {
      const s = walk((x as any)[k], depth + 1);
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
