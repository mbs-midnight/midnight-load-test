# Midnight load test, fee-floor investigation and capacity analysis

Everything behind two findings reports for the Midnight Foundation:

- **`MNF_REPORT.html`** — *Filling Midnight Blocks.* The preview load test, why the
  DUST fee price never moved (mainnet and preview have sat at the `MIN_COST` floor
  since their second hour), the ledger-9 fix verified on stagenet, which of the
  five cost dimensions actually binds, and the SDK defects met along the way.
  Published copy: https://claude.ai/code/artifact/6081a276-9acb-44d8-985f-55dcab3595a3
- **`CAPACITY_CEILING.html`** — *Midnight's Capacity Ceiling.* Ledger-level
  throughput by transaction shape from a five-dimension cost decomposition of
  1,334 transactions on mainnet, preview and stagenet. Published copy:
  https://claude.ai/code/artifact/6bec22f2-50d7-4d3c-af07-07f9670743d1
- **`BUG_REPORTS.md`** — engineering-facing write-up of every reproduced defect,
  one entry each, with the script that reproduces it.
- **`MPS-dust-fee-price.md`** — a draft Midnight Protocol Specification for the
  fee floor, shelved once it was clear ledger 9 already carries the fix
  (`min_block_price`). Kept for the attack-economics section.

A companion tool, the NIGHT holding estimator for DApps that sponsor their
users' DUST, lives in its own repository (`mbs-midnight/fee-estimator`) and is
calibrated on the `shapes_*.jsonl` data produced here.

## Layout

Three independent npm projects, because they pin mutually incompatible SDK generations.

| Directory | Stack | What it is |
|---|---|---|
| `.` (root) | ledger-8: midnight-js 4.x, `@midnight-ntwrk/ledger-v8` 8.1.0, wallet-sdk 1.1.0 | The **preview** load-test harness (`src/`), the cross-network analysis scripts, the reports |
| `stagenet/` | ledger-9: midnight-js 5.0.0-beta.7, `@midnightntwrk/ledger-v9` 1.0.0-rc.3, wallet-sdk 2.0.0-beta.2 | The **stagenet** smoke/sustain harness, the fee-price and cost-decomposition scripts, the defect reproductions |
| `stagenet-next/` | newest betas: midnight-js 5.0.0-beta.8, ledger-v9 1.0.0-rc.4, wallet-sdk 2.0.0-beta.3 | The same reproductions against the newest published stack. See `BUG_REPORTS.md` #1 for why it cannot transact on stagenet today |
| `repro/` | shell + ledger-8 | Reproduction wrappers and the index (`repro/README.md`) |

`contracts/` holds compiled benchmark circuits (`BenchR<rounds>_S<slots>`), used
only by the ledger-8 deploy path; the multi-gigabyte `keys/` and `zkir/` outputs are
gitignored and regenerate with `compact`.

## Root: the preview load test (ledger-8)

`src/` is the harness that produced the load-test half of `MNF_REPORT.html`
(24 wallets, August 2026). The useful entry points, all via `npm run`:

| Script | Purpose |
|---|---|
| `preflight` | prove every external dependency works before spending NIGHT |
| `addresses` | turn a fleet manifest into fundable addresses |
| `status`, `delegate` | real balances; register NIGHT UTXOs for DUST |
| `register` / `deregister` / `split` / `churn` / `flood` | phases of `src/flood.ts`: fill blocks with cheap unshielded transfers, one serialized lane per wallet, snapshot-restored wallets |
| `audit` | how many fleet lanes are actually live |
| `deploy`, `load` | the original benchmark-circuit path (deploy `BenchR*_S*`, drive contract calls by circuit size k) |
| `test:sync` | cold-sync diagnostic per sub-wallet; wrapped by `repro/10-cold-sync-concurrency.sh` |

Helpers: `prime_pairs.sh` (cold-sync wallets two at a time and snapshot them),
`launch_2h.sh` (the two-hour run), `ramp.sh` (offered-rate ramp that located the
~2 tx/s mempool ceiling), `indexer_proxy.mjs` (split HTTP/WebSocket proxy that
injects the rate-limit bypass header from the environment), `live_fullness.py`
(per-block byte fullness during a run), `gen_wallets.py` / `make_manifest.py` /
`join_sweep.py` (fleet manifest, circuit ladder, fee-vs-k join).

Only the logs that back a number in the report are kept: `final_churn.jsonl`,
`final_fullness.csv`, `run_final_summary.txt` (the two-hour run), `ramp_*.jsonl`
and `ramp_result.txt` (mempool ceiling), `probe_direct.jsonl` / `probe_inblock.jsonl`
(submit-wait stage), `probe_v7.jsonl` and `prove_bench.jsonl` (proof-server
throughput), `prime.jsonl` (cold-sync timing), `shielded_probe.jsonl` (shielded
sizes), `calls.jsonl` / `deployments.json` / `ladder.json` (the benchmark-circuit
path). Iteration logs from 25–30 August were removed on 2026-09-17.

## Cross-network analysis (root and `stagenet/`)

These read the indexers only and spend nothing. They are what turned the load
test into the fee-floor finding.

| Script | What it answers |
|---|---|
| `netparams.mjs` | decode live `ledgerParameters` on all three networks; block limits, fee prices, cost-model diff |
| `params_diff.mjs`, `preview_params.mjs`, `stagenet/chain_params.mjs` | live parameters vs the SDK's genesis defaults (143 differing lines) |
| `mainnet_trend.mjs`, `preview_trend.mjs`, `stagenet/price_trend.mjs` | `overall_price` sampled across each chain's history; mainnet at `MIN_COST` since block 1,197 |
| `mainnet_fees.mjs`, `mainnet_shapes.mjs`, `stagenet/tx_fees.mjs` | who pays fees and whether shape changes the fee (1 SPECK for everything on ledger 8) |
| `stagenet/price_watch.mjs`, `stagenet/find_block.mjs` | per-block price and occupancy; where our >50% block landed and the rise it caused |
| `stagenet/harvest.mjs` | recover node-reported fullness from price movements over 6,000 blocks (54 blocks over 50%) |
| `stagenet/decompose.mjs`, `stagenet/decompose_all.mjs`, `decompose_v8.mjs` | rebuild every transaction locally and run `cost(params)` for the five dimensions; the census behind `CAPACITY_CEILING.html` |

Outputs: `shapes_mainnet.jsonl`, `shapes_preview.jsonl`, `stagenet/shapes_stagenet.jsonl`,
`stagenet/shapes_ours.jsonl`, `stagenet/harvest.jsonl`, `stagenet/price_*.jsonl`.

## `stagenet/`: the ledger-9 harness

`src/wallet.ts` builds a wallet on the 2.0 stack and documents every change
from the 1.x line inline. `src/smoke.ts` has phases `addr | status | register |
shield | unshielded | shielded | churn | burst | sustain`; `sustain` pre-proves a
batch and releases one per block, which is how the 56.9%-full block was produced.
`src/mint.ts` deploys midnight-js's own shielded e2e fixture and mints a
shielded token, since stagenet has no shielded faucet and NIGHT cannot be
swapped into the shielded pool.

```bash
cd stagenet && npm install                 # needs the utilities@1.2.1 override in package.json
cp env.stagenet.example .env.stagenet     # then fill in MN_STAGENET_SEED
docker run -d --name ps9 -p 6310:6300 midnightntwrk/proof-server:9.0.0-rc.5_experimental "midnight-proof-server --num-workers 8"
set -a && . ./.env.stagenet && set +a
npm run status
npm run unshielded -- --outputs 4 --amount 1000000000     # amount is PER OUTPUT, in STAR
NODE_OPTIONS=--max-old-space-size=8192 npx tsx src/smoke.ts --phase sustain --n 4 --outputs 2
```

`--amount` is per output and in STAR (1 NIGHT = 10⁶ STAR). Proving is local;
the wallet SDK stages one transaction per NIGHT UTXO, so `sustain --n N` needs
N funded UTXOs of roughly equal size (see `BUG_REPORTS.md` and the report's
"Staging a batch" bullet).

## `repro/`: defect reproductions

One script per defect card, each printing `RESULT <name>: REPRODUCED | NOT
REPRODUCED | SKIPPED — evidence`. `./repro/run.sh` runs the offline and
read-only groups in about a minute; `--wallet`, `--docker` and `--install` add
the rest; the load tests refuse to run without `--confirm`. Results for both
stacks, and the two claims the suite disproved, are in `repro/README.md`.

## Secrets and cost

`env.preprod.example` and `stagenet/env.stagenet.example` list every variable
the harnesses read. Copy each to its dotted name and fill it in.

Read at runtime from gitignored files, never committed: `.env.preprod` (preview
fleet secrets and the rate-limit bypass token), `wallets.json` / `fleet*.json`
(fleet seeds), `stagenet/.env.stagenet` (the stagenet seed), `.wallet-state/`
and `.mnstate/` (wallet databases). The `.gitignore` covers them; a content scan
for the actual secret values was run before the first push.

The root `flood`/`load` scripts and the stagenet `sustain`/`burst` phases spend
test-network DUST and drive load at shared infrastructure. Run `npm run preflight`
first; do not launch a sustained run without coordinating on the network.

## Things this repository established that are easy to get wrong

- Fullness is the **maximum** over five cost dimensions, and bytes on the wire
  is not the one that binds for transfers or deployments; state writes are.
- `overall_price` is the price of a **full block**, not a minimum fee; a
  transaction pays for the fraction it consumes.
- Below 50% fullness the price **decays**; no amount of sub-50% load produces a
  fee reading. Mainnet and preview (ledger 8) are pinned at `MIN_COST`; stagenet
  (ledger 9) has a floor of 10.
- `LedgerParameters.initialParameters()` is a genesis constant. Decode the live
  `ledgerParameters` from a block instead.
- The wallet SDK tracks pending DUST **per UTXO**, and the balancer selects the
  smallest coin first, so crumb UTXOs get swept into every build.
- Two things we published and later withdrew: the indexer WebSocket *does*
  reconnect (exponential, capped at 2 min), and no proof-server generation ever
  had a `--network` flag.
