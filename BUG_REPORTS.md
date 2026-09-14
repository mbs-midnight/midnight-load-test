# Midnight 2.0 stack: bug reports from the stagenet load-test work

Prepared 2026-09-14 for the Midnight engineering team. Every item below was
reproduced with a script in this repository on the date shown; the script name
is given so it can be re-run. Items are ordered by severity. Two things we
previously believed were defects and have since disproved are listed at the end
so they are not re-filed.

**Environment common to all reports**

| | |
|---|---|
| Network | stagenet (`indexer.stagenet.shielded.tools`, `rpc.stagenet.shielded.tools`) unless stated |
| Stack A ("beta.2", `load-test/stagenet/`) | wallet-sdk 2.0.0-beta.2, wallet-sdk-facade 5.0.0-beta.2, wallet-sdk-indexer-client 1.3.0-beta.1, midnight-js 5.0.0-beta.7, `@midnightntwrk/ledger-v9` 1.0.0-rc.3, compact-runtime 0.19.0-rc.0 |
| Stack B ("beta.3", `load-test/stagenet-next/`) | wallet-sdk 2.0.0-beta.3, wallet-sdk-facade 5.0.0-beta.3, wallet-sdk-indexer-client 2.0.0-beta.2, midnight-js 5.0.0-beta.8, `@midnightntwrk/ledger-v9` 1.0.0-rc.4, compact-runtime 0.19.0 |
| Proof server | `midnightntwrk/proof-server:9.0.0-rc.5_experimental`, local, `--num-workers 8` |
| Client | Node v22.22.0, macOS (arm64), tsx 4.19 |
| Wallet | one funded stagenet wallet: 5,000 NIGHT in 5 UTXOs, all registered for DUST, ~25,000 DUST |
| Reproductions | `load-test/repro/README.md` (index), scripts under `repro/` and `stagenet/repro/` |

---

## 1. wallet-sdk 2.0.0-beta.3 cannot sync an unshielded wallet against the indexer stagenet runs

**Severity:** High. The newest published wallet SDK cannot transact on stagenet at all.
**Component:** `@midnight-ntwrk/wallet-sdk-indexer-client` 2.0.0-beta.2 (pulled in by wallet-sdk 2.0.0-beta.3) against the stagenet indexer.
**Reproduction:** `cd stagenet-next && npx tsx repro/diag-state.ts` (needs `MN_STAGENET_SEED`); or any of the four wallet scripts in `stagenet-next/repro/`.

**Steps**

1. Build a wallet on stack B with `WalletFacade.init` + `facade.start(WalletSeeds.fromMasterSeed(seed))` for a funded address.
2. Wait for sync. Shielded and dust report `isConnected: true` and reach the tip.
3. Observe the unshielded sub-wallet: `progress = { appliedId: 0, highestTransactionId: 0, isConnected: false }`, zero UTXOs.
4. Build any transfer or swap.

**Actual**

```
Wallet.Sync: Unknown field "protocolVersion" on type "UnshieldedTransactionsProgress".
```
and, for every transaction built afterward:
```
Wallet.InsufficientFunds: Insufficient funds
  tokenType: '0000000000000000000000000000000000000000000000000000000000000000'   (NIGHT)
  amount: 0n
```
on a wallet the beta.2 stack sees as holding 5,000 NIGHT.

**Cause**

The beta.3 client's `unshieldedTransactions` subscription selects `protocolVersion` on the `UnshieldedTransactionsProgress` union member. The stagenet indexer's schema, introspected 2026-09-14, has:

```graphql
type UnshieldedTransactionsProgress { highestTransactionId: Int! }
```

The field exists on `midnightntwrk/midnight-indexer` main since commit `3382a382` (#1463, "expose protocolVersion on all progress updates", 2026-09-02) and is in no release tag as of `origin/main` 2026-09-10 (latest tags v4.4.0-rc.3, v4.3.800-rc.1). The beta.2 client does not request the field and syncs normally.

**Expected:** either the client tolerates an indexer that predates #1463, or the SDK release notes state the minimum indexer version and stagenet is upgraded before the SDK beta is published.

**Also in beta.3, undocumented API changes met while porting** (each failed at run time, not compile time, because the harness is untyped at those call sites):

| beta.2 | beta.3 |
|---|---|
| `ShieldedWallet(c).startWithSecretKeys(zswapKeys)` | `ShieldedWallet(c).startWithSeed(seed)` or `.startWithKeys({ v8, v9 })` |
| `DustWallet(c).startWithSecretKey(dustKey, dustParams)` | `DustWallet(c).startWithSeed(seed)` or `.startWithKeys({ v8, v9 })` |
| `facade.start(zswapKeys, dustKey)` | `facade.start(WalletSeeds.fromMasterSeed(masterSeed))` |
| `transferTransaction(outputs, secretKeys, options)` | `transferTransaction(outputs, options)` — the old call compiles at the `any` boundary and silently treats the keys object as options |
| `initSwap(inputs, outputs, secretKeys, options)` | `initSwap(inputs, outputs, options)` |
| facade state `st.shielded.availableCoins` | `st.shielded = { protocolVersion, state }` |

The upstream `packages/docs-snippets` on `midnight-wallet` main still show `startWithSecretKeys` (2026-09-14). A migration note would have saved a day.

---

## 2. `midnightnetwork/proof-server:latest` is a ledger-7 build

**Severity:** High. Silent 9.8× proving slowdown; it invalidated three of our intermediate conclusions before we found it.
**Component:** Docker Hub, organization `midnightnetwork` (note spelling) vs `midnightntwrk`.
**Reproduction:** `bash repro/05-proof-server-latest-tag.sh` (pulls both images, ~1 GB).

**Actual** (2026-09-14)

| Image | `GET /version` |
|---|---|
| `midnightnetwork/proof-server:latest` | `7.0.0-rc.1` |
| `midnightntwrk/proof-server:8.1.0` | `8.1.0` |

Against a ledger-8 SDK the 7.0.0-rc.1 server produces valid proofs at 0.53 proofs/s; 8.1.0 manages 5.2 proofs/s on the same host (14.2 vs 1.17 core-seconds per proof, measured August 2026 on preview). Nothing warns: proofs verify and transactions land.

**Expected:** retire or repoint the stale organization's `latest` tag, and have the SDK compare the proof server's `/version` with the ledger generation it was built for and warn on mismatch.

---

## 3. `initSwap` with NIGHT is always rejected by the node

**Severity:** Medium. API ergonomics plus one open protocol question.
**Component:** ledger `check_night_balance_invariant`; wallet-sdk `initSwap`.
**Reproduction:** `cd stagenet && npx tsx repro/initswap-night.ts` (needs seed + proof server; the node rejects the transaction, so no funds move).

**Steps**

1. `facade.initSwap({ unshielded: { [NIGHT]: 1_000_000n } }, [{ type: 'shielded', outputs: [{ type: NIGHT, receiverAddress: <own shielded address>, amount: 1_000_000n }] }], { ttl, payFees: true })`.
2. `signRecipe`, `finalizeRecipe` (proves in ~0.3 s, 3,733 B), `submitTransaction`.

**Actual, 2026-09-14 on stack A**

```
1010: Invalid Transaction: Custom error: 199        (InvariantViolation::NightBalance)
```

In August the same shape returned `Custom error: 231` (`FeeCalculation(OutsideTimeToDismiss)`) for small swaps and 199 for larger ones; reproduced 6/6 across TTLs of 1 h / 10 min / 5 min, 1 / 4 / 8 outputs, and 5.4× padding. Today's small swap goes straight to 199.

**Analysis**

Architecture review (September 2026) says swapping NIGHT is not meant to be forbidden and the practical obstacle is the guaranteed section exceeding the per-byte time-to-dismiss allowance, which explains the 231. The 199 is a different check. `ledger/src/semantics.rs::check_night_balance_invariant` on public `midnight-ledger` main (last commit 2026-03-30) requires

```
utxo_ann.value + locked_pool + reserve_pool + block_reward_pool
  + treasury_night + unclaimed_rewards + contract_value == MAX_SUPPLY
```

and none of those terms is the Zswap pool. A NIGHT swap that clears the guaranteed section reduces `utxo_ann.value` with nothing to compensate, so it can never pass this check. The check dates to `6.1.0-alpha.2` (2025-09-05); no NIGHT has ever been shielded on preview or stagenet.

**Question for engineering:** is NIGHT meant to be shieldable? If yes, the invariant needs a Zswap term. If no, the SDK should reject the native token in `initSwap` client-side and the docs should say so; today a caller builds, signs, proves and submits a transaction that can never be accepted, and gets back a fee-calculation code that points nowhere near the cause.

---

## 4. `finalizeRecipe` does not sign; the resulting 192 is the same code for the opposite mistake

**Severity:** Medium. Costs hours to diagnose because of item 5.
**Component:** wallet-sdk-facade `finalizeRecipe` / `signRecipe` / `registerNightUtxosForDustGeneration`.
**Reproduction:** `cd stagenet && npx tsx repro/signrecipe-192.ts` (proves one 1,000 STAR self-transfer without signing; rejected, no funds move).

**Steps**

1. `transferTransaction([{ type: 'unshielded', outputs: [{ type: NIGHT, receiverAddress: <own>, amount: 1000n }] }], …)`.
2. `finalizeRecipe(recipe)` — this proves and binds but does **not** sign.
3. `submitTransaction(finalized)`.

**Actual**

```
1010: Invalid Transaction: Custom error: 192        (InputsSignaturesLengthMismatch)
```

The fix is to call `signRecipe(recipe, signer)` first. But `registerNightUtxosForDustGeneration` and `deregisterFromDustGeneration` sign internally, and calling `signRecipe` on their recipes double-signs and yields **the same 192** from the opposite cause. All seven of our first registrations failed that way.

**Expected:** distinct error codes for missing versus surplus signatures, and documentation of which recipes are pre-signed. Alternatively `finalizeRecipe` could refuse an unsigned recipe that has unshielded inputs.

---

## 5. SDK errors hide the ledger rejection code behind an Effect symbol

**Severity:** Medium. Every substantive diagnosis in this exercise required writing a custom error unwrapper first.
**Component:** wallet-sdk (Effect `runPromise` boundary).
**Reproduction:** same run as item 4; the script prints both views.

**Actual** (verbatim from the 2026-09-14 run)

```
e.message + .cause (what a normal handler sees):  Transaction submission error
own keys: [name]
symbol keys: [Symbol(effect/Runtime/FiberFailure), Symbol(effect/Runtime/FiberFailure/Cause)]
full unwrap through symbols: Transaction submission error | Transaction submission error |
  Transaction submission error | Transaction submission failed | Transaction submission failed |
  1010: Invalid Transaction: Custom error: 192
```

`"Transaction submission error"` and `"Failed to prove transaction"` carry no diagnostic content. The node's rejection code is several levels down a cause chain that hangs off a **symbol-keyed** property, not `.cause`, so `err.cause` walking never reaches it. Once we had an unwrapper (`stagenet/src/wallet.ts` `describeError`), error 192 was identified in minutes.

**Expected:** surface the ledger error code (and ideally the enum name) on the thrown error's `message` or a documented property.

---

## 6. `WalletFacade.submitTransaction` always waits for finality

**Severity:** Medium. Dominant cost for any client that submits more than one transaction.
**Component:** `@midnight-ntwrk/wallet-sdk-facade` 5.0.0-beta.2 and 5.0.0-beta.3.
**Reproduction:** `cd stagenet && npx tsx repro/submit-finalized.ts` (spends one transfer fee, ~0.26 DUST).

**Actual**

`dist/index.js` contains `this.submissionService.submitTransaction(tx, 'Finalized')` with no way for the caller to pass a stage, while `wallet-sdk-node-client`'s `sendMidnightTransactionAndWait(serialized, waitFor)` is parameterized over `'Submitted' | 'InBlock' | 'Finalized'`. Measured 2026-09-14: one submit blocked **19.1 s** with a 6 s block time. On preview in August, reaching past the facade to `InBlock` cut our per-transaction cycle from 23 s to 3.8 s. Present on both stacks.

**Expected:** expose the wait stage on the public method, defaulting to `Finalized`.

---

## 7. `LedgerParameters.initialParameters()` misprices fees by ~9×; the WASM `fees()` enforcement flag defaults off

**Severity:** Medium for any tooling that quotes fees from genesis defaults; the flag half is unconfirmed.
**Component:** ledger-wasm (`@midnightntwrk/ledger-v9`), any code calling `initialParameters()`.
**Reproduction:** `node stagenet/repro/fee-genesis-vs-live.mjs` (read-only, downloads one recent transaction).

**Actual, 2026-09-14**

| | |
|---|---|
| Live parameters vs `initialParameters()` | differ in **143 of 189** lines (the per-operation cost model; block limits, DUST parameters and time-to-dismiss limits agree) |
| A 29,742 B contract call, `fees(initialParameters())` | 1.882 DUST |
| Same transaction, `fees(liveParams)` | 0.190 DUST |
| Charged by the chain | 0.189 DUST |

wallet-sdk 2.0 is **not** affected on its fee path: the dust wallet deserializes `ledgerParameters` from synced block data and prices from that, using `initialParameters()` only for the dust grace-period default. Anything else that calls `initialParameters()` for an estimate, including our own ledger-8 harness and, we suspect, dApp code following older examples, is quoting from a model no network runs. **Expected:** document `initialParameters()` as a genesis constant, not a fee input.

**Flag half, unconfirmed.** `ledger-wasm/src/tx.rs` resolves `cost()`/`fees()` as `enforce_time_to_dismiss.unwrap_or(false)`, so the time-to-dismiss check the node applies is off by default in the binding (public main, 2026-03-30; the rc.4 and rc.5 JS bindings still pass the flag as optional). Architecture review believes this is already fixed; the public repository has not moved since March while rc.4/rc.5 shipped in August/September, so we could not confirm from source. We also could not make the difference observable: `stagenet/repro/fee-flag-default.ts` costs a proven NIGHT swap with the flag unset, `false` and `true`, and all three pass on every shape we can build today. Filed as a question.

---

## 8. The indexer computes block fullness and does not expose it

**Severity:** Medium (feature request with a concrete cost).
**Component:** midnight-indexer GraphQL v4.
**Reproduction:** `node stagenet/repro/indexer-hides-fullness.mjs` (read-only introspection).

**Actual, 2026-09-14, block 463,470:** `Block` exposes `hash height protocolVersion timestamp author zswapMerkleTreeRoot ledgerParameters zswapEndIndex dustCommitmentEndIndex dustGenerationEndIndex dustCommitmentMerkleTreeRoot dustGenerationMerkleTreeRoot parent transactions systemParameters contractZswapState`. No fullness, no limits, no price. `ledgerParameters` is 791 bytes of opaque hex that only the ledger WASM can decode; decoded it holds the five block limits and `overall_price`. The indexer computes `block_fullness` internally and discards it.

Every fee-market finding in `MNF_REPORT.html` (mainnet pinned at `MIN_COST` for 2.39 M blocks, the 50% crossover, which of five dimensions binds) required decoding that hex client-side for thousands of blocks. **Expected:** expose decoded block limits, per-dimension fullness and `overall_price` on `Block`.

---

## 9. `createKeystore` `kind` silently derives a different address

**Severity:** Low (API footgun; fund-losing if the wrong default is picked).
**Component:** wallet-sdk-unshielded-wallet `createKeystore({ kind, secret }, networkId)`.
**Reproduction:** `node stagenet/repro/keystore-kind.mjs` (offline, throwaway secret).

Same 32-byte secret with `kind: 'schnorr'` and `kind: 'ecdsa'` yields two different bech32 addresses with no warning. `'schnorr'` is the ledger-8-compatible scheme (`Roles.NightExternal`); `'ecdsa'` is ledger-9-only. Since 2.0 made `kind` an explicit required field, a caller migrating from the 1.x `createKeystore(bytes, networkId)` has to know which value preserves their existing address. **Expected:** state this in the migration notes; consider making the choice explicit at the type level (`createSchnorrKeystore` / `createEcdsaKeystore`).

---

## 10. Private-state password policy tightened without notice

**Severity:** Low.
**Component:** `@midnight-ntwrk/midnight-js-utils` 5.0.0-beta.7 and beta.8, `validatePassword`, used by `levelPrivateStateProvider`.
**Reproduction:** `node stagenet/repro/password-policy.mjs` (offline).

4.x required length ≥ 16. 5.x additionally requires ≥ 3 of {upper, lower, digit, special}, no run of 4 sequential characters, no 4 identical in a row. A 20-character lowercase passphrase that worked on 4.x now fails **at deploy time** with:

```
Password must contain at least 3 of: uppercase letters, lowercase letters, digits, special characters. Found: 1
```

The rule is fine; the silent change is the defect. **Expected:** a migration note, and validation at provider construction rather than first use.

---

## 11. `ledger-v9` is published under two npm scopes, and the one the SDK pins has a stale `latest`

**Severity:** Low (packaging).
**Reproduction:** `bash repro/02-ledger-package-name.sh`.

| Package | `latest` dist-tag | versions |
|---|---|---|
| `@midnightntwrk/ledger-v9` (pinned by wallet-sdk / facade / dust-wallet betas) | **0.1.0-rc.1** (2026-06-08) | 0.1.0-rc.1, 1.0.0-rc.2 … rc.5 |
| `@midnight-ntwrk/ledger-v9` (the scope every other Midnight package uses) | 1.0.0-rc.3 | 1.0.0-rc.3 (2026-08-10), rc.4, rc.5 |

`npm i @midnightntwrk/ledger-v9` without a version installs a June prerelease. **Expected:** move the `latest` tag, and decide on one scope.

---

## 12. `compactc 0.33.0-rc.2`, the version in the partner document, was never published

**Severity:** Low (documentation).
**Reproduction:** `bash repro/03-compactc-033-missing.sh`.

```
compact update 0.33
Caused by: No version matching 0.33 found
```

The lowest installable 0.3x toolchain is 0.34.0 (runtime 0.19.0), which pairs with midnight-js 5.0.0-beta.7+, not the beta.4 the document names. **Expected:** correct the version matrix.

---

## 13. Fixed in beta.3: `wallet-sdk@2.0.0-beta.2` does not install

For the record, since beta.2 is still the `beta` dist-tag's predecessor and in the partner document.
**Reproduction:** `bash repro/01-wallet-sdk-beta2-install.sh` (clean temp install, ~2 min).

A clean `npm i @midnight-ntwrk/wallet-sdk@2.0.0-beta.2` resolves `wallet-sdk-utilities@1.2.0`, and the first import fails:

```
SyntaxError: The requested module '@midnight-ntwrk/wallet-sdk-utilities' does not provide an export named 'Clock'
```

An override to `utilities@1.2.1` fixes it. **beta.3 pins 1.2.2-beta.0 and installs cleanly** (verified 2026-09-14 in `stagenet-next/`). No action needed beyond retiring beta.2 from the document.

---

## 14. Measured on preview in August 2026, not re-run

These come from the ledger-8 load test and are recorded in `MNF_REPORT.html`; the reproductions in `repro/07`–`10` require the preview fleet and a `--confirm` flag because they drive load at shared infrastructure.

- **Single-client mempool ingest saturates near 2 tx/s.** `1016: Immediately Dropped — the transaction couldn't enter the pool because of the limit` first appears at 2 tx/s offered; achieved throughput peaks at 1.88 tx/s at 3 offered and *declines* to 1.68 at 6 offered (congestion collapse, not a plateau). Open question: is the limit per connection, per peer, or global?
- **Dust cold sync degrades sharply with concurrency.** Two wallets synced in 446 s; six concurrent produced one usable wallet in 49 minutes. `serializeState()` / `restore()` cuts warm-up from ~386 s to ~9 s but is undocumented as the intended path.
- **Rate limiting is undocumented and disproportionate.** Clean at ≤ 0.25 req/s; sporadic 403s from ~4.6 req/s; hard IP block at ~12 req/s sustained, covering indexer, RPC and faucet over HTTP and WebSocket, recovering after 1–3 minutes.

---

## Protocol observation, for completeness

Not a client defect, and covered in full in `MNF_REPORT.html` and `CAPACITY_CEILING.html`: on ledger-8 (mainnet and preview) `overall_price` fell to `MIN_COST` = 5.42 × 10⁻¹⁸ within about two hours of genesis and has stayed there for 2.39 M blocks, so every transaction costs exactly 1 SPECK and the fee schedule carries no information. Ledger 9 adds `min_block_price: 10`, which we verified working on stagenet (a 56.9%-full block moved the price 10 → 10.0279, matching the specified curve to five significant figures). The specification applies its `MIN_COST` epsilon to the per-dimension factors; the implementation applies it to `overall_price`, which is what turned a rounding guard into an 18-orders-of-magnitude floor.

---

## Not defects: two earlier claims we have withdrawn

Included so nobody files them.

- **"A single refused WebSocket permanently retires a wallet."** `wallet-sdk-indexer-client` does construct graphql-ws with `shouldRetry: () => false`, but each sub-wallet's `RunningV1Variant` re-creates the subscription on `Schedule.exponential(1 s, 2)`, jittered, capped at 2 minutes. Verified on beta.2 and beta.3 with a fake endpoint in three modes (immediate close, HTTP 403 on upgrade, drop after 20 s of real traffic): reconnects at 1, 2, 4, 8, 16, 32, 64 s every time. Our six-minute stall in August was the rate-limit block outlasting the run. Residual ergonomics only: nothing is surfaced while reconnecting except `progress.isConnected = false`.
- **"Proof server 9.x dropped `--network`."** 7.0.0-rc.1, 8.1.0 and 9.0.0-rc.5 accept the identical flag set (`--num-workers --port --job-capacity --job-timeout --no-fetch-params --verbose`); none ever had `--network`. The flag was in our own launch script.
