/**
 * load_test.ts — fleet load generator. Replaces run_sweep.ts (which was a paced
 * SEQUENTIAL driver and could not simulate concurrent users).
 *
 * THE CONCURRENCY MODEL, AND WHY IT IS SHAPED THIS WAY
 * ----------------------------------------------------
 * One wallet = one lane. Concurrent transactions from a single wallet balance
 * against the same DUST UTXOs; two in-flight calls pick overlapping dust, one
 * confirms, the other dies as a double-spend. So:
 *
 *   - Each wallet runs a strictly serialized loop: prove -> submit -> log -> next.
 *   - Parallelism comes ONLY from the number of wallets. "Simulate 300 users"
 *     means "run with 300 funded wallets in wallets.json".
 *   - Proving is the slow stage (seconds to tens of seconds at k=14..19), so the
 *     number of wallets currently in prove is your in-flight proving depth. To
 *     exploit Arkhia's "up to 20 prove batches in parallel", you need >= 20
 *     wallets; beyond ~20 concurrently-proving wallets you are queueing at their
 *     end, which is itself worth measuring (watch prove_ms grow with fleet size).
 *
 * Throughput ~= wallets / prove_seconds. 20 wallets at 30s proofs ~= 0.67 tx/s
 * ~= 4 tx per 6s block. Plan fleet size from the prove_ms you observe, not hope.
 *
 * WALLETS
 * -------
 * wallets.json: [{ "label": "w000", "seed": "<64 hex>" }, ...]
 * Every wallet needs its own NIGHT position and DUST registration (DUST is
 * non-transferable). Generate seeds however you like; fund and delegate each;
 * verify with dust_budget_monitor.py before starting. The generator refuses to
 * start any wallet the halt file has flagged.
 *
 * USAGE
 * -----
 *   npm run load -- --deployments deployments.json --wallets wallets.json \
 *     --duration-s 1800 --target-tps 3 --halt-file ../HALT \
 *     --mix "14:1,16:1,17:1,19:1"
 *
 * --target-tps caps the global submission rate (token bucket). Omit it to run
 * flat-out and discover the fleet's natural ceiling.
 * --mix weights calls across k values (default: uniform round-robin).
 *
 * Output: calls.jsonl (one line per attempt: k, wallet, txId, prove+submit
 * timings), run_meta.json (window + config), live stats every 15s.
 * Fee attribution stays in midnight_dust_probe.py + join_sweep.py, as before.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import {
  findDeployedContract,
  submitCallTxAsync,
  createCallTxOptions,
} from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { pathToFileURL } from 'node:url';
import { join as pathJoin } from 'node:path';
import { writeFileSync as wfs, existsSync as fexists } from 'node:fs';
import { buildWallet, SweepWalletProvider, makeProviders ,
  waitForRealSync, PROOF_SERVER_URL,
} from './providers.js';


/**
 * Unwrap an SDK error into something actionable.
 *
 * "Transaction submission error" and "Failed to prove transaction" are catch-all
 * wrappers. The real reason -- node rejection text, HTTP status, Effect _tag --
 * lives in a .cause chain AND, for anything that came through Effect's
 * runPromise, under a well-known SYMBOL rather than .cause. Walking only .cause
 * stops at the useless wrapper.
 *
 * This is how the flood-side `Custom error: 192` was finally identified as
 * MalformedError::InputsSignaturesLengthMismatch. This tool still logs bare
 * `e.message`, which is why its intermittent ~5-15% submission failures have
 * never been diagnosed.
 */
function describeError(e: any): string {
  const parts: string[] = [];
  const seen = new Set<any>();
  const effectCause = (o: any): any => {
    for (const sym of Object.getOwnPropertySymbols(o ?? {})) {
      if (String(sym).includes('Cause')) return (o as any)[sym];
    }
    return undefined;
  };
  const walk = (cur: any, depth: number, path: string) => {
    if (!cur || depth > 8 || seen.has(cur)) return;
    seen.add(cur);
    if (typeof cur === 'string') { parts.push(`${path} "${cur.slice(0, 200)}"`); return; }
    const bits: string[] = [];
    if (cur.message) bits.push(String(cur.message).slice(0, 250));
    if (cur._tag) bits.push(`_tag=${cur._tag}`);
    if (cur.name && cur.name !== 'Error') bits.push(`name=${cur.name}`);
    if (cur.status) bits.push(`status=${cur.status}`);
    if (cur.code) bits.push(`code=${cur.code}`);
    if (cur.response?.status) bits.push(`http=${cur.response.status}`);
    if (typeof cur.error === 'string') bits.push(`error=${cur.error.slice(0, 250)}`);
    if (typeof cur.defect === 'string') bits.push(`defect=${cur.defect.slice(0, 250)}`);
    if (bits.length) parts.push(`${path} ${bits.join('  ')}`);
    for (const [k, v] of [['cause', cur.cause], ['error', cur.error], ['defect', cur.defect],
                          ['effect', effectCause(cur)]] as const) {
      if (v && typeof v === 'object') walk(v, depth + 1, `${path}.${k}`);
    }
  };
  walk(e, 0, '[e]');
  return parts.join(' | ') || String(e);
}


/**
 * Transient ledger rejections worth one rebuild.
 *
 * Codes are the node's own, from midnight-node/ledger/src/versions/common/
 * types.rs, reaching us as `1010: Invalid Transaction: Custom error: N`.
 *
 *   170 InvalidDustSpendProof   -- dust proof built against a stale dust-tree view
 *   171 OutOfDustValidityWindow -- same family
 *   228 IntentTtlExpired        -- build+prove outran the TTL; a rebuild refreshes it
 *
 * Retries here are EXPENSIVE -- a k=18/19 call is 30-200s of proving -- so the
 * budget is deliberately tighter than the flood side's. Deterministic rejections
 * (192 signature mismatch, 138 overspend) are never retried: that would burn
 * minutes of proving to reproduce a construction bug.
 */
const RETRYABLE_LEDGER_CODES = new Map<number, string>([
  [170, 'InvalidDustSpendProof'],
  [171, 'OutOfDustValidityWindow'],
  [228, 'IntentTtlExpired'],
]);

function retryableCode(detail: string): number | null {
  const m = /Custom error:\s*(\d+)/.exec(detail);
  if (!m) return null;
  const code = Number(m[1]);
  return RETRYABLE_LEDGER_CODES.has(code) ? code : null;
}


/**
 * Bound a call that has no timeout of its own.
 *
 * Neither submitCallTxAsync nor callTx.run() has an internal deadline, and the
 * flood side proved these can park forever (a 240s run still alive after 31
 * minutes with a lane stuck in an await). A hung lane cannot be rescued by any
 * supervisor -- it is blocked inside the await -- so without this a single hang
 * silently removes a wallet for the rest of the run.
 *
 * The budget is deliberately large here: a k=18/19 proof legitimately takes
 * 30-200s, so this only ever catches a genuine wedge.
 */
class StageTimeout extends Error {}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StageTimeout(`stage '${what}' exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseArgs() {
  const a: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  return a;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Deployment {
  name: string; k: number; rounds: number; slots: number;
  managedDir: string; circuitNames: string[]; contractAddress?: string; error?: string;
}
interface WalletSpec { label: string; seed: string; }

// ---------------------------------------------------------------------------
// Global token-bucket rate limiter. Wallets take a token before submitting, so
// the fleet's aggregate submission rate respects --target-tps regardless of size.
// ---------------------------------------------------------------------------
class RateGovernor {
  private tokens: number;
  private lastRefill = Date.now();
  constructor(private readonly tps: number, private readonly burst = Math.max(1, Math.ceil(tps))) {
    this.tokens = this.burst;
  }
  async take(): Promise<void> {
    if (this.tps <= 0) return; // unlimited
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastRefill) / 1000) * this.tps);
      this.lastRefill = now;
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      await sleep((1 - this.tokens) / this.tps * 1000);
    }
  }
}

// Weighted pick over deployments, e.g. --mix "14:1,16:2,19:1".
function makePicker(deployments: Deployment[], mixArg?: string) {
  let weighted: Deployment[] = [];
  if (mixArg) {
    const w = new Map(mixArg.split(',').map((p) => {
      const [k, wt] = p.split(':');
      return [Number(k), Number(wt ?? 1)] as const;
    }));
    for (const d of deployments) {
      const n = w.get(d.k) ?? 0;
      for (let i = 0; i < n; i++) weighted.push(d);
    }
    if (weighted.length === 0) throw new Error(`--mix matched no deployed k values`);
  } else {
    weighted = deployments;
  }
  let i = 0;
  return () => weighted[i++ % weighted.length];
}

// Live stats.
const stats = {
  submitted: 0, failed: 0,
  byK: new Map<number, { n: number; fail: number; proveMs: number[] }>(),
  proving: 0, // wallets currently in prove+submit -- your in-flight depth
  retried: 0, // transient ledger rejections that were rebuilt
};
function record(k: number, ok: boolean, proveMs?: number) {
  if (!stats.byK.has(k)) stats.byK.set(k, { n: 0, fail: 0, proveMs: [] });
  const s = stats.byK.get(k)!;
  if (ok) { stats.submitted++; s.n++; if (proveMs != null) s.proveMs.push(proveMs); }
  else { stats.failed++; s.fail++; }
}
function p50(v: number[]) { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }


/**
 * Fail fast if the proof server is not up.
 *
 * Every transaction here needs it -- even an unshielded transfer, because the
 * DUST fee spend is a proven DustSpend. When the container was down, a run
 * produced 61 consecutive failures reading
 *   'check' returned an error: FetchError: request to http://127.0.0.1:6300/check failed
 * with nothing pointing at the cause, after paying a full multi-minute wallet
 * warm-up first. Ten seconds here saves that.
 */
async function assertProofServer(url: string): Promise<void> {
  const base = url.replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(10_000),
    } as any);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`  proof server ok at ${base}`);
  } catch (e: any) {
    throw new Error(
      `proof server unreachable at ${base}/health (${e?.message ?? e}). ` +
      `Every transaction needs it, including unshielded transfers (the DUST fee ` +
      `spend is proven). Start it with: docker start <proof-server-container>, ` +
      `then re-run. Refusing to burn a wallet warm-up on a run that cannot succeed.`,
    );
  }
}

async function main() {
  const args = parseArgs();
  const durationS = Number(args['duration-s'] ?? 600);
  const targetTps = Number(args['target-tps'] ?? 0); // 0 = flat out
  const haltFile = args['halt-file'];
  const callsLog = args['calls-log'] ?? 'calls.jsonl';

  const deployments: Deployment[] = JSON.parse(readFileSync(args.deployments ?? 'deployments.json', 'utf8'))
    .filter((d: Deployment) => d.contractAddress && !d.error);
  if (!deployments.length) throw new Error('no deployed contracts in deployments.json');

  // NOTE ON THE DEFAULT: wallets.json holds the ORIGINAL hex-seeded roster
  // (w000..w024) which was never funded on preview. The funded fleet is the
  // mnemonic roster in fleet.json (w001..w015 have NIGHT). Defaulting to
  // wallets.json silently runs an unfunded fleet, so say so loudly.
  const walletsFile = args.wallets ?? 'wallets.json';
  if (!args.wallets) {
    console.warn(`[load_test] no --wallets given, defaulting to '${walletsFile}'. ` +
      `On preview the FUNDED roster is fleet.json -- pass --wallets fleet.json.`);
  }
  let wallets: WalletSpec[] = JSON.parse(readFileSync(walletsFile, 'utf8'));
  if (!wallets.length) throw new Error('wallets.json is empty');

  // --max-wallets N: run only the FIRST N wallets from the file. Essential for the
  // calibration ladder (2 -> 4 -> 8 -> 14) and for smoke tests, without keeping
  // separate fleet files. Each wallet spins up 3 sub-wallet sync loops and pays
  // the ~85s cold dust-sync; booting all of them at once is what OOMs Node.
  const maxWallets = Number(args['max-wallets'] ?? 0);
  const totalInFile = wallets.length;
  if (maxWallets > 0 && maxWallets < wallets.length) {
    wallets = wallets.slice(0, maxWallets);
  }

  // --stagger-ms M: delay each wallet's startup by M ms so their cold syncs do not
  // all peak memory simultaneously. 0 = all at once (fine for small fleets).
  const staggerMs = Number(args['stagger-ms'] ?? 0);
  // --async-submit: fire-and-forget. callTx.run() (the default) BLOCKS until the
  // tx is included in a block (~block-time, ~30s on preview), so per-wallet
  // throughput is capped at ~1 tx/block regardless of proving speed -- it
  // measures CONFIRMATION latency. --async-submit uses submitCallTxAsync, which
  // returns right after prove+submit, so workers keep firing and you actually
  // stress the proof server + fill blocks. Use async for throughput/fullness;
  // use the default (blocking) for end-to-end confirmation latency.
  const asyncSubmit = 'async-submit' in args;

  console.log(`${wallets.length}/${totalInFile} wallets, ${deployments.length} contracts ` +
    `(k = ${deployments.map((d) => d.k).join(', ')})` +
    (staggerMs ? `  stagger=${staggerMs}ms` : ''));
  if (wallets.length < 20) {
    console.log(`note: with ${wallets.length} wallets you cannot fill Arkhia's 20 parallel ` +
      `prove lanes; in-flight proving depth maxes at ${wallets.length}.`);
  }

  await assertProofServer(PROOF_SERVER_URL);

  const governor = new RateGovernor(targetTps);
  const pick = makePicker(deployments, args.mix);
  // Compact witnesses return a TUPLE [newPrivateState, value], NOT the bare
  // value. The runtime reads [0] as private state, [1] as the Bytes<32> value.
  // A bare Uint8Array threw "wit_seed return value ... expected Bytes<32> but
  // received 0" (it read [1] of a non-tuple). No private state here, so pass
  // ctx.privateState through unchanged.
  const witnesses = { wit_seed: (ctx: any) => [ctx.privateState, new Uint8Array(32)] };
  // THE DEADLINE MUST NOT START BEFORE THE WALLETS DO.
  //
  // This was previously `Date.now() + durationS * 1000` evaluated here, before
  // any wallet had synced. A wallet cold-sync costs minutes, so --duration-s 600
  // could elapse entirely during warm-up and the run would submit nothing --
  // and --duration-s 7200 for a 2h run would silently deliver well under 2h of
  // load. Instead every worker reports in once it is ready (or has failed), and
  // the clock starts when the last one does, so --duration-s means what it says.
  // A k=18/19 proof can legitimately run minutes; this only catches a wedge.
  const callTimeoutMs = Number(args['call-timeout-ms'] ?? 600_000);
  const graceS = Number(args['hard-stop-grace-s'] ?? 300);
  let deadline = Number.MAX_SAFE_INTEGER;
  let windowStart = new Date().toISOString();
  let readyOrFailed = 0;
  let releaseStart!: () => void;
  const startGate = new Promise<void>((r) => { releaseStart = r; });
  const noteReady = () => {
    if (++readyOrFailed < wallets.length) return;
    deadline = Date.now() + durationS * 1000;
    windowStart = new Date().toISOString();
    // Backstop: guarantees the run ends even if a lane is wedged somewhere with
    // no timeout of its own. unref'd so it never holds an otherwise-done process.
    const hardStop = setTimeout(() => {
      console.error(`\nHARD STOP: ${graceS}s past the deadline -- forcing exit. ` +
        `calls.jsonl on disk is complete.`);
      process.exit(0);
    }, durationS * 1000 + graceS * 1000);
    hardStop.unref();
    console.log(`\nall ${wallets.length} wallet(s) settled -- load window starts now ` +
      `(${durationS}s, until ${new Date(deadline).toISOString()})`);
    releaseStart();
  };

  writeFileSync(args['run-meta'] ?? 'run_meta.json', JSON.stringify({
    started_utc: windowStart, duration_s: durationS, target_tps: targetTps || 'unlimited',
    wallets: wallets.length, mix: args.mix ?? 'uniform',
    contracts: deployments.map((d) => ({ name: d.name, k: d.k, slots: d.slots })),
  }, null, 2));

  // Per-wallet worker: build wallet, connect to every contract once, then a
  // strictly serialized call loop until the deadline. All parallelism is here,
  // across workers -- never within one.
  // Track every started wallet so main() can stop their background sync loops at
  // the end -- otherwise the process hangs after the run completes (the facade's
  // indexer WS + node RPC keep the event loop alive), exactly like deploy did.
  const startedWallets: any[] = [];

  async function worker(spec: WalletSpec) {
    let bundle;
    try {
      bundle = await buildWallet(spec.seed);
      // Same trap as deploy: buildWallet returns before sync. Each fleet wallet
      // must genuinely sync its dust before it can pay fees, or the first tx on
      // that lane throws "could not balance dust". This is the ~85s-per-wallet
      // cold-sync cost noted earlier; serialize()/restore() is the optimization
      // if fleet warm-up gets painful.
      await waitForRealSync(bundle.wallet, { label: spec.label, requireDustCoins: true });
      startedWallets.push(bundle.wallet);
    } catch (e: any) {
      console.error(`[${spec.label}] wallet build/sync failed: ${describeError(e).slice(0, 300)}`);
      noteReady();          // still counts toward the barrier, or it never opens
      return;
    }
    const wp = new SweepWalletProvider(bundle.wallet, bundle.zswapSecretKeys, bundle.dustSecretKey);

    const handles = new Map<string, any>();
    for (const d of deployments) {
      // Same ESM-marker + file-URL loading as deploy.ts, and build a proper
      // CompiledContract (not `new Contract(...)`). Without the marker tsx loads
      // the ESM contract as CJS and named runtime exports vanish; without the
      // CompiledContract wrapper the SDK's context slot is unstamped and throws
      // "Cannot read properties of undefined (reading 'ctor')".
      const contractDir = pathJoin(d.managedDir, 'contract');
      const marker = pathJoin(contractDir, 'package.json');
      if (!fexists(marker)) wfs(marker, JSON.stringify({ type: 'module' }, null, 2));
      const idxPath = pathJoin(contractDir, 'index.js');
      const Contract = (await import(pathToFileURL(idxPath).href)).Contract;
      const providers = makeProviders({
        contractManagedDir: d.managedDir,
        circuitNames: d.circuitNames,
        // PHYSICAL LevelDB dir, unique per wallet+contract. This is the real lock
        // isolation: LevelDB takes an exclusive OS lock per directory, so every
        // concurrently-open wallet needs its own path or the 2nd hits
        // "lock ... already held by process". Under .mnstate/ (gitignored).
        midnightDbName: `.mnstate/${spec.label}-${d.name}`,
        // Sublevel key inside that dir (not a lock boundary on its own).
        privateStateStoreName: `bench-${d.name}-${spec.label}`,
        // Unique per wallet: hashed into the LevelDB path, so a shared value
        // would make fleet wallets clobber each other's private state.
        accountId: `${spec.label}`,
        walletProvider: wp,
      });
      // Casts for the same reason as deploy.ts: dynamic import erases the
      // contract generics. These circuits declare no private state.
      const CC = CompiledContract as any;
      const compiled = CC.make(d.name, Contract).pipe(
        CC.withWitnesses(witnesses),
        CC.withCompiledFileAssets(contractDir),
      );
      const found = await findDeployedContract(providers as any, {
        contractAddress: d.contractAddress!,
        compiledContract: compiled as any,
      } as any);
      // Keep everything the async path needs at call time: providers + compiled
      // contract + address, plus the blocking callTx interface for default mode.
      handles.set(d.name, {
        callTx: (found as any).callTx,
        providers,
        compiled,
        contractAddress: d.contractAddress!,
      });
    }

    // Barrier: do not start the clock (or the load) until every wallet is up, so
    // all lanes get the same window and warm-up is excluded from it.
    noteReady();
    await startGate;

    while (Date.now() < deadline) {
      if (haltFile && existsSync(haltFile)) return; // DUST monitor tripped
      const d = pick();
      await governor.take();
      const submit_utc = new Date().toISOString();
      const t0 = Date.now();
      stats.proving++;
      try {
        const h = handles.get(d.name)!;
        let txId: string | undefined;
        // Bounded rebuild on transient rejections (see RETRYABLE_LEDGER_CODES).
        // A stale dust proof wastes the whole k=18/19 proof either way, so one
        // rebuild is cheaper than discarding the data point.
        let attemptsLeft = Math.max(1, Number(args.retries ?? 2));
        // Stage timing to explain where a call's wall-clock actually goes. The
        // proof server logs ~2.2s per /prove, but observed per-call latency is
        // 30-200s -- so most of the time is NOT proving. These stages localize it:
        //   optionsMs  = building CallTxOptions (should be ~0)
        //   submitMs   = the whole submitCallTxAsync: balance + witness-exec +
        //                prove (the ~2.2s slice) + submit. If submitMs >> 2.2s,
        //                the overhead is client-side (balancing/state refresh),
        //                NOT the proof server. Cross-reference the proof-server
        //                log timestamp to subtract the true proving slice.
        let optionsMs = 0, submitMs = 0;
        for (;;) {
          try {
            if (asyncSubmit) {
              const tOpt = Date.now();
              const options = createCallTxOptions(
                h.compiled as any, 'run' as any, h.contractAddress as any,
                undefined as any, undefined as any, [] as any,
              );
              optionsMs = Date.now() - tOpt;
              const tSub = Date.now();
              const submitted: any = await withTimeout(
                submitCallTxAsync(h.providers as any, options as any), callTimeoutMs, 'callTx');
              submitMs = Date.now() - tSub;
              txId = submitted?.txId;
            } else {
              const tRun = Date.now();
              const finalized: any = await withTimeout(
                h.callTx.run(), callTimeoutMs, 'callTx.run');
              submitMs = Date.now() - tRun;
              txId = finalized.public?.txId ?? finalized.public?.txHash ?? finalized.txId;
            }
            break;
          } catch (inner: any) {
            if (inner instanceof StageTimeout) throw inner;   // free the lane, do not retry
            const detail = describeError(inner);
            const code = retryableCode(detail);
            if (code === null || --attemptsLeft <= 0) throw inner;
            stats.retried++;
            console.error(`[${spec.label}] k=${d.k} ${code} ` +
              `${RETRYABLE_LEDGER_CODES.get(code)} -- rebuilding call`);
            await sleep(2000);
          }
        }
        const proveSubmitMs = Date.now() - t0;
        appendFileSync(callsLog, JSON.stringify({
          k: d.k, name: d.name, slots: d.slots, wallet: spec.label,
          txId, submit_utc, prove_submit_ms: proveSubmitMs,
          options_ms: optionsMs, submit_ms: submitMs,
          mode: asyncSubmit ? 'async' : 'blocking',
        }) + '\n');
        record(d.k, true, proveSubmitMs);
      } catch (e: any) {
        appendFileSync(callsLog, JSON.stringify({
          k: d.k, name: d.name, wallet: spec.label, submit_utc,
          error: describeError(e).slice(0, 600),
        }) + '\n');
        record(d.k, false);
      } finally {
        stats.proving--;
      }
    }
  }

  const ticker = setInterval(() => {
    const perK = [...stats.byK.entries()].sort((a, b) => a[0] - b[0])
      .map(([k, s]) => `k${k}:${s.n}ok/${s.fail}f p50=${(p50(s.proveMs) / 1000).toFixed(1)}s`)
      .join('  ');
    console.log(`[${new Date().toISOString().slice(11, 19)}] in-flight=${stats.proving} ` +
      `submitted=${stats.submitted} failed=${stats.failed}  ${perK}`);
  }, 15000);

  // Stagger startups if requested: spreading the cold syncs avoids a simultaneous
  // memory peak across the fleet (the OOM cause at large fleet sizes).
  await Promise.all(
    wallets.map(async (w, i) => {
      if (staggerMs) await sleep(i * staggerMs);
      return worker(w);
    }),
  );
  clearInterval(ticker);

  const windowEnd = new Date().toISOString();
  const meta = JSON.parse(readFileSync(args['run-meta'] ?? 'run_meta.json', 'utf8'));
  writeFileSync(args['run-meta'] ?? 'run_meta.json', JSON.stringify({
    ...meta,
    // started_utc is the LOAD window start (post warm-up), which is what the
    // fee/fullness probe must be given -- not process start.
    started_utc: windowStart,
    ended_utc: windowEnd, submitted: stats.submitted, failed: stats.failed,
  }, null, 2));

  console.log(`\ndone. ${stats.submitted} submitted, ${stats.failed} failed, ` +
    `${stats.retried} transient retry(ies).`);
  console.log(`window: ${windowStart} .. ${windowEnd}`);
  console.log('\nAttribute fees + fullness:');
  console.log(`  python3 midnight_dust_probe.py --endpoint <indexer> \\`);
  console.log(`    --from-time ${windowStart} --to-time ${windowEnd} --out-dir sweep_out`);
  console.log('  python3 join_sweep.py --calls calls.jsonl --transactions sweep_out/transactions.csv \\');
  console.log('    --blocks sweep_out/blocks.csv');

  // Stop every wallet's background sync loops so the process can exit. Without
  // this the run finishes but the terminal hangs on the last line.
  console.log(`\nstopping ${startedWallets.length} wallet(s)...`);
  // Bounded shutdown. Without the timeout this never settles, main() never
  // resolves, and the process.exit(0) below never runs -- observed as a run
  // still alive 19 hours later, still holding indexer connections open.
  await Promise.race([
    Promise.allSettled(startedWallets.map((w) => {
      try { return Promise.resolve(w?.stop?.()); } catch { return Promise.resolve(); }
    })),
    sleep(15_000),
  ]);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });