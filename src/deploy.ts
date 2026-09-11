/**
 * deploy.ts — deploy each compiled benchmark contract to Preprod and record the
 * deploy transaction's DUST cost against its k.
 *
 * Reads a manifest produced from sweep_compile.py so it knows which k each
 * contract landed on. Deploys them cheapest-k first (so a wallet-funding problem
 * surfaces on a cheap tx, not an expensive one), writes deployments.json.
 *
 *   npm run deploy -- --manifest ../sweep/ladder.json --managed-root ../circuits/managed
 *
 * DEPLOY vs CALL: deploying establishes the contract; the sweep's per-call fees
 * come later in run_sweep.ts. Deploy cost itself is a useful datapoint (it also
 * carries the verifier key on-chain), so we capture it.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import {
  buildWallet,
  waitForRealSync,
  SweepWalletProvider,
  makeProviders,
} from './providers.js';

interface ManifestEntry {
  name: string;       // e.g. BenchR2382_S0
  k: number;
  rounds: number;
  slots: number;
  managedDir: string; // path to compiled managed/<contract> dir with keys/ and zkir/
  circuitNames: string[];
}

function parseArgs() {
  const a: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  }
  return a;
}

async function loadContractModule(managedDir: string) {
  // The compiler emits a JS contract module under managed/<name>/contract/index.js.
  const idx = join(managedDir, 'contract', 'index.js');
  if (!existsSync(idx)) {
    throw new Error(`no contract module at ${idx} -- did you run \`compact compile\` for this variant?`);
  }

  // The generated index.js is written in ESM syntax (top-level `import * as
  // __compactRuntime ...`), but the compiler does NOT drop a package.json beside
  // it. Node's rule: a .js file is CommonJS unless the nearest parent package.json
  // says "type":"module". Without that marker the file loads as CJS, the ESM
  // interop returns a mangled namespace, and named runtime exports come back
  // undefined -- surfacing as `checkRuntimeVersion is not a function` even though
  // the runtime version is correct. Drop an ESM marker next to the contract so it
  // loads as the ESM it actually is. Written once per contract dir; idempotent.
  const contractDir = join(managedDir, 'contract');
  const pkgMarker = join(contractDir, 'package.json');
  if (!existsSync(pkgMarker)) {
    writeFileSync(pkgMarker, JSON.stringify({ type: 'module' }, null, 2));
    console.log(`  (wrote ${pkgMarker} to load the contract as ESM)`);
  }

  const mod = await import(pathToFileURL(idx).href);
  const Contract = mod.Contract ?? mod.default?.Contract ?? mod.default;
  if (!Contract) throw new Error(`could not find Contract export in ${idx}`);
  return Contract;
}

async function main() {
  const args = parseArgs();
  const manifestPath = args.manifest ?? '../sweep/ladder.json';
  const manifest: ManifestEntry[] = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.sort((x, y) => x.k - y.k); // cheapest first

  const secret = process.env.MIDNIGHT_PREPROD_SEED ?? process.env.MIDNIGHT_PREPROD_MNEMONIC;
  if (!secret) throw new Error('set MIDNIGHT_PREPROD_SEED or MIDNIGHT_PREPROD_MNEMONIC');

  const { wallet, zswapSecretKeys, dustSecretKey } = await buildWallet(secret);

  // CRITICAL: buildWallet starts sync but returns immediately. Deploying now would
  // balance against an unsynced dust wallet -- which reports isSynced=true at 0/0
  // (the false-complete) and has ZERO spendable dust, throwing "could not balance
  // dust" despite a funded wallet. Wait for the dust wallet to genuinely advance.
  console.log('waiting for real dust sync before deploying (dust cold-sync ~85s)...');
  await waitForRealSync(wallet, { label: 'deploy', requireDustCoins: true });
  console.log('wallet truly synced -- dust coins available.');
  // Stable per-wallet id for private-state isolation. The coin public key is
  // wallet-specific and stable, so it works as an accountId without needing an
  // address-format round trip.
  const walletAddressForStore = String(zswapSecretKeys.coinPublicKey);
  console.log(`wallet coinPublicKey ${walletAddressForStore.slice(0, 24)}...`);
  const walletProvider = new SweepWalletProvider(wallet, zswapSecretKeys, dustSecretKey);

  const results: any[] = [];
  for (const entry of manifest) {
    console.log(`\n=== deploy ${entry.name} (k=${entry.k}) ===`);
    const Contract = await loadContractModule(entry.managedDir);

    const providers = makeProviders({
      contractManagedDir: entry.managedDir,
      circuitNames: entry.circuitNames,
      // Physical LevelDB dir. Deploy is single-wallet (w000) so it never
      // collides, but a per-contract dir keeps deploy and load-test state from
      // stepping on each other and matches the load-test convention.
      midnightDbName: `.mnstate/owner-${entry.name}`,
      privateStateStoreName: `bench-${entry.name}`,
      // Hashed into the LevelDB storage path; unique per wallet.
      accountId: walletAddressForStore,
      walletProvider,
    });

    // Witness implementation: the generated circuit declares wit_seed(): Bytes<32>.
    // Any fixed 32 bytes works for a benchmark; content is irrelevant to cost.
    const witnesses = {
      // A Compact witness receives a WitnessContext and MUST return a TUPLE
      // [newPrivateState, value]: the runtime takes [0] as the updated private
      // state and [1] as the disclosed value. Returning a bare Uint8Array made
      // the runtime read [1] of a non-tuple -> undefined -> "expected Bytes<32>
      // but received 0". These circuits have no private state, so pass ctx.privateState
      // straight through and return the 32-byte seed as element [1].
      wit_seed: (ctx: any) => [ctx.privateState, new Uint8Array(32)],
    };

    const t0 = Date.now();
    try {
      // The contract module is loaded by dynamic import, so TypeScript cannot
      // infer Contract's type parameters -- InitializeParameters falls to the
      // generic branch and tsc then demands `args`. The generated benchmark
      // circuits take no constructor arguments and declare NO private state, so
      // `args: []` with no privateStateId/initialPrivateState is correct at
      // runtime; the casts only paper over the erased generics.
      // This single call proves AND submits. For k=18-19 the proof is the slow
      // part -- minutes, and silent -- so announce it, otherwise the terminal
      // looks hung (exactly how the first delegate proof looked). A first proof
      // for a given circuit size also downloads ~GB of prover params.
      console.log(`  proving + deploying (k=${entry.k} first proof can take minutes;`);
      console.log('  watch the proof-server container logs for activity)...');

      // deployContract wants a CompiledContract, NOT a raw `new Contract(...)`.
      // A CompiledContract is built with compact-js: make(tag, ctor) stamps the
      // internal Symbol.for('compact-js/CompiledContract') slot that the SDK reads
      // back via getContractContext; withWitnesses attaches our witness impls;
      // withCompiledFileAssets points proving at the circuit's keys/zkir under the
      // managed dir. Passing a bare `new Contract(witnesses)` skips all of that,
      // leaving the context slot undefined -> "Cannot read properties of undefined
      // (reading 'ctor')" inside compactContext.ts. `Contract` here is the ctor
      // exported by the compiled module (export class Contract { witnesses; ... }).
      // Cast the namespace to any: `Contract as any` erases the C generic, which
      // makes withWitnesses infer its witnesses param as `never`. We verified the
      // runtime shape directly, so bypass the erased-generic type-check here.
      const CC = CompiledContract as any;
      const compiled = CC.make(entry.name, Contract).pipe(
        CC.withWitnesses(witnesses),
        CC.withCompiledFileAssets(join(entry.managedDir, 'contract')),
      );
      const deployed = await deployContract(providers as any, {
        compiledContract: compiled as any,
        args: [],
      } as any);
      const address = deployed.deployTxData.public.contractAddress;
      const txId = deployed.deployTxData.public.txId ?? deployed.deployTxData.public.txHash;
      console.log(`  deployed at ${address} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      results.push({ ...entry, contractAddress: address, deployTxId: txId, deployMs: Date.now() - t0 });
    } catch (e: any) {
      console.error(`  FAILED: ${e.message}`);
      // 'Failed to prove transaction' is a catch-all that hides the REAL error in
      // the cause chain. Walk it and print everything -- server response text,
      // WASM panic message, whatever transaction.prove() actually threw.
      let depth = 0;
      let cur: any = e;
      while (cur && depth < 6) {
        const parts: string[] = [];
        if (cur.message) parts.push(`message=${cur.message}`);
        if (cur._tag) parts.push(`_tag=${cur._tag}`);
        if (cur.name && cur.name !== 'Error') parts.push(`name=${cur.name}`);
        if (cur.status) parts.push(`status=${cur.status}`);
        if (cur.response?.status) parts.push(`http=${cur.response.status}`);
        if (parts.length) console.error(`    cause[${depth}] ${parts.join('  ')}`);
        // Some Effect errors stash the server body on .error or .cause.error
        if (cur.error && typeof cur.error === 'string') console.error(`    cause[${depth}] error=${cur.error}`);
        cur = cur.cause ?? cur.error;
        depth++;
      }
      if (e.stack) console.error(`    stack: ${String(e.stack).split('\n').slice(0, 4).join(' | ')}`);
      results.push({ ...entry, error: e.message });
      // Keep going: a k that's too large to prove on the hosted server is itself a
      // finding, and shouldn't abort the cheaper deploys.
    }
    writeFileSync('deployments.json', JSON.stringify(results, null, 2));
  }

  console.log(`\nwrote deployments.json (${results.length} entries)`);
  console.log('Deploy fees come from the indexer keyed by deployTxId -- run midnight_dust_probe.py');
  console.log('over the deploy window, or fetch each txId, to attribute DUST per k.');

  // The facade started background sync loops (indexer WS + node RPC) that keep
  // the event loop alive. Without stopping them the process hangs after all work
  // is done -- looking "stuck" on the last log line. Stop the wallet, then exit.
  try {
    await wallet.stop();
  } catch (e: any) {
    console.error(`(wallet.stop() failed, exiting anyway: ${e?.message?.slice(0, 80)})`);
  }
}

main()
  .then(() => {
    // Clean success: force exit in case any stray handle (a lingering WS) is
    // still open. All deliverables are already flushed to disk by here.
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });