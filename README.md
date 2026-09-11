# Preprod deploy + DUST fleet load-test harness

Deploys benchmark circuits to Midnight **Preprod** and load-tests them through a
hosted (**Arkhia ZKPaas**) proof server with a **fleet of wallets**, then
attributes DUST cost and block fullness per circuit size k.

## What is in this folder (all of it -- nothing else is referenced)

```
harness/
  package.json            SDK deps pinned to the ledger-8 line
  tsconfig.json
  env.preprod.example     copy to .env.preprod and fill in (no leading dot so it is visible)
  .gitignore              covers .env.preprod and wallets.json
  proxy.mjs               x-api-key injecting proxy, ONLY if preflight says needed
  gen_wallets.py          make wallets.json for the fleet
  make_manifest.py        make ladder.json from your compiled contracts
  join_sweep.py           produce the final fee/fullness-vs-k tables
  src/
    providers.ts          network config + provider assembly (one buildWallet stub to wire)
    preflight.ts          no-cost checks: Arkhia auth mode, indexer, wallet
    deploy.ts             deploy contracts cheapest-k-first -> deployments.json
    load_test.ts          the fleet load generator (replaces run_sweep.ts)
    run_sweep.ts          single-wallet paced driver; kept ONLY for a gentle
                          low-rate attribution pass -- it is NOT a load test
```

Files created AT RUNTIME (why they are not shipped): `.env.preprod` (your
secrets), `wallets.json` (gen_wallets.py), `ladder.json` (make_manifest.py),
`deployments.json` (deploy.ts), `calls.jsonl` / `run_meta.json` (load_test.ts).

## Do the compiled contracts live here?

No. The `.compact` sources aren't needed at all at runtime. What deploy/load need
is each contract's **compiled managed output** -- the directory containing
`keys/`, `zkir/`, and `contract/index.js` -- and `ladder.json` points at those
directories by absolute path, wherever they are. `make_manifest.py` refuses to
write a manifest if any of the three is missing, so path problems surface before
any DUST is spent.

## The concurrency model (read before sizing the run)

**One wallet = one lane.** Concurrent transactions from a single wallet balance
against the same DUST UTXOs; two in-flight calls select overlapping dust, one
confirms, the other dies as a double-spend. So `load_test.ts`:

- runs a **strictly serialized loop per wallet** (prove -> submit -> log -> next),
- gets ALL parallelism from **fleet size** -- "simulate 300 users" means 300
  funded wallets in wallets.json,
- caps aggregate submission rate with a global token-bucket (`--target-tps`),
  or runs flat-out when omitted, to find the fleet's natural ceiling.

Proving dominates latency, so **wallets concurrently proving = your in-flight
depth at Arkhia**. The "up to 20 prove batches in parallel" toggle means the
endpoint has 20 lanes: you need **>= 20 wallets** to fill them, and beyond that
you queue at their end -- visible as p50 prove_ms growing with fleet size, which
is itself a result worth recording (it measures ZKPaas saturation).

Throughput back-of-envelope: `tx/s ~= wallets / prove_seconds`. 20 wallets at
30 s proofs ~= 0.67 tx/s ~= 4 tx per 6 s block. Size the fleet from observed
prove_ms, not hope. Hundreds of simultaneous users at k=14..19 likely means a
fleet in the low hundreds -- every one individually funded and DUST-registered
(DUST is non-transferable; there is no funding shortcut through one rich wallet).

## Sequence

```bash
cd harness && npm install

# contracts: compile your 4-5 variants (k=14..19, varying slots), then
python3 make_manifest.py \
  --managed /path/to/managed/BenchR<r1>_S<s1> \
  --managed /path/to/managed/BenchR<r2>_S<s2> \
  ... \
  --artifacts /path/to/artifacts.csv --out ladder.json

# fleet
python3 gen_wallets.py --count 25 --out wallets.json
# fund EACH wallet: faucet/internal tNIGHT -> delegate -> wait for tDUST > 0
# verify: python3 ../dust_budget_monitor.py --roster fleet.csv --endpoint <indexer> --once

# secrets + checks (no DUST spent)
cp env.preprod.example .env.preprod   # fill in; set ONE of seed/mnemonic
set -a && . ./.env.preprod && set +a
npm run preflight                       # settles the Arkhia auth question

# deploy (cheapest k first) -> deployments.json
npm run deploy -- --manifest ladder.json

# monitor in a second terminal
python3 ../dust_budget_monitor.py --roster fleet.csv --endpoint <indexer> \
  --watch 30 --min-runway-s 600 --halt-file ./HALT

# LOAD TEST
npm run load -- --deployments deployments.json --wallets wallets.json \
  --duration-s 1800 --halt-file ./HALT --mix "14:1,16:1,17:1,19:1"
# add --target-tps N to cap the rate; omit to find the ceiling

# attribute + join
python3 ../midnight_dust_probe.py --endpoint <indexer> \
  --from-time <started_utc> --to-time <ended_utc> --out-dir sweep_out
python3 join_sweep.py --calls calls.jsonl \
  --transactions sweep_out/transactions.csv --blocks sweep_out/blocks.csv
```

## Verified vs. must-confirm

**Verified against Midnight docs (updated 2026-07-27):** provider assembly,
deploy/find-contract calls, Preprod endpoints, network id, faucet->delegate->tDUST
funding flow. **Tested here:** the rate governor under 30 concurrent workers, the
weighted k-mix picker, make_manifest happy/error paths, join_sweep's control
readout against confounded fixtures.

**Must confirm on your side:**
1. **Arkhia auth mode** -- run preflight; use proxy.mjs only if it says header-required.
2. **buildWallet() in providers.ts** -- deliberate stub; wire to your installed
   `@midnight-ntwrk/wallet-sdk-facade` version. Only place seed material lives.
3. **SDK versions** -- reconcile the ledger-8 pins together if anything moved.

## Design invariant

The load generator records `txId -> k` and timings; it never computes a fee. Fees
come only from the indexer via the probe, so the generator cannot report the
number it hoped for. `join_sweep.py` prints the control readout: fee should be
flat across k and move with slots (public inputs); if k appears to matter, it
tells you which confound to check first.

## Safety

- `.env.preprod` and `wallets.json` hold spend keys. Both gitignored.
- Deploy is cheapest-k-first so funding problems fail cheap.
- Every worker polls the DUST monitor's halt file between calls; a drying fleet
  stops submissions instead of stranding wallets.
- Preprod is shared. Coordinate before sustained high-fullness phases.