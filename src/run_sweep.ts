/**
 * run_sweep.ts — drive the actual load test: repeatedly call each deployed
 * benchmark contract, at a controlled rate, recording tx ids and timestamps so
 * midnight_dust_probe.py can attribute DUST + block fullness per k afterwards.
 *
 * DESIGN
 * ------
 * This does NOT compute fees itself. It creates traffic and records exactly which
 * transactions belong to which k, in a window. Measurement is the probe's job --
 * one source of truth for fees (the indexer), not two.
 *
 * Per-k call loop:
 *   - submit N calls at a target inter-arrival time
 *   - record {k, circuit, txId, submit_utc} to calls.jsonl
 *   - respect a concurrency cap (proof generation is the bottleneck, and a hosted
 *     proof server has its own rate limits -- do not fire 100 provings at once)
 *   - poll the DUST monitor's halt file; stop if the fleet is running dry
 *
 * The phases from the plan (ratchet hot, then discovery at ~55%) are driven by
 * --target-tps and --duration, set per invocation. This script is one phase; run
 * it repeatedly with different rates.
 *
 *   npm run run -- --deployments deployments.json --target-tps 2 --duration-s 600 \
 *     --calls-per-k 50 --concurrency 4 --halt-file ../HALT
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import {
  buildWallet,
  SweepWalletProvider,
  makeProviders,
} from './providers.js';

function parseArgs() {
  const a: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  return a;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Deployment {
  name: string; k: number; rounds: number; slots: number;
  managedDir: string; circuitNames: string[];
  contractAddress?: string; error?: string;
}

// Bounded-concurrency task pool: keeps at most `limit` provings in flight.
async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>) {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const my = idx++;
      await fn(items[my], my);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const args = parseArgs();
  const deployments: Deployment[] = JSON.parse(
    readFileSync(args.deployments ?? 'deployments.json', 'utf8'),
  ).filter((d: Deployment) => d.contractAddress && !d.error);
  if (deployments.length === 0) throw new Error('no successfully deployed contracts in deployments.json');

  const targetTps = Number(args['target-tps'] ?? 1);
  const durationS = Number(args['duration-s'] ?? 300);
  const callsPerK = Number(args['calls-per-k'] ?? 50);
  const concurrency = Number(args.concurrency ?? 4);
  const haltFile = args['halt-file'];
  const interArrivalMs = targetTps > 0 ? 1000 / targetTps : 0;

  const secret = process.env.MIDNIGHT_PREPROD_SEED ?? process.env.MIDNIGHT_PREPROD_MNEMONIC;
  if (!secret) throw new Error('set MIDNIGHT_PREPROD_SEED or MIDNIGHT_PREPROD_MNEMONIC');
  const { wallet, zswapSecretKeys, dustSecretKey, address } = await buildWallet(secret);
  const walletProvider = new SweepWalletProvider(wallet, zswapSecretKeys, dustSecretKey);
  console.log(`wallet ${address}`);

  const callsLog = args['calls-log'] ?? 'calls.jsonl';
  const windowStart = new Date().toISOString();
  const runMeta = {
    started_utc: windowStart, target_tps: targetTps, duration_s: durationS,
    calls_per_k: callsPerK, concurrency, contracts: deployments.map((d) => ({ name: d.name, k: d.k })),
  };
  writeFileSync(args['run-meta'] ?? 'run_meta.json', JSON.stringify(runMeta, null, 2));

  const witnesses = { wit_seed: () => new Uint8Array(32) };
  const deadline = Date.now() + durationS * 1000;
  let submitted = 0, failed = 0;

  // Reconnect to each deployed contract once.
  const connected = [];
  for (const d of deployments) {
    const Contract = (await import(`${d.managedDir}/contract/index.js`)).Contract;
    const providers = makeProviders({
      contractManagedDir: d.managedDir,
      circuitNames: d.circuitNames,
      privateStateStoreName: `bench-${d.name}`,
      walletProvider,
    });
    const handle = await findDeployedContract(providers, {
      contractAddress: d.contractAddress!,
      compiledContract: new Contract(witnesses),
      privateStateId: `bench-${d.name}`,
      initialPrivateState: {},
    });
    connected.push({ d, handle });
  }

  // Round-robin calls across all k, so every k sees the same congestion regime
  // rather than one k monopolising a quiet period and another a busy one.
  const jobs: { d: Deployment; handle: any; n: number }[] = [];
  for (let n = 0; n < callsPerK; n++) {
    for (const c of connected) jobs.push({ d: c.d, handle: c.handle, n });
  }
  console.log(`${jobs.length} calls queued across ${connected.length} contracts, ` +
    `target ${targetTps} tps, cap ${concurrency} concurrent, ${durationS}s budget`);

  const startedAt = Date.now();
  let launched = 0;

  await pool(jobs, concurrency, async (job) => {
    if (Date.now() > deadline) return;
    if (haltFile && existsSync(haltFile)) {
      console.error('halt file present -- DUST monitor tripped. Stopping submissions.');
      return;
    }
    // Pace to the target arrival rate (global, approximate).
    const expectedElapsed = launched * interArrivalMs;
    const actualElapsed = Date.now() - startedAt;
    if (expectedElapsed > actualElapsed) await sleep(expectedElapsed - actualElapsed);
    launched++;

    const submit_utc = new Date().toISOString();
    try {
      // The generated contract's entrypoint is `run()`.
      const finalized = await job.handle.callTx.run();
      const txId = finalized.public?.txId ?? finalized.public?.txHash ?? finalized.txId;
      appendFileSync(callsLog, JSON.stringify({
        k: job.d.k, name: job.d.name, slots: job.d.slots, rounds: job.d.rounds,
        txId, submit_utc,
      }) + '\n');
      submitted++;
      if (submitted % 10 === 0) console.log(`  ${submitted} submitted (${failed} failed)`);
    } catch (e: any) {
      failed++;
      appendFileSync(callsLog, JSON.stringify({
        k: job.d.k, name: job.d.name, submit_utc, error: e.message?.slice(0, 200),
      }) + '\n');
      if (failed <= 5) console.error(`  call failed (k=${job.d.k}): ${e.message?.slice(0, 120)}`);
    }
  });

  const windowEnd = new Date().toISOString();
  writeFileSync(args['run-meta'] ?? 'run_meta.json',
    JSON.stringify({ ...runMeta, ended_utc: windowEnd, submitted, failed }, null, 2));

  console.log(`\ndone. ${submitted} submitted, ${failed} failed.`);
  console.log(`window: ${windowStart} .. ${windowEnd}`);
  console.log('\nNow attribute DUST + fullness per k:');
  console.log(`  python3 midnight_dust_probe.py --endpoint <indexer> \\`);
  console.log(`    --from-time ${windowStart} --to-time ${windowEnd} \\`);
  console.log(`    --out-dir ./sweep_out --save-raw ./sweep_raw`);
  console.log('  then join calls.jsonl (txId -> k) against transactions.csv (txId -> fee, size).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
