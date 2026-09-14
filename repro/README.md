# Defect reproductions

One script per defect in `MNF_REPORT.html`. Each prints a single line

```
RESULT <name>: REPRODUCED | NOT REPRODUCED | SKIPPED — <evidence>
```

and exits 0 (reproduced), 1 (not reproduced), or 2 (skipped: prerequisite
missing or not confirmed). Nothing here creates, prints or commits a secret;
wallet-side scripts read `stagenet/.env.stagenet` the same way the harness does.

Two stacks are installed side by side. `stagenet/` is the 30 August pin set
(wallet-sdk 2.0.0-beta.2, midnight-js 5.0.0-beta.7, ledger-v9 1.0.0-rc.3) and
`stagenet-next/` is the newest published set (wallet-sdk 2.0.0-beta.3,
midnight-js 5.0.0-beta.8, ledger-v9 1.0.0-rc.4). `stagenet-next/repro/` is a copy
of `stagenet/repro/`; the wallet scripts go through `transferTx` / `swapTx` in each
directory's `src/wallet.ts`, which absorbs the beta.2 → beta.3 API differences.
Run the same script from either directory to test either stack.

```bash
./repro/run.sh                # groups A + B: no prerequisites, ~1 minute
./repro/run.sh --wallet       # + group C: funded stagenet wallet + local proof server
./repro/run.sh --docker       # + group D: pulls two proof-server images
./repro/run.sh --install      # + 01: a clean npm install of wallet-sdk@2.0.0-beta.2 (~2 min)
```

Group E is never run by `run.sh`. Each of those scripts refuses without
`--confirm`, because it drives load at shared infrastructure or spends preview
DUST for minutes.

| # | Defect (report card) | Script | Needs | What it shows |
|---|---|---|---|---|
| **A. Offline** | | | | |
| A1 | Migration: `createKeystore` kind silently changes the address | `stagenet/repro/keystore-kind.mjs` | — | same secret, `schnorr` vs `ecdsa`, two different addresses |
| A2 | Migration: private-state password now needs 3 of 4 classes | `stagenet/repro/password-policy.mjs` | — | a 20-char single-class password is rejected with `Found: 1` |
| A3 | Migration: ledger-v9 is published under two scopes; the SDK-pinned one has a stale `latest` tag | `repro/02-ledger-package-name.sh` | npm | `@midnightntwrk/ledger-v9` latest = 0.1.0-rc.1 while 1.0.0-rc.5 exists; hyphenated scope started 2026-08-10 |
| A4 | Migration: `compactc 0.33` never published | `repro/03-compactc-033-missing.sh` | `compact` CLI | `compact update 0.33` fails; 0.34.0 is the floor |
| **B. Read-only network** | | | | |
| B1 | Indexer computes fullness and discards it | `stagenet/repro/indexer-hides-fullness.mjs` | indexer | `Block` has no fullness field; limits only recoverable by decoding hex |
| B2 | Fee checks: genesis cost model ≠ chain (the "model" half) | `stagenet/repro/fee-genesis-vs-live.mjs` | indexer | same tx priced against `initialParameters()` and live params |
| B3 | ~~Refused WebSocket permanently retires a wallet~~ **retracted** | `stagenet/repro/ws-no-retry.ts` (`MODE=close`, `403`, `drop:20`) | indexer HTTP | fake WS endpoint counts connection attempts; the sync layer reconnects at 1, 2, 4, 8, 16, 32, 64 s in every mode (exits 1 by design) |
| **C. Funded stagenet wallet + proof server** | | | | |
| C1 | Fee checks: enforcement flag off by default (the "flag" half) | `stagenet/repro/fee-flag-default.ts` | wallet, prover | builds and proves a NIGHT swap, costs it with the flag unset / false / true; **not reproduced** so far: all three pass, the node rejects with 199 not 231 |
| C2 | `initSwap` with NIGHT fails: 231 / 199 | `stagenet/repro/initswap-night.ts` | wallet, prover | swap is proven and submitted; node rejects with 231 or 199 |
| C3 | `signRecipe` required for transfers (192) + errors hide the cause | `stagenet/repro/signrecipe-192.ts` | wallet, prover | transfer without `signRecipe` → 192; `e.message` vs unwrapped cause |
| C4 | `submitTransaction` hardcodes `Finalized` | `stagenet/repro/submit-finalized.ts` | wallet, prover | the literal in the facade source, and the measured ~18 s wait |
| **D. Docker** | | | | |
| D1 | `latest` proof-server tag is two generations stale | `repro/05-proof-server-latest-tag.sh` | docker | `midnightnetwork/…:latest` reports 7.0.0-rc.1; `midnightntwrk/…:8.1.0` reports 8.1.0 |
| D2 | ~~Migration: proof server 9.x dropped `--network`~~ **retracted** | `repro/06-proof-server-9-flags.sh` | docker | 7.0.0-rc.1, 8.1.0 and 9.0.0-rc.5 accept the same flags; none ever had `--network` (exits 1 by design) |
| **Install** | | | | |
| 01 | `wallet-sdk@2.0.0-beta.2` does not install | `repro/01-wallet-sdk-beta2-install.sh` | npm | clean install imports fail on `Clock`; the `utilities@1.2.1` override fixes it |
| **E. Load / spends DUST (manual, `--confirm`)** | | | | |
| E1 | Error 170 on shielded transfers, wallet-sdk 1.x | `repro/08-error-170-ledger8.sh` | preview fleet, ledger-8 | wraps `src/shielded_check.ts` |
| E2 | Single-client mempool ingest saturates ~2 tx/s | `repro/09-mempool-ramp.sh` | preview fleet, proxies | wraps `ramp.sh` |
| E3 | Dust cold-sync degrades with concurrency | `repro/10-cold-sync-concurrency.sh` | preview fleet | wraps `src/test_sync.ts` for 1 vs N wallets |
| E4 | Rate limiting undocumented and disproportionate | `repro/07-rate-limit.mjs` | — | request ramp against the preview indexer; **blocks your IP for minutes** |

Not scripted: **A single 68-output shielded transfer clears the crossover**
and the **fee-floor** findings are measurements, not defects; they are
reproduced by `stagenet/price_watch.mjs`, `stagenet/harvest.mjs` and the
`sustain` phase of `stagenet/src/smoke.ts`.

## Results, 2026-09-14

| # | Outcome | Evidence |
|---|---|---|
| A1 | reproduced | same secret → two addresses for `schnorr` vs `ecdsa` |
| A2 | reproduced | 20-char passwords with 1 or 2 classes rejected (`Found: 1` / `Found: 2`), 3 classes accepted |
| A3 | reproduced (revised) | `@midnightntwrk/ledger-v9` latest tag 0.1.0-rc.1 vs 1.0.0-rc.5 available; both scopes publish rc.4/rc.5 |
| A4 | reproduced | `No version matching 0.33 found`; 0.34.0 is the only 0.3x toolchain |
| B1 | reproduced | `Block` exposes no fullness or limits; 791-byte `ledgerParameters` hex decodes to the limits and `overall_price` |
| B2 | reproduced | 143 of 189 parameter lines differ; a 29,742 B call: genesis 1.882 DUST, live 0.1903, charged 0.1887 |
| B3 | **not reproduced, retracted** | reconnects at 1, 2, 4, 8, 16, 32, 64 s in `close`, `403` and `drop:20` modes |
| C1 | not reproduced | `cost(params)`, `cost(params,false)`, `cost(params,true)` all pass on the proven swap; node rejects it with 199 |
| C2 | reproduced | 3,733 B proven swap rejected: `Custom error: 199` |
| C3 | reproduced | unsigned transfer: `Custom error: 192`; code visible only via symbol-keyed cause chain, `e.message` = "Transaction submission error" |
| C4 | reproduced | `submitTransaction(tx, 'Finalized')` in facade source; one submit blocked 19.1 s (~3.2 blocks) |
| D1 | reproduced | `midnightnetwork/proof-server:latest` → 7.0.0-rc.1; `midnightntwrk/proof-server:8.1.0` → 8.1.0 |
| D2 | **not reproduced, retracted** | identical flag sets on 7.0.0-rc.1, 8.1.0 and 9.0.0-rc.5; `--network` never existed |
| 01 | reproduced | clean install resolves `utilities@1.2.0`, import fails on `Clock`; override to 1.2.1 → `IMPORT_OK` |
| E1–E4 | not run | manual, `--confirm` |

## Results on the newest stack, 2026-09-14

`stagenet-next/`: wallet-sdk 2.0.0-beta.3, midnight-js 5.0.0-beta.8, ledger-v9 1.0.0-rc.4, proof server 9.0.0-rc.5.

| # | Outcome on beta.3 | Evidence |
|---|---|---|
| 01 | **fixed** | beta.3 pins `wallet-sdk-utilities@1.2.2-beta.0`; a clean install imports with no override |
| A1 | reproduced | unchanged |
| A2 | reproduced | `midnight-js-utils` 5.0.0-beta.8 still requires 3 character classes |
| B1 | reproduced | indexer-side, independent of SDK |
| B2 | reproduced | 143 of 189 lines differ; same 29 KB call: genesis 1.882 DUST, live 0.190, charged 0.189 |
| B3 | retracted, unchanged | reconnects at 1, 2, 4, 8, 16, 32, 64 s in `close` and `403` modes |
| C1–C4 | **blocked** | the beta.3 indexer client requests `protocolVersion` on `UnshieldedTransactionsProgress`; the stagenet indexer serves only `highestTransactionId`, so the unshielded wallet never syncs (`isConnected=false`, 0 NIGHT) and no transaction can be built. Static checks: facade 5.0.0-beta.3 still calls `submitTransaction(tx, 'Finalized')`; ledger-v9 rc.4 still takes the enforce flag as optional |

The C-group blocker is itself a finding. The field was added to the indexer by
midnightntwrk/midnight-indexer #1463 on 2026-09-02 and is in no indexer release
tag as of 2026-09-14; wallet-sdk 2.0.0-beta.3 (indexer-client 2.0.0-beta.2)
already requires it. Until stagenet's indexer is redeployed, beta.3 cannot
transact there. `stagenet-next/repro/diag-state.ts` shows the failing
subscription and the new `{ protocolVersion, state }` shape of the facade state.

Other beta.2 → beta.3 breaks met while porting (`stagenet-next/src/wallet.ts`):
`ShieldedWallet(c).startWithSecretKeys` → `startWithSeed` / `startWithKeys({v8, v9})`;
`facade.start(zswapKeys, dustKey)` → `facade.start(WalletSeeds.fromMasterSeed(seed))`;
`transferTransaction` / `initSwap` dropped their `secretKeys` argument.
