#!/usr/bin/env python3
"""
record_k.py — append one (name, k, rows) row to artifacts.csv by hand, for when
compile_all.sh couldn't parse the compiler's stdout automatically.

Use this to unblock yourself immediately: run each small variant manually,
read the "circuit "run" (k=X, rows=Y)" line off the terminal yourself, and
record it. For the cheap ladder (R1..R64_*) this is ~13 one-line compiles you
likely already have most of.

  compact compile small/BenchR8_S0.compact /tmp/throwaway
    Compiling 1 circuits:
      circuit "run" (k=15, rows=22114)
  python3 record_k.py --out artifacts.csv --name BenchR8_S0 --rounds 8 --slots 0 --k 15 --rows 22114

Repeat per variant. --managed lets it also verify the compiled dir is intact
(has keys/, zkir/, contract/) so make_manifest.py won't reject it later; omit
if you only care about recording the number for now.

Writes/appends artifacts.csv in the same column shape sweep_compile.py uses, so
make_manifest.py reads it unchanged:
  python3 make_manifest.py --managed out_small --artifacts artifacts.csv --out ladder.json
"""

import argparse
import csv
import os

COLUMNS = ["source", "rounds", "slots", "compiled", "compile_s", "k", "k_source",
           "vk_bytes", "pk_bytes", "zkir_bytes", "total_artifact_bytes",
           "src_bytes", "error"]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="artifacts.csv")
    ap.add_argument("--name", required=True, help="e.g. BenchR8_S0")
    ap.add_argument("--rounds", type=int, required=True)
    ap.add_argument("--slots", type=int, required=True)
    ap.add_argument("--k", type=int, required=True)
    ap.add_argument("--rows", type=int)
    ap.add_argument("--managed", help="optional: path to the compiled dir, to fill "
                                       "in vk/pk/zkir sizes and sanity-check it exists")
    args = ap.parse_args()

    row = {c: "" for c in COLUMNS}
    row.update({
        "source": f"{args.name}.compact",
        "rounds": args.rounds, "slots": args.slots,
        "compiled": True, "k": args.k, "k_source": "manual",
    })

    if args.managed:
        keys = os.path.join(args.managed, "keys")
        zkir = os.path.join(args.managed, "zkir")
        contract = os.path.join(args.managed, "contract", "index.js")
        missing = [p for p in (keys, zkir, contract) if not os.path.exists(p)]
        if missing:
            print(f"warning: {args.name}: missing {missing} under {args.managed} "
                  f"-- recorded k anyway, but make_manifest.py will still reject "
                  f"this dir until they exist")
        else:
            def size_of(d, marker):
                total, hit = 0, False
                for f in os.listdir(d):
                    if marker in f.lower():
                        total += os.path.getsize(os.path.join(d, f))
                        hit = True
                return total if hit else ""
            row["vk_bytes"] = size_of(keys, "verifier")
            row["pk_bytes"] = size_of(keys, "prover")
            row["zkir_bytes"] = sum(os.path.getsize(os.path.join(zkir, f))
                                    for f in os.listdir(zkir))

    exists = os.path.exists(args.out)
    # Overwrite any existing row for this same source (idempotent re-entry).
    rows = []
    if exists:
        with open(args.out) as f:
            rows = [r for r in csv.DictReader(f) if r["source"] != row["source"]]
    rows.append(row)

    with open(args.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)

    print(f"{args.name}: k={args.k}" + (f" rows={args.rows}" if args.rows else "") +
          f"  -> {args.out} ({len(rows)} total entries)")


if __name__ == "__main__":
    main()
