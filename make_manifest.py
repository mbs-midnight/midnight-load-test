#!/usr/bin/env python3
"""
make_manifest.py — build ladder.json (the deploy manifest) from your compiled
contracts. Bridges sweep_compile.py's output to deploy.ts.

For the 4-5 contract plan (k=14..19, varying slots), point it at the managed
output directories the compiler produced:

  python3 make_manifest.py \\
      --managed circuits/managed/BenchR220_S0 \\
      --managed circuits/managed/BenchR880_S0 \\
      --managed circuits/managed/BenchR3500_S4 \\
      --managed circuits/managed/BenchR14000_S8 \\
      --artifacts artifacts.csv \\
      --out ladder.json

It reads rounds/slots from the directory name (BenchR{rounds}_S{slots}), pulls k
from artifacts.csv if given (else leaves it for you to fill), discovers circuit
names from the managed keys/ directory, and verifies the three things deploy.ts
needs actually exist: keys/, zkir/, contract/index.js. Anything missing is an
error now instead of a mid-deploy failure later.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys


def parse_name(path):
    m = re.search(r"R(\d+)_S(\d+)", os.path.basename(path.rstrip("/")))
    return (int(m.group(1)), int(m.group(2))) if m else (None, None)


def is_managed_dir(path):
    return os.path.isdir(os.path.join(path, "keys"))


def expand_managed(path):
    """Accept either a compiled managed dir itself, or a parent directory of
    several. Returns (list_of_dirs, note)."""
    path = os.path.abspath(path)
    if is_managed_dir(path):
        return [path], None
    if os.path.isdir(path):
        subs = sorted(
            os.path.join(path, d) for d in os.listdir(path)
            if is_managed_dir(os.path.join(path, d))
        )
        if subs:
            return subs, f"{path}: expanded to {len(subs)} managed dirs"
    return [], (f"{path}: not a managed dir (no keys/) and no managed "
                f"subdirectories found. Point --managed at the compiler output "
                f"directory that contains keys/, zkir/ and contract/, or at a "
                f"parent holding several of them.")


def discover_circuits(managed):
    """Circuit names from the keys/ directory: files are typically
    <circuit>.prover / <circuit>.verifier (layout varies slightly by compiler
    version, so strip known suffixes and dedupe)."""
    keys = os.path.join(managed, "keys")
    names = set()
    if os.path.isdir(keys):
        for fn in os.listdir(keys):
            base = re.sub(r"\.(prover|verifier|pk|vk|bin)$", "", fn)
            if base:
                names.add(base)
    return sorted(names)


def main():
    ap = argparse.ArgumentParser(description="Build ladder.json for deploy.ts")
    ap.add_argument("--managed", action="append", required=True,
                    help="a compiled managed dir (contains keys/), OR a parent "
                         "directory holding several; repeatable")
    ap.add_argument("--artifacts", help="artifacts.csv from sweep_compile.py, for k values")
    ap.add_argument("--out", default="ladder.json")
    ap.add_argument("--k", type=int, help="override k (only valid with exactly one contract)")
    ap.add_argument("--rounds", type=int, help="override rounds (single contract only)")
    ap.add_argument("--slots", type=int, help="override slots (single contract only)")
    ap.add_argument("--name", help="override name (single contract only)")
    args = ap.parse_args()

    k_by_name = {}
    k_by_rs = {}
    if args.artifacts:
        with open(args.artifacts) as f:
            rows = list(csv.DictReader(f))
        if rows:
            cols = set(rows[0].keys())
            # Two known shapes: sweep_compile.py's artifacts.csv (source, rounds,
            # slots, k, ...) and compile_all.sh's compile_log.csv (name, source,
            # k, rows, seconds, status, error). Detect and read either.
            is_compile_log = {"name", "status"}.issubset(cols)
            for r in rows:
                if is_compile_log:
                    if r.get("status") != "ok" or r.get("k") in ("", None):
                        continue
                    nm = r["name"]
                    kk = int(r["k"])
                    k_by_name[nm] = kk
                    # compile_log.csv has no rounds/slots columns at all (only
                    # k and the ZK row count) -- name-based lookup is the only
                    # path for this format, which is fine since compile_all.sh
                    # names dirs after the source file 1:1.
                else:
                    nm = os.path.splitext(r["source"])[0]
                    if r.get("k") in ("", None):
                        continue
                    kk = int(r["k"])
                    k_by_name[nm] = kk
                    try:
                        k_by_rs[(int(r["rounds"]), int(r["slots"]))] = kk
                    except (TypeError, ValueError, KeyError):
                        pass

    # Expand parent dirs into their managed children.
    dirs = []
    errors = []
    for m in args.managed:
        expanded, note = expand_managed(m)
        if not expanded:
            errors.append(note)
        else:
            if note:
                print(note, file=sys.stderr)
            dirs.extend(expanded)

    if len(dirs) != 1 and any(v is not None for v in (args.k, args.rounds, args.slots, args.name)):
        errors.append("--k/--rounds/--slots/--name overrides only apply when exactly "
                      f"one contract is being processed (found {len(dirs)})")

    entries = []
    for managed in dirs:
        name = args.name or os.path.basename(managed.rstrip("/"))
        rounds, slots = parse_name(managed)
        if args.rounds is not None:
            rounds = args.rounds
        if args.slots is not None:
            slots = args.slots

        for req, why in (("keys", "prover/verifier keys"),
                         ("zkir", "ZK IR"),
                         (os.path.join("contract", "index.js"), "JS contract module")):
            if not os.path.exists(os.path.join(managed, req)):
                errors.append(f"{name}: missing {req} ({why}) under {managed}")

        circuits = discover_circuits(managed)
        if not circuits:
            errors.append(f"{name}: no circuit names discovered under keys/")

        k = args.k if args.k is not None else k_by_name.get(name)
        if k is None and rounds is not None:
            # fall back: unique (rounds, slots) match in artifacts.csv
            hits = [kk for (rr, ss), kk in k_by_rs.items() if rr == rounds and ss == slots]
            if len(hits) == 1:
                k = hits[0]
        if k is None:
            hint = (f"dir name {name!r} does not carry R<rounds>_S<slots>"
                    if rounds is None else
                    f"no artifacts.csv row named {name} or with rounds={rounds}, slots={slots}")
            errors.append(f"{name}: k unknown ({hint}). Fixes: rename the dir to the "
                          f"Bench naming, pass --artifacts with a matching row, or for a "
                          f"single contract pass --k/--rounds/--slots explicitly.")

        entries.append({
            "name": name,
            "k": k,
            "rounds": rounds,
            "slots": slots,
            "managedDir": managed,
            "circuitNames": circuits,
        })

    if errors:
        print("manifest NOT written; fix these first:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    entries.sort(key=lambda e: (e["k"] is None, e["k"]))
    with open(args.out, "w") as f:
        json.dump(entries, f, indent=2)
    print(f"wrote {args.out}:")
    for e in entries:
        print(f"  k={e['k']:<3} rounds={e['rounds']:<7} slots={e['slots']:<3} "
              f"circuits={','.join(e['circuitNames'])}  {e['name']}")


if __name__ == "__main__":
    main()