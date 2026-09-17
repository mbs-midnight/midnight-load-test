/**
 * test_sync.ts — find which sub-wallet exhausts memory, and whether a full sync
 * is feasible at all.
 *
 * CONTEXT
 * -------
 * The indexer confirms funds exist for the address (the indexer's transactions query proves it), yet
 * the facade OOMs at ~4GB before the wallet ever reports them. The facade starts
 * three sub-wallets at once, so a crash tells you nothing about which one is
 * responsible. This starts each ALONE, with the same configuration, and samples
 * heap and sync progress over time.
 *
 * Two things it establishes:
 *   1. WHICH sub-wallet accumulates memory (almost certainly the one that must
 *      scan all chain history rather than just this address's transactions).
 *   2. WHETHER the sync rate makes a full catch-up plausible. It extrapolates from
 *      the observed rate to the target index, so you learn "3 hours per wallet"
 *      before committing a 25-wallet fleet to it.
 *
 * Run each phase in a separate process with a raised heap so one OOM does not hide
 * the others:
 *
 *   node --max-old-space-size=8192 node_modules/.bin/tsx src/test_sync.ts --which unshielded
 *   node --max-old-space-size=8192 node_modules/.bin/tsx src/test_sync.ts --which dust
 *   node --max-old-space-size=8192 node_modules/.bin/tsx src/test_sync.ts --which shielded
 *
 * Options:
 *   --which shielded|unshielded|dust   (required)
 *   --seconds 120                      how long to observe
 *   --batch-size 200 --spacing 0       override batchUpdates (defaults: size 10,
 *                                      timeout 1ms, spacing 4ms -- the default
 *                                      spacing alone caps throughput hard)
 */

import v8 from 'node:v8';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import {
  Roles,
  ShieldedWallet,
  UnshieldedWallet,
  DustWallet,
  PublicKey,
  createKeystore,
  InMemoryTransactionHistoryStorage,
  WalletEntrySchema,
} from '@midnight-ntwrk/wallet-sdk';
import {
  deriveKeysFromSeed,
  NETWORK_ID,
  INDEXER_HTTP,
  INDEXER_WS,
  DUST_COST_PARAMETERS,
} from './providers.js';

const argv = process.argv.slice(2);
const argOf = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const WHICH = argOf('which');
const SECONDS = Number(argOf('seconds') ?? 120);
const BATCH_SIZE = argOf('batch-size') ? Number(argOf('batch-size')) : undefined;
const SPACING = argOf('spacing') ? Number(argOf('spacing')) : undefined;
const TIMEOUT = argOf('batch-timeout') ? Number(argOf('batch-timeout')) : undefined;

if (!WHICH || !['shielded', 'unshielded', 'dust'].includes(WHICH)) {
  console.error('pass --which shielded|unshielded|dust');
  process.exit(1);
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(0);

function config() {
  const batchUpdates =
    BATCH_SIZE !== undefined || SPACING !== undefined || TIMEOUT !== undefined
      ? {
          ...(BATCH_SIZE !== undefined ? { size: BATCH_SIZE } : {}),
          ...(SPACING !== undefined ? { spacing: SPACING } : {}),
          ...(TIMEOUT !== undefined ? { timeout: TIMEOUT } : {}),
        }
      : undefined;

  return {
    networkId: NETWORK_ID,
    indexerClientConnection: { indexerHttpUrl: INDEXER_HTTP, indexerWsUrl: INDEXER_WS },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema),
    costParameters: DUST_COST_PARAMETERS,
    ...(batchUpdates ? { batchUpdates } : {}),
  } as any;
}

async function main() {
  const seed =
    argOf('seed') ?? process.env.MIDNIGHT_PREPROD_SEED ?? process.env.MIDNIGHT_PREPROD_MNEMONIC;
  if (!seed) throw new Error('set MIDNIGHT_PREPROD_SEED or pass --seed');

  const keys = deriveKeysFromSeed(seed);
  const cfg = config();

  console.log(`sub-wallet under test: ${WHICH}`);
  console.log(`observing for ${SECONDS}s`);
  console.log(
    `batchUpdates: ${cfg.batchUpdates ? JSON.stringify(cfg.batchUpdates) : 'SDK defaults (size 10, timeout 1ms, spacing 4ms)'}`,
  );
  // ESM has no require(); node:v8 is imported at the top.
  console.log(`heap limit: ${mb(v8.getHeapStatistics().heap_size_limit)} MB`);
  console.log('');

  let api: any;
  let startArg: any;
  if (WHICH === 'shielded') {
    const zk = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
    api = ShieldedWallet(cfg).startWithSecretKeys(zk);
    startArg = zk;
  } else if (WHICH === 'unshielded') {
    const ks = createKeystore(keys[Roles.NightExternal], NETWORK_ID);
    api = UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(ks));
    startArg = undefined;
  } else {
    const dk = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
    api = DustWallet(cfg).startWithSecretKey(dk, ledger.LedgerParameters.initialParameters().dust);
    startArg = dk;
  }

  let peakHeap = 0;
  let samples = 0;
  const t0 = Date.now();
  let firstApplied: bigint | null = null;
  let lastApplied = 0n;
  let lastRelevant = 0n;
  let connected = false;

  const errors: string[] = [];
  process.on('unhandledRejection', (r) => {
    const m = String((r as any)?.message ?? r).slice(0, 300);
    if (!errors.includes(m)) { errors.push(m); console.log(`  [unhandledRejection] ${m}`); }
  });
  process.on('uncaughtException', (e) => {
    const m = String(e?.message ?? e).slice(0, 300);
    if (!errors.includes(m)) { errors.push(m); console.log(`  [uncaughtException] ${m}`); }
  });

  // Observer form, so a stream failure is reported instead of silently ending
  // the subscription. A dead sync stream leaves progress at 0/0 which, combined
  // with isConnected=true, satisfies isStrictlyComplete() and masquerades as
  // "caught up with nothing to do".
  const sub = api.state.subscribe({
    error: (err: any) => {
      const m = String(err?.message ?? JSON.stringify(err)).slice(0, 400);
      errors.push(m);
      console.log(`  [state stream ERROR] ${m}`);
    },
    complete: () => console.log('  [state stream completed] sync will not progress further'),
    next: (st: any) => {
    const pr = st?.progress ?? st?.state?.progress;
    if (pr) {
      lastApplied = BigInt(pr.appliedIndex ?? 0);
      lastRelevant = BigInt(pr.highestRelevantWalletIndex ?? 0);
      connected = Boolean(pr.isConnected);
      if (firstApplied === null && lastApplied > 0n) firstApplied = lastApplied;
    }
    },
  });

  const ticker = setInterval(() => {
    const heap = process.memoryUsage().heapUsed;
    peakHeap = Math.max(peakHeap, heap);
    samples++;
    const secs = (Date.now() - t0) / 1000;
    const lag = lastRelevant > lastApplied ? lastRelevant - lastApplied : 0n;
    console.log(
      `  t=${secs.toFixed(0).padStart(4)}s  heap=${mb(heap).padStart(5)}MB  ` +
        `applied=${lastApplied}  relevant=${lastRelevant}  lag=${lag}  connected=${connected}`,
    );
  }, 5000);

  try {
    // start() resolves once the sync loop is running, not once it is caught up.
    await (startArg === undefined ? api.start() : api.start(startArg));
    console.log('  start() resolved -- sync loop running\n');
  } catch (e: any) {
    console.error(`  start() threw: ${e.message?.slice(0, 200)}`);
  }

  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  clearInterval(ticker);
  try { sub.unsubscribe?.(); } catch { /* ignore */ }

  const elapsed = (Date.now() - t0) / 1000;
  const progressed = firstApplied !== null ? lastApplied - firstApplied : 0n;
  const rate = elapsed > 0 ? Number(progressed) / elapsed : 0;

  console.log('\n===== result =====');
  console.log(`sub-wallet:        ${WHICH}`);
  console.log(`elapsed:           ${elapsed.toFixed(0)}s`);
  console.log(`peak heap:         ${mb(peakHeap)} MB over ${samples} samples`);
  console.log(`appliedIndex:      ${lastApplied}`);
  console.log(`target (relevant): ${lastRelevant}`);
  console.log(`rate:              ${rate.toFixed(1)} index/s`);

  if (lastRelevant > lastApplied && rate > 0) {
    const remaining = Number(lastRelevant - lastApplied);
    const etaS = remaining / rate;
    console.log(
      `ETA to catch up:   ${(etaS / 60).toFixed(1)} min  (${remaining} indices remaining)`,
    );
    console.log('');
    console.log('Multiply that ETA by your fleet size -- every wallet pays it on a cold');
    console.log('start. If the number is unacceptable, serialize()/restore() per wallet is');
    console.log('the way out: sync once, persist the state, restore on later runs.');
  } else if (lastRelevant === lastApplied && connected) {
    console.log('status:            caught up (lag 0)');
  } else if (!connected) {
    console.log('status:            never connected -- check the indexer WebSocket URL and the WebSocket polyfill');
  }

  if (errors.length) {
    console.log('');
    console.log(`ERRORS CAPTURED (${errors.length}) -- these are normally swallowed:`);
    for (const e of errors.slice(0, 5)) console.log(`  - ${e}`);
    console.log('A failed sync stream leaves progress at 0/0, which isStrictlyComplete()');
    console.log('reads as "synced". That is why a dead stream looks like an empty wallet.');
  }

  if (peakHeap > 3.5 * 1024 * 1024 * 1024) {
    console.log('');
    console.log('MEMORY: peak heap approached the default ~4GB ceiling. This is the');
    console.log('sub-wallet responsible for the OOM. Raise --max-old-space-size for now,');
    console.log('but note a fleet cannot afford this per wallet -- persistence or a');
    console.log('narrower sync scope is the real fix.');
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });