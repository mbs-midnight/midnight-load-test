# Request: rate-limit allowlist for a sanctioned load test on preview

**Requester:** mahesh.sashital@midnight.foundation
**Source IP:** 57.132.195.99
**Target environment:** preview (`indexer.preview`, `rpc.preview`)
**Window requested:** ~2 hours + ~30 min provisioning. Please propose a slot that
avoids other scheduled testing; we will fit around you.

## What we are doing and why

We are measuring two things that, as far as we can tell, have never been measured
on a Midnight network under real load:

1. **DUST cost and block fullness as a function of circuit size.** Ten benchmark
   contracts (k=14/18/19, varying public-input slots) are already deployed to
   preview and have been exercised at low rate.
2. **Whether the fee multiplier ever leaves its floor.** Every transaction we
   have sampled — 16 recent preview txs, 10 unshielded transfers, 111 txs in an
   older preprod window — reports a fee of exactly **1 SPECK**, whether it is a
   639-byte transfer or a 12,486-byte deploy. The ledger's multiplier is
   `1 + logit(u)/100`, so it should respond to utilisation `u`. Nothing in the
   data suggests it ever has. Driving sustained block fullness is the only way
   to find out, and the answer matters for fee-market design.

To do (2) we need to hold blocks at roughly **50% of the 200,000-byte
block_usage limit** while running heavier proof workloads concurrently.

## Why we are asking

Preview is currently rate-limiting us, and we would rather be allowlisted than
quietly work around it. Measured against our own traffic today:

| our request rate | result |
|---|---|
| <= 0.25 req/s, serial | clean, no failures |
| ~4.6 req/s | sporadic HTTP 403 (nginx page, not a GraphQL error) |
| ~12 req/s sustained | hard IP block, ~1-3 min to recover |

The block covers `indexer.preview`, `rpc.preview` and `faucet.preview`, over
**both HTTP and WebSocket**. That last part is what makes it a blocker rather
than an inconvenience: wallet sync runs over the indexer's GraphQL WebSocket, so
a rate-limited IP cannot sync wallets at all, and the SDK sets `shouldRetry:
false` — one refused connect is permanent and presents as a wallet stuck at
`connected=false` with no error.

## What we would generate

All figures below are measured on preview today, not estimated.

- **~7-15 wallets**, each syncing three sub-wallets against `indexer.preview`.
  Startup is staggered (3s apart) specifically to stay inside your limits.
- **Sustained submission target: ~4.4 tx/s** of unshielded NIGHT self-transfers,
  for a run of about **2 hours** (~31,000 transactions total).
- **A concurrent proof track**: contract calls at k=14/18/19 (~8,151 bytes each)
  at a much lower rate, since proving dominates those.

How that target is derived:

| quantity | measured value |
|---|---|
| block cadence | 6.000 s (n=499, every interval within 1 ms) |
| `block_usage` limit | 200,000 bytes *(assumed protocol constant -- see ask #2)* |
| unshielded self-transfer size | 3,825 B median (n=21, range 3,736-4,412) |
| 50% of limit | 100,000 B/block = 26.1 tx/block = **4.36 tx/s** |
| our per-connection cycle | 23.8 s (build 0.5s, prove 3.6s, submit-to-InBlock 19.7s) |

For scale, preview's current baseline is **0.0053 tx/s** and **97% of blocks are
completely empty**, so essentially all of this load is ours and it is entirely
attributable to us.

Every transaction we have ever sampled on preview costs exactly **1 SPECK** --
including a 32-output transfer and a 12,486-byte contract deploy. That is the
core thing we are trying to test: whether sustained utilisation moves the
multiplier at all.

## Why this is now blocking, with measurements

We rebuilt our client to be as gentle as possible and still cannot reach the
target. Two hard results from 2026-08-27:

**1. We are throttled at roughly 0.5 tx/s aggregate.** Two wallets submitting
unshielded self-transfers ran cleanly for ~3 minutes at 0.26 tx/s each, then
began returning `Forbidden`. 51 transactions landed (all SUCCESS, all 1 SPECK,
none lost) before the throttle engaged. Holding 50% fullness needs **4.36 tx/s**,
roughly 8x more than the point at which we are currently cut off.

**2. A transient 403 permanently kills a wallet.** This is the more serious
issue. `wallet-sdk-indexer-client` creates its GraphQL WebSocket with
`shouldRetry: () => false`, so a single refused connect is unrecoverable: the
wallet sits at `isConnected=false` forever with no error raised. In our run both
wallets dropped to **zero throughput for the remaining 6 minutes** and never
came back. For a 2-hour run this means one brief rate-limit event silently
degrades the whole test to nothing, and we cannot tell from the client side
whether we are being throttled or the chain is simply idle.

Combined, these mean the measurement is not achievable from a rate-limited IP at
any client-side level of care -- hence this request rather than a workaround.

## What we need

1. An allowlist entry for **57.132.195.99** on `indexer.preview` and
   `rpc.preview`, covering HTTP and WebSocket, for the agreed window.
2. Confirmation of the **block_usage limit**. We are assuming the protocol
   constant of 200,000 bytes; the indexer exposes `ledgerParameters` only as
   opaque hex and never decodes it, so we cannot verify this from outside. If
   the real value differs, every fullness number we produce is wrong.
3. A **go/no-go and preferred window**, since preview is shared. We will stop
   immediately on request, and we can cap our rate at any number you name.
4. Optional but valuable: the indexer already computes `block_fullness`
   internally and discards it. Exposing it would make this measurement exact
   across all five cost dimensions instead of just `block_usage`, which is the
   only one visible externally.

## Safeguards on our side

- A halt file is checked between every submission; one touch stops the fleet.
- Wallets are individually funded and DUST-registered; there is no path for this
  to touch anything but our own 15 addresses.
- We will share the resulting fee/fullness dataset.
