#!/usr/bin/env python3
"""
gen_circuits.py — generate Compact contracts spanning a range of circuit sizes (k)
and public-input counts, for the DUST/fullness sweep.

READ THIS FIRST
---------------
1. YOU CANNOT SPECIFY k. The Compact compiler derives it from the circuit. So this
   generates a PADDING LADDER and you discover which k each rung lands on. Use
   sweep_compile.py to do that search and build the padding -> k map empirically.

2. k MOVES IN A STAIRCASE, not a ramp. It only increments when you cross a power of
   two in row count, so many adjacent padding values collapse onto the same k.
   Expect the ladder to be sparse at the low end and coarse at the high end.

3. THE PADDING IS UNROLLED, NOT LOOPED. Every hash round is emitted as its own
   `const` binding. That is deliberate: it uses only language constructs verified
   against real contracts (OpenZeppelin's compact-contracts), and avoids depending
   on loop syntax. The cost is large generated files at high k -- a k=20 circuit may
   need thousands of rounds and take a long time to compile.

4. THIS HAS NOT BEEN COMPILE-VERIFIED by its author. The syntax is modelled on
   working contracts targeting `pragma language_version >= 0.23.0`, but the current
   compiler is 0.31.1 and the toolchain could not be installed to check. RUN THE
   PROBE FIRST:

       python3 gen_circuits.py --probe --out ./circuits
       compact compile ./circuits/Probe.compact ./circuits/out/Probe

   Fix any syntax error in TEMPLATE below, re-probe until it compiles, and only then
   generate the ladder. Everything funnels through one template, so a fix applies
   everywhere.

THE TWO KNOBS ARE ORTHOGONAL, WHICH IS THE POINT
------------------------------------------------
  --rounds N   hash rounds. Pure in-circuit work, touches no ledger state.
               Drives k. Should leave the public-input count untouched.

  --slots M    distinct ledger cells written. Each write is an Impact VM
               instruction, and the ZKIR groups public inputs into blocks with
               "each block corresponding to exactly one VM instruction"
               (transient-crypto/src/proofs.rs). So this drives the public input
               count, and barely touches k.

That separation is what lets you attribute a fee change to circuit size versus
public inputs. `proof_verify(size)` in the ledger cost model is parameterized by
public input count and NOT by k, so the prediction is that --slots moves the fee
and --rounds does not. Holding one fixed while sweeping the other is the test.

USAGE
-----
  python3 gen_circuits.py --probe --out ./circuits
  python3 gen_circuits.py --rounds 64 --slots 4 --name K12_S4 --out ./circuits
  python3 gen_circuits.py --ladder --out ./circuits      # a full starting ladder
"""

from __future__ import annotations

import argparse
import os

# ---------------------------------------------------------------------------
# Template. Every construct here appears in shipped OpenZeppelin contracts:
#   pragma language_version, import CompactStandardLibrary, export ledger,
#   witness, export circuit, disclose(), persistentHash<Vector<N, Bytes<32>>>([..])
# If the compiler rejects something, fix it HERE and regenerate everything.
# ---------------------------------------------------------------------------
HEADER = """// GENERATED FILE -- do not edit by hand. Produced by gen_circuits.py.
// Synthetic benchmark circuit for DUST cost / block fullness measurement.
//   hash rounds : {rounds}   (drives circuit size k)
//   ledger slots: {slots}    (drives public input count)

pragma language_version >= 0.23.0;

import CompactStandardLibrary;
"""

LEDGER_ACC = """
// Accumulator for the padding chain. One write, constant across all variants,
// so it does not pollute the public-input count when sweeping --rounds.
export ledger acc: Bytes<32>;
"""

LEDGER_SLOT = "export ledger slot{i}: Bytes<32>;\n"

WITNESS = """
// Private seed. Kept as a witness so the padding chain depends on secret data and
// cannot be constant-folded away by the compiler.
witness wit_seed(): Bytes<32>;
"""

CIRCUIT_OPEN = """
export circuit run(): [] {
  const h0 = disclose(wit_seed());
"""

# Each round folds the running value with the seed. Depending on both the previous
# round and the seed makes the chain strictly sequential, so the optimizer cannot
# collapse it or compute rounds in parallel.
ROUND = "  const h{i} = persistentHash<Vector<2, Bytes<32>>>([h{prev}, h0]);\n"

CIRCUIT_CLOSE_ACC = "\n  acc = h{last};\n"
CIRCUIT_SLOT_WRITE = "  slot{i} = h{last};\n"
CIRCUIT_END = "}\n"


def render(rounds: int, slots: int) -> str:
    if rounds < 1:
        raise ValueError("--rounds must be >= 1")
    if slots < 0:
        raise ValueError("--slots must be >= 0")

    parts = [HEADER.format(rounds=rounds, slots=slots), LEDGER_ACC]
    if slots:
        parts.append("\n// Public-input knob: one Impact VM write instruction each.\n")
        for i in range(slots):
            parts.append(LEDGER_SLOT.format(i=i))
    parts.append(WITNESS)
    parts.append(CIRCUIT_OPEN)

    for i in range(1, rounds + 1):
        parts.append(ROUND.format(i=i, prev=i - 1))

    parts.append(CIRCUIT_CLOSE_ACC.format(last=rounds))
    for i in range(slots):
        parts.append(CIRCUIT_SLOT_WRITE.format(i=i, last=rounds))
    parts.append(CIRCUIT_END)
    return "".join(parts)


PROBE = """// GENERATED probe -- compile this FIRST, before generating the ladder.
// Smallest circuit exercising every construct the generator relies on:
// ledger cells, a witness, disclose(), a persistentHash chain, and ledger writes.
// If this compiles, the template is sound and the ladder will generate cleanly.

pragma language_version >= 0.23.0;

import CompactStandardLibrary;

export ledger acc: Bytes<32>;
export ledger slot0: Bytes<32>;

witness wit_seed(): Bytes<32>;

export circuit run(): [] {
  const h0 = disclose(wit_seed());
  const h1 = persistentHash<Vector<2, Bytes<32>>>([h0, h0]);
  const h2 = persistentHash<Vector<2, Bytes<32>>>([h1, h0]);
  acc = h2;
  slot0 = h2;
}
"""

# A geometric ladder. Rounds roughly double each rung, so if rows scale linearly
# with rounds the resulting k should step by about 1 per rung. Where it actually
# lands is what sweep_compile.py measures -- these are starting points, not targets.
DEFAULT_LADDER = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192]

# Public-input ladder, swept at a fixed round count so k stays put.
DEFAULT_SLOTS = [0, 1, 2, 4, 8, 16, 32]


def write(path, text, verbose=True):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        f.write(text)
    if verbose:
        print(f"  {path}  ({len(text.splitlines())} lines, {len(text):,} bytes)")


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Generate parameterized Compact circuits for the k / public-input sweep.",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="./circuits", help="output directory")
    ap.add_argument("--probe", action="store_true",
                    help="emit only the syntax probe; compile this before anything else")
    ap.add_argument("--ladder", action="store_true",
                    help="emit the full starting ladder (both knobs)")
    ap.add_argument("--rounds", type=int, help="hash rounds for a single variant")
    ap.add_argument("--slots", type=int, default=0, help="ledger slots for a single variant")
    ap.add_argument("--name", help="contract name for a single variant")
    ap.add_argument("--fixed-rounds", type=int, default=64,
                    help="round count held constant while sweeping slots (default 64)")
    args = ap.parse_args(argv)

    os.makedirs(args.out, exist_ok=True)

    if args.probe:
        print("probe:")
        write(os.path.join(args.out, "Probe.compact"), PROBE)
        print("\nCompile this before generating anything else, e.g.:")
        print(f"  compact compile {args.out}/Probe.compact {args.out}/out/Probe")
        print("\nIf it fails, fix TEMPLATE in gen_circuits.py and re-run --probe.")
        return 0

    if args.ladder:
        print("k ladder (rounds vary, slots fixed at 0 so public inputs stay constant):")
        for r in DEFAULT_LADDER:
            write(os.path.join(args.out, f"BenchR{r}_S0.compact"), render(r, 0))
        print(f"\npublic-input ladder (slots vary, rounds fixed at {args.fixed_rounds} "
              f"so k stays put):")
        for s in DEFAULT_SLOTS:
            if s == 0:
                continue  # already emitted above at rounds=fixed only if it matches
            write(os.path.join(args.out, f"BenchR{args.fixed_rounds}_S{s}.compact"),
                  render(args.fixed_rounds, s))
        write(os.path.join(args.out, "Probe.compact"), PROBE)
        print("\nNext: compile the probe, then run sweep_compile.py to find which k "
              "each rung actually lands on.")
        return 0

    if args.rounds is None:
        ap.error("give --probe, --ladder, or --rounds N")
    name = args.name or f"BenchR{args.rounds}_S{args.slots}"
    write(os.path.join(args.out, f"{name}.compact"), render(args.rounds, args.slots))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
