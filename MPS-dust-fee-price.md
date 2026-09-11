---
MPS: xxxx # assigned by editors
Title: The DUST fee-price floor is eighteen orders of magnitude too deep
Authors: Mahesh Sashital <mbs-midnight>
Status: Proposed
Category: Core
Created: 01-Sep-2026
Requires: none
Replaces: none
MIP: none
---

## Abstract

`overall_price` is a per-block state variable that scales every DUST fee. It rises when
blocks are more than half full, falls when they are not, and is clamped below at
`MIN_COST` — a floor roughly 18 orders of magnitude beneath the genesis value.

On Midnight mainnet (ledger `8.1.2`) it fell to `MIN_COST` by **block 1,197**, within about
two hours of the chain starting, and has stayed there for **2.39 million blocks — over five
months — through today**. Across a 6,001-block window all **126** fee-paying transactions
cost exactly **1 SPECK**, against roughly 1.8 × 10¹⁵ SPECK for the same transaction at the
genesis price. Preview shows the identical trajectory; on stagenet (ledger-9) the price has
instead never moved at all, including under load we generated.

The load-responsive fee component has therefore been inactive for essentially the whole life of the chain. The floor's depth is not a tuned parameter: the specification applies its MIN_COST epsilon to the per-dimension price factors, which are normalized to a mean of 1, whereas the implementation applies it to overall_price, which begins at 10 — turning a rounding guard into a floor eighteen orders of magnitude down. Because the DUST holding cap rations transactions in units of fee, the rationing meant to bound throughput loses the same fifteen orders with it. Priced against the specification's stated intent that an attacker "pay as much as a regular user": an hour of complete block saturation is free, and about $0.32 per day would sustain 47% of all blocks at 100% fullness indefinitely once submission decentralizes — while the attacker's compute cost exceeds their fee cost by orders of magnitude.

This MPS documents the problem and the evidence. It does not propose a remedy.

## Vision

Midnight prices transactions in a way that stays meaningful across the conditions the
network actually experiences, including the long quiet periods that are normal for a young
chain. Whatever the intended behavior of `overall_price` — active congestion pricing or a
deliberately flat cost — that intent is explicit, documented, observable from outside, and
consistent with what the code does. Developers estimating operating costs get a number
that will still be true when the network is busy.

## Problem

### The mechanism

`overall_price` is recomputed every block from the previous block's fullness and then
clamped:

```
overall_price ← max( overall_price × (1 + price_adjustment_function(fullness, a)),  MIN_COST )

price_adjustment_function(usage, a) = -ln(1 / clamp(usage, 0.01, 0.99) - 1) / a
```

with `a = 100`. It is a linear multiplier on the whole fee. The adjustment crosses zero at
exactly 0.50 fullness and is bounded at ±4.5951% per block.

| | value |
|---|---|
| `MIN_COST` | `FixedPoint(100)` = 5.421011 × 10⁻¹⁸ |
| genesis `overall_price` (`INITIAL_PARAMETERS`) | 10 |
| dynamic range | 1.84 × 10¹⁸ — 18.3 orders of magnitude |

Because the crossover sits at 50% and the rates are symmetric, the variable integrates the
chain's fullness history. A network below half full most of the time converges on the
floor and stays there.

### This is the current state of mainnet

Sampled from per-block `ledgerParameters` on `indexer.mainnet.midnight.network`, decoded
with `@midnight-ntwrk/ledger-v8`:

```
height          date          overall_price
     -     genesis       10                        INITIAL_PARAMETERS
     1     2026-03-18     9.102091156410182        = 10 x 0.9540488^2
   479     2026-03-18     0.0000000015627278225258633
 1,197     2026-03-18     0.000000000000000005421010862427522   ← MIN_COST
 2,394     2026-03-19     0.000000000000000005421010862427522
23,939     2026-03-20     0.000000000000000005421010862427522
   ...
2,393,873  2026-09-01     0.000000000000000005421010862427522
```
Note on dating. The Midnight genesis block carries timestamp 2026-03-17T03:17:00 UTC; public mainnet launch was announced 2026-03-30. All heights and dates here derive from on-chain block timestamps via the mainnet indexer, not the launch announcement, so the chain's first blocks predate the widely cited 30 March date. Ref: Midnight tokenomics & incentives whitepaper v1.81, §8.

The descent took **1,197 blocks — roughly two hours**. The floor has held for every one of
the 2.39 million blocks since, sampled at seventeen heights across five and a half months.

Block 1 is already below the genesis value by exactly two maximum-decay steps
(`10 × 0.9540488² = 9.102091156410184`, against `9.102091156410182` measured). That is
worth noting as positive evidence: on ledger-8 the adjustment demonstrably runs, from the
chain's first blocks, and does exactly what the specification says. The problem described
here is not that the mechanism is broken but that its equilibrium is the floor.

The price series above is the primary evidence; the realized fees are a consequence of it,
since a price at `MIN_COST` leaves no room for a transaction to cost more than the
minimum. They agree. Over a 6,001-block window at the current tip, 139 of 6,001 blocks were
non-empty (2.32%), carrying 139 transactions of which 126 were regular fee-paying
transactions. **All 126 cost exactly 1 SPECK** — a single distinct value across the whole
sample. The remaining 13 were system transactions carrying no fee.

The sample is necessarily modest because mainnet is idle: 6,001 blocks is about ten hours
of chain time and yields only 126 fee-paying transactions. It is offered as confirmation
of the price measurement rather than as an independent result.

**Reference transaction.** One figure is used throughout the rest of this document for
comparison against the floor: a 51,809-byte unshielded transfer, priced against live
parameters with `overall_price = 10`, costs **1,800,781,427,934,920 SPECK ≈ 1.80 DUST**.
The same transaction at `MIN_COST` costs 1 SPECK — a factor of **1.8 × 10¹⁵**.

Preview (also ledger-8) reached `MIN_COST` by block 1,324 and has held it for ~660,000
blocks; all 1,861 transactions from a load test there cost exactly 1 SPECK.

### Recovery is slower than the load it would need to price

Restoring the price requires sustained fullness above the crossover:

| Sustained fullness | Change per block | Blocks to genesis price | Wall clock |
|---|---|---|---|
| 50% | 0.00% | never | — |
| 60% | +0.41% | 10,394 | 17.3 h |
| 75% | +1.10% | 3,849 | 6.4 h |
| 100% | +4.60% | 936 | 1.6 h |

The depth of the floor makes even fast recovery slow in absolute terms. After 154 blocks
of *continuous saturation* — fifteen minutes — the price has risen about 1,000× off the
floor but is still **15 orders of magnitude below the genesis value**. Reaching even 1000×
*below* genesis takes 782 blocks, about 78 minutes of unbroken 100% fullness. Any load
event shorter than that is priced at or near the floor for its entire duration.

### Both throughput defenses degrade together

Midnight's documentation describes DUST rationing as the bound on activity: *"The amount
of DUST you can store is proportional to your NIGHT balance."* That cap bounds a holder's
transactions only in units of the fee, so it inherits the fee's collapse.

Measured on our own fleet, 5,000 NIGHT generates a cap of 25,000 DUST — 2.5 × 10¹⁹ SPECK.
Priced at the reference transaction above (1.8008 × 10¹⁵ SPECK), that budget funds
**13,883 transactions**. At the floor, where the same transaction costs 1 SPECK, it funds
**2.5 × 10¹⁹** — the full ratio of 1.8 × 10¹⁵.

So the fee price and the DUST cap do not provide independent protection: the cap's
rationing power is a function of the price, and both lose roughly fifteen orders of
magnitude of force in the same state — the state mainnet has been in since its second hour.

### What the attack actually costs

The two defenses above can be priced. Assumptions: NIGHT at **$0.02**, a cap of 5 DUST per
NIGHT refilling over roughly a week, and the most byte-efficient transaction shape we
measured on ledger-9 — a 32-output shielded transfer at 265,512 bytes, 26.54% of a block,
so **3.77 transactions fill one block completely**. The DUST parameters are not assumed:
5,000 registered NIGHT accumulated 3,639 DUST against a 25,000 DUST cap in about 24 hours,
implying a 6.87-day refill, and `night_dust_ratio` reconciles exactly as SPECK per STAR.

Mainnet is at the floor and, as established above, the adjustment is live. So an attacker
begins at 5.421011 × 10⁻¹⁸ and the price compounds +4.5951% per block while they hold
blocks full. Because that growth is exponential from a very low base, essentially the whole
cost of the climb falls in its final blocks — **98.9% of the cost of the 936-block ascent
to the genesis price occurs in the last 100 blocks**:

| Duration held at 100% | Blocks | Price reached | Cumulative DUST | NIGHT | Cost |
|---|---|---|---|---|---|
| 1 hour | 600 | 2.8 × 10⁻⁶ | ~0 | ~0 | **$0.00** |
| 1.43 h | 859 | 0.31 | 10.2 | 2.0 | **$0.04** |
| 1.5 h | 900 | 1.97 | 64.1 | 12.8 | $0.26 |
| 1.56 h | 936 | 9.93 | 323.0 | 64.6 | $1.29 |
| 2 hours | 1,200 | 1.4 × 10⁶ | 4.6 × 10⁷ | 9.1 × 10⁶ | $182,938 |

An hour of complete block saturation is free to three decimal places. The mechanism does
eventually bite — at two hours it is ruinous — but not within the window an attacker would
choose.

**And the window is self-renewing.** Rise and decay rates are symmetric, so an attacker who
stops before the cost bites and waits for the price to fall back to the floor can repeat
indefinitely. Stopping at 859 blocks, the price decays back over 972 blocks at mainnet's
observed occupancy, giving a 1,831-block cycle:

> **Roughly $0.32 per day — $9.59 per month — holds 47% of all mainnet blocks at 100%
> fullness, indefinitely.**

The 47% duty cycle is not a tuning choice. The attacker climbs at the +4.5951% saturation rate and the chain decays at roughly −4% at mainnet's idle occupancy; because both rates are constant, the ratio of climb-blocks to decay-blocks is fixed regardless of how high the price is driven, so the duty cycle is the same at any attack amplitude. The slight asymmetry — decay below the crossover is slower than the maximum rise — is what places it below 50% rather than at it.

The conclusion is insensitive to the token price, because the gap being exploited is fifteen
orders of magnitude rather than a factor of two. At twenty-five times the price assumed here
($0.50), the same sustained attack costs $7.99 per day.

Nor is DUST the binding cost. Filling blocks at this rate requires about 88 seconds of
proving per 6-second block — roughly **15 proof-server instances, ~120 vCPU sustained** —
while submission runs at 0.63 tx/s, comfortably inside the 1.9 tx/s single-client mempool
ceiling we measured. The attacker's compute bill exceeds their DUST bill by orders of
magnitude. The network's economic defense against this is therefore not weak; it is absent.

This also constrains the remedy space. Making recovery faster than decay would raise the
cost of the duty cycle only at its margin, while making the out-pricing attack — driving
prices up for everyone else and stopping — cheaper to mount. **Bounding the range is the
load-bearing change; the adjustment rate is secondary.**

### The ledger-9 successor behaves differently, but not obviously better

On stagenet (ledger-9, node `2.0.0-rc.4`) `overall_price` reads exactly `FixedPoint(10)` —
the genesis value — at every height sampled from block 1 to block 258,147, about 18 days,
despite 98% of blocks being empty, where the specified behavior is decay.

We tested this directly rather than inferring it. Submitting 43 transactions over 17
minutes raised block occupancy from 2.0% to 27.6% across a 192-block window; the price did
not change by a single fixed-point unit. Under the specified rule even the most generous
reading of that fullness predicts a fall from 10 to 1.56, and a realistic reading predicts
0.03.

Whether that is deliberate configuration or an implementation regression is not
determinable from outside. It matters here because it means the ledger generation
following mainnet's does not demonstrably fix the behavior documented above — it exhibits
a different one, whose intent is undocumented.

### Is this a problem, or the intended design?

The published ledger specification answers this, and answers it against a flat-fee
reading. `spec/cost-model.md` opens:

> The ledger must charge for transactions to deter denial of service attacks. There is a
> tension that encourages these prices to be as accurate as possible: A practical desire to
> keep transaction fees low; **a security requirement to not under-charge.**

and states the mechanism's purpose directly:

> …the idea is that there is a price to attack the network, and that **an attacker has to
> pay as much as a regular user.**

It also fixes the target — "Both are adjusted to target 50% fullness" — and gives
`INITIAL_PRICES` with `overall_price: 10`, matching what mainnet started from.

So `overall_price` is specified as a congestion-pricing and DoS-deterrence mechanism, not
as a decorative constant. The documentation's separate promise of *"predictable transaction
costs"* is about DUST being NIGHT-backed rather than market-purchased — it is not a claim
that the fee is invariant to load, and the two are not in tension. At `MIN_COST` the
network is in the state the specification names as the security failure: under-charging,
by a factor of 1.8 × 10¹⁵, with no price to attack it.

### The floor's depth is not specified, and may be misplaced

The specification does contain a `MIN_COST`, but **applies it to the per-dimension price
factors, not to `overall_price`**:

```rust
// spec/cost-model.md
for dimension in dimensions {
    // We use a MIN_COST constant here which still allows upwards adjustment.
    // If this was just MIN_POSITIVE, we might get stuck due to rounding.
    *dimension = max(*dimension, most_expensive_dimension * self.min_ratio, FixedPoint::MIN_COST);
}
```

In the specification's `update()`, `overall_price` receives **no floor at all**. The
implementation inverts this: the dimension factors are clamped only by
`most_expensive_dimension * min_ratio`, and the `MIN_COST` clamp — with its
anti-rounding comment carried across verbatim — is applied to `overall_price` instead:

```rust
// base-crypto/src/cost_model.rs
for dim in dimensions.iter_mut() {
    **dim = FixedPoint::max(**dim, most_expensive_dimension * min_ratio);
}
const MIN_COST: FixedPoint = FixedPoint(100);
updated.overall_price = FixedPoint::max(updated.overall_price, MIN_COST);
```

The rationale in that comment is sound for the quantity the specification applies it to.
The dimension factors are normalized to a mean of 1, so 100 ulp is a sensible epsilon
guarding against rounding pinning a factor near unity. `overall_price` is not normalized:
it begins at 10, which is roughly 1.8 × 10²⁰ ulp. The same constant therefore becomes a
floor eighteen orders of magnitude down.

This matters for how the problem should be understood. The depth of the floor does not read
as a considered economic parameter. It reads as an anti-rounding epsilon relocated from a
normalized factor onto an unnormalized scalar, where its magnitude means something entirely
different.

Two related gaps are worth recording. The curve itself —
`normalized_scaling_curve`, and the `a` parameter that sets the adjustment rate — is
explicitly **"out of scope"** in the specification, so the ±4.5951%/block bound is an
implementation choice with no specified counterpart. And the spec's own README states that
the cost model is among the parts "either not specified or specified to a limited extent",
and does not list `cost-model.md` among the parts of the specification at all.

Finally, the exact 1-SPECK observation has a mechanical explanation in the spec: the fee is
`(… * overall_price * SPECS_PER_DUST).ceil()`, so once the price is low enough that the
product falls below one Speck, every transaction rounds up to exactly 1.

## Use Cases

**A team estimating operating costs.** The reference transaction costs 1 SPECK on mainnet
and preview, and 1.8008 × 10¹⁵ SPECK priced at the genesis value — a spread of fifteen
orders of magnitude arising entirely from where a chain sits in its range. A team
sizing NIGHT holdings from today's mainnet will conclude transactions are free. Nothing
available to them indicates whether that will remain true.

**Wallet fee estimation.** SDK estimates compute against `INITIAL_PARAMETERS` unless an
application fetches live parameters itself. Against mainnet's actual price that overstates
the realized fee by about fifteen orders of magnitude. On the ledger-9 stack the genesis
cost model additionally differs from the live one in 143 lines. The number a user is shown
is not the number they pay.

**Testing fee-sensitive behavior.** Anything that reacts to fee levels — batching, a
relayer, a treasury model — cannot be exercised against any current Midnight network,
because the price cannot leave the floor below 50% fullness and does not move at all on
ledger-9. In our case an experiment designed to observe fee response could not have
produced a reading at any duration.

**Throughput bounds after decentralization.** Under the federated Kūkolu phase, submission
is gated by known operators, so the degraded fee and DUST-cap bounds are backstopped by the
gate. That backstop is phase-specific. As the network decentralizes through Mōhalu and
block production and submission widen, the bounds described above become the operative
ones — and on current evidence they would be operative at 1 SPECK per transaction.

## Goals

1. **The intended behavior of `overall_price` is explicit.** Whether active or flat by
   design, it is documented, and the code matches the documentation.
2. **If congestion pricing is intended, it is effective in the conditions the network
   actually experiences** — including after ordinary quiet periods, and on the timescale of
   a load event rather than after it.
3. **Throughput bounds are stated in terms that hold at the floor.** If DUST capacity is
   the bound, its effectiveness should not silently vary by fifteen orders of magnitude
   with the fee price.
4. **Live fee parameters are observable** without decoding opaque hex with the ledger WASM.
5. **Testnet fee behavior is representative**, or its divergence from mainnet is
   documented and discoverable.

Goals 1 and 2 are the critical pair; 3–5 make them testable.

## Expected Outcomes

Teams sizing NIGHT and DUST get figures that remain valid as the network grows, removing an
order-of-magnitude class of planning error. Whatever throughput bound the design relies on
becomes one whose strength is known rather than incidental to a state variable's history.
The transition through decentralization proceeds with the fee and rationing behavior
characterized in advance rather than discovered afterwards. And anomalies — a price
unchanged for five months, or one unchanged for eighteen days on the successor ledger —
surface from routine monitoring instead of dedicated investigation.

## Open Questions

1. Is mainnet's floor state intended? It has held since block 1,197 of 2,393,873, which is
   either a deliberate outcome or one nobody has had reason to look at.
2. Was applying `MIN_COST` to `overall_price` rather than to the dimension factors
   intentional? The specification applies it to the dimensions and floors `overall_price`
   not at all. If the relocation was deliberate, what is the intended economic meaning of a
   floor at 100 ulp of an unnormalized price?
3. On ledger-9, is `fee_prices` pinned by governance or chain-spec, or is the adjustment
   not running? This determines whether the successor inherits, fixes, or replaces the
   problem.
4. Will the cost model be specified? The spec README lists it among the parts "either not
   specified or specified to a limited extent", `cost-model.md` is not listed among the
   specification's parts, and `normalized_scaling_curve` is out of scope within it. The
   fee-pricing mechanism is the part of transaction handling that remains unspecified.
5. Should the adjustment be symmetric? Symmetric rates over an asymmetric fullness
   distribution produce a floor-seeking equilibrium.
6. Is 0.50 the right crossover, given that a chain at its target utilization would need to
   exceed half full merely to hold its price steady?
7. What is the intended relationship among the five cost dimensions and their limits?
   `bytes_written` is capped at 50,000 against `block_usage` at 1,000,000, and overall
   fullness is the maximum across all five, so the binding dimension varies by transaction
   shape.

## Recommended MIPs

**MIP: Bound the dynamic range of the DUST fee price.** Address the depth of `MIN_COST`
relative to the genesis price — raising the floor, capping the permissible ratio, or
anchoring the floor to something other than an absolute constant. Relates to the finding
that mainnet reached the floor in two hours and that recovery from that depth is slow
regardless of rate.

**MIP: Reconcile the `MIN_COST` clamp with the specification.** Determine whether the floor
belongs on the per-dimension factors, as specified, or on `overall_price`, as implemented,
and set its magnitude for whichever quantity it guards. Relates directly to the divergence
documented above and is the narrowest available change.

**MIP: Asymmetric price adjustment.** Specify separate rise and decay behavior so the
price recovers faster than it decays. Relates to the recovery table and to the
floor-seeking equilibrium produced by symmetric rates. Note this is **secondary to bounding
the range**, and carries a tension: faster recovery raises the cost of the duty-cycle attack
only marginally, while making the out-pricing attack cheaper. It should be evaluated
alongside a range bound rather than instead of one.

**MIP: Specify and document the intended fee-price regime.** Resolve the dichotomy above in
the specification — active congestion pricing or documented-flat — so that implementations,
SDK estimation and ecosystem guidance agree. Relates to Goal 1 and to Open Questions 1–3.

**MIP: Expose live ledger parameters through the indexer.** Provide `overall_price`,
decoded block limits and per-block fullness as first-class fields. Relates to Goals 4 and
5; every measurement in this document required decoding opaque hex with the ledger WASM.

**MIP: Client fee estimation against live parameters.** Define how SDKs obtain and apply the
parameters actually in force rather than `INITIAL_PARAMETERS`, including the
`enforceTimeToDismiss` default. Relates to the wallet fee-estimation use case.

## References

- Ledger specification: `midnight-ledger/spec/cost-model.md` — problem statement,
  "Dimensional Limits & Price Adjustment", `INITIAL_PRICES`, `overall_cost`
- Ledger specification: `midnight-ledger/spec/README.md` — scope disclaimer covering the
  cost model
- Ledger source: `midnight-ledger/base-crypto/src/cost_model.rs` —
  `FeePrices::update_from_fullness`, `MIN_COST`, `price_adjustment_function`
- Ledger source: `midnight-ledger/ledger/src/structure.rs` — `INITIAL_PARAMETERS`
- Mainnet measurements: `indexer.mainnet.midnight.network`, ledger `=8.1.2`, node `1.0.2`,
  sampled 01-Sep-2026 at seventeen heights from block 1 to 2,393,873.
- Preview and stagenet measurements: August–September 2026. Per-block `ledgerParameters`
  decoded with `@midnight-ntwrk/ledger-v8` and `@midnightntwrk/ledger-v9`.
- Midnight documentation, DUST and predictable transaction costs:
  `docs/concepts/how-midnight-works/midnight-combined-model.mdx`
- Load-test findings report, with full methodology and the stagenet load run:
  *Filling Midnight Blocks*.

## Acknowledgements

Measurements were produced during a Midnight preview load test, a stagenet
ledger-9 validation exercise, and a mainnet parameter survey.

## Copyright

This MPS is licensed under CC-BY-4.0.
