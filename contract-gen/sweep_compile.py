#!/usr/bin/env python3
"""
sweep_compile.py — compile the generated Compact variants, record what the compiler
produced, and search for the padding that lands on each target k.

This is the "free/cheap, no chain" measurement: verifier key size, prover key size,
ZKIR size and circuit size k, all from compiler artifacts. No proof server, no node,
no NIGHT, no DUST.

WHAT IT CANNOT ASSUME
---------------------
The artifact directory layout and where the compiler records k are NOT hardcoded,
because they vary by compiler version and could not be verified when this was
written. Instead:

  * --inspect compiles ONE variant and dumps the entire output tree with sizes, so
    you can see the layout for your compiler version.
  * k extraction tries, in order: a regex over compiler stdout/stderr, then a scan
    of JSON artifacts for a plausible key. If both miss, it records k as blank and
    tells you -- then you pass --k-json-key or --k-regex once you know where it lives.
  * Artifact classification is by filename substring, overridable via --vk-match /
    --pk-match / --zkir-match.

Nothing here silently guesses. A blank column means "not found", never a default.

USAGE
-----
  # 0. see what your compiler emits, and where k lives
  python3 sweep_compile.py --inspect circuits/Probe.compact

  # 1. compile everything and tabulate
  python3 sweep_compile.py --dir ./circuits --out artifacts.csv

  # 2. once k extraction works, search for the rounds that hit each target k
  python3 sweep_compile.py --bisect 10,12,14,16,18,20 --out ladder.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

DEFAULT_VK_MATCH = "verifier"
DEFAULT_PK_MATCH = "prover"
DEFAULT_ZKIR_MATCH = "zkir"

# Ordered guesses for a k / row-count field in compiler output. First hit wins, and
# the matched pattern is recorded so you can see which one fired.
K_REGEXES = [
    r"\bk\s*[=:]\s*(\d+)",
    r"circuit size[^0-9]{0,20}(\d+)",
    r"\brows?\s*[=:]\s*(\d+)",
    r"log2[^0-9]{0,10}(\d+)",
    r"degree\s*[=:]\s*(\d+)",
]
K_JSON_KEYS = ["k", "log_n", "logN", "num_rows", "rows", "circuit_size", "degree"]


def run_compile(src, outdir, compact_bin, extra_args, timeout):
    """Invoke the compiler. Returns (ok, stdout+stderr, seconds)."""
    cmd = [compact_bin, "compile"] + list(extra_args) + [src, outdir]
    t0 = time.time()
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        out = (p.stdout or "") + (p.stderr or "")
        return p.returncode == 0, out, time.time() - t0
    except subprocess.TimeoutExpired:
        return False, f"TIMEOUT after {timeout}s", time.time() - t0
    except FileNotFoundError:
        raise SystemExit(f"compiler not found: {compact_bin!r}. Pass --compact-bin.")


def walk_artifacts(outdir):
    """Every file under outdir with its size."""
    found = []
    for root, _dirs, files in os.walk(outdir):
        for fn in files:
            full = os.path.join(root, fn)
            try:
                found.append((os.path.relpath(full, outdir), os.path.getsize(full)))
            except OSError:
                pass
    return sorted(found)


def classify(files, vk_m, pk_m, zkir_m):
    """Sum sizes of files whose path matches each marker. Prover keys are matched
    before verifier keys are excluded, since 'prover' and 'verifier' can co-occur
    in a directory name."""
    def total(marker, exclude=None):
        s = 0
        hits = []
        for path, size in files:
            low = path.lower()
            if marker in low and (exclude is None or exclude not in low):
                s += size
                hits.append(path)
        return (s if hits else None), hits

    vk, vk_files = total(vk_m)
    pk, pk_files = total(pk_m)
    zkir, zkir_files = total(zkir_m)
    return {"vk_bytes": vk, "pk_bytes": pk, "zkir_bytes": zkir,
            "vk_files": vk_files, "pk_files": pk_files, "zkir_files": zkir_files}


def extract_k(log, outdir, k_regex=None, k_json_key=None):
    """Try hard to find k; report how it was found, or that it wasn't."""
    pats = ([k_regex] if k_regex else []) + K_REGEXES
    for pat in pats:
        m = re.search(pat, log, re.IGNORECASE)
        if m:
            return int(m.group(1)), f"stdout:{pat}"

    keys = ([k_json_key] if k_json_key else []) + K_JSON_KEYS
    for root, _d, files in os.walk(outdir):
        for fn in files:
            if not fn.endswith(".json"):
                continue
            try:
                with open(os.path.join(root, fn)) as f:
                    doc = json.load(f)
            except Exception:
                continue
            stack = [doc]
            while stack:
                node = stack.pop()
                if isinstance(node, dict):
                    for key in keys:
                        v = node.get(key)
                        if isinstance(v, int) and 0 < v < 64:
                            return v, f"json:{fn}:{key}"
                    stack.extend(node.values())
                elif isinstance(node, list):
                    stack.extend(node)
    return None, "NOT FOUND"


def parse_rounds_slots(path):
    m = re.search(r"R(\d+)_S(\d+)", os.path.basename(path))
    return (int(m.group(1)), int(m.group(2))) if m else (None, None)


COLUMNS = ["source", "rounds", "slots", "compiled", "compile_s", "k", "k_source",
           "vk_bytes", "pk_bytes", "zkir_bytes", "total_artifact_bytes",
           "src_bytes", "error"]


def compile_one(src, args, workdir=None):
    tmp = workdir or tempfile.mkdtemp(prefix="csweep_")
    outdir = os.path.join(tmp, os.path.splitext(os.path.basename(src))[0])
    os.makedirs(outdir, exist_ok=True)
    ok, log, secs = run_compile(src, outdir, args.compact_bin,
                                args.compiler_arg or [], args.timeout)
    files = walk_artifacts(outdir)
    cls = classify(files, args.vk_match, args.pk_match, args.zkir_match)
    k, ksrc = extract_k(log, outdir, args.k_regex, args.k_json_key) if ok else (None, "")
    rounds, slots = parse_rounds_slots(src)
    row = {
        "source": os.path.basename(src), "rounds": rounds, "slots": slots,
        "compiled": ok, "compile_s": round(secs, 2),
        "k": k if k is not None else "", "k_source": ksrc,
        "vk_bytes": cls["vk_bytes"] if cls["vk_bytes"] is not None else "",
        "pk_bytes": cls["pk_bytes"] if cls["pk_bytes"] is not None else "",
        "zkir_bytes": cls["zkir_bytes"] if cls["zkir_bytes"] is not None else "",
        "total_artifact_bytes": sum(s for _p, s in files),
        "src_bytes": os.path.getsize(src),
        "error": "" if ok else log.strip().splitlines()[-1][:200] if log.strip() else "failed",
    }
    return row, files, log, outdir, tmp


def main(argv=None):
    ap = argparse.ArgumentParser(description="Compile Compact variants and tabulate artifacts.")
    ap.add_argument("--dir", default="./circuits", help="directory of .compact files")
    ap.add_argument("--out", default="artifacts.csv")
    ap.add_argument("--compact-bin", default="compact")
    ap.add_argument("--compiler-arg", action="append",
                    help="extra arg passed through to `compact compile`; repeatable")
    ap.add_argument("--timeout", type=int, default=1800)
    ap.add_argument("--inspect", metavar="FILE",
                    help="compile one file and dump the full artifact tree")
    ap.add_argument("--rescan-dir", metavar="DIR",
                    help="do NOT recompile. Scan a parent dir of already-compiled "
                         "managed dirs (each with keys/) for k, via JSON artifacts "
                         "only -- no compiler stdout is available post-hoc. Writes "
                         "an artifacts.csv-compatible file. Use this to recover k "
                         "after compile_all.sh already ran, instead of recompiling.")
    ap.add_argument("--rescan-tree", action="store_true",
                    help="with --rescan-dir: dump the full file tree (and small "
                         "text/json file contents) for the first managed dir where "
                         "k was NOT found, so you can see exactly what compiler/ "
                         "contains and tell me where k actually lives")
    ap.add_argument("--bisect", metavar="K_LIST",
                    help="comma-separated target k values to search for")
    ap.add_argument("--slots-for-bisect", type=int, default=0)
    ap.add_argument("--max-rounds", type=int, default=200_000)
    ap.add_argument("--vk-match", default=DEFAULT_VK_MATCH)
    ap.add_argument("--pk-match", default=DEFAULT_PK_MATCH)
    ap.add_argument("--zkir-match", default=DEFAULT_ZKIR_MATCH)
    ap.add_argument("--k-regex", help="regex with one capture group for k in compiler output")
    ap.add_argument("--k-json-key", help="JSON key holding k in an artifact")
    ap.add_argument("--keep", action="store_true", help="keep build dirs")
    args = ap.parse_args(argv)

    # ---- rescan (no compilation, recover k from existing output) ----------
    if args.rescan_dir:
        parent = args.rescan_dir
        children = sorted(
            os.path.join(parent, d) for d in os.listdir(parent)
            if os.path.isdir(os.path.join(parent, d, "keys"))
        )
        if not children:
            if os.path.isdir(os.path.join(parent, "keys")):
                children = [parent]
            else:
                raise SystemExit(f"no managed dirs (containing keys/) found under {parent}")

        print(f"rescanning {len(children)} managed dir(s) under {parent} -- no compilation")
        rows = []
        dumped_tree = False
        for managed in children:
            name = os.path.basename(managed.rstrip("/"))
            rounds, slots = parse_rounds_slots(name + ".compact")
            files = walk_artifacts(managed)
            cls = classify(files, args.vk_match, args.pk_match, args.zkir_match)
            # No compiler stdout available post-hoc -- log="" means only the JSON
            # artifact scan runs, never the regex-over-stdout path.
            k, ksrc = extract_k("", managed, args.k_regex, args.k_json_key)
            row = {
                "source": f"{name}.compact", "rounds": rounds, "slots": slots,
                "compiled": True, "compile_s": "",
                "k": k if k is not None else "", "k_source": ksrc,
                "vk_bytes": cls["vk_bytes"] if cls["vk_bytes"] is not None else "",
                "pk_bytes": cls["pk_bytes"] if cls["pk_bytes"] is not None else "",
                "zkir_bytes": cls["zkir_bytes"] if cls["zkir_bytes"] is not None else "",
                "total_artifact_bytes": sum(sz for _p, sz in files),
                "src_bytes": "", "error": "" if k is not None else "k not found in JSON artifacts",
            }
            rows.append(row)
            print(f"  {name:<28} k={row['k'] or '?':<4} vk={row['vk_bytes'] or '?':<8} "
                  f"({ksrc})")
            if k is None and args.rescan_tree and not dumped_tree:
                dumped_tree = True
                print(f"\n  k not found for {name}. Full tree, so you can tell me where "
                      f"it actually lives:")
                for path, size in files:
                    print(f"    {size:>12,}  {path}")
                    if path.endswith(('.json', '.txt', '.toml', '.yaml', '.yml')) and size < 20_000:
                        try:
                            with open(os.path.join(managed, path)) as fh:
                                content = fh.read()
                            print(f"      --- contents ---")
                            for l in content.splitlines()[:40]:
                                print(f"      {l}")
                        except Exception as e:
                            print(f"      (could not read: {e})")
                print()

        with open(args.out, "w", newline="") as f:
            wr = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction="ignore")
            wr.writeheader()
            wr.writerows(rows)
        found = sum(1 for r in rows if r["k"] != "")
        print(f"\n{found}/{len(rows)} k values recovered -> {args.out}")
        if found < len(rows):
            print(f"{len(rows)-found} unresolved. Re-run with --rescan-tree to dump the "
                  f"tree for the first one, or check the 'compiler/' subdirectory by hand "
                  f"for a manifest/receipt file with the k value in it.")
        return 0

    # ---- inspect -----------------------------------------------------------
    if args.inspect:
        row, files, log, outdir, tmp = compile_one(args.inspect, args)
        print(f"compiled: {row['compiled']}   {row['compile_s']}s")
        if log.strip():
            print("\n--- compiler output ---")
            print(log.strip()[:3000])
        print(f"\n--- artifact tree ({len(files)} files, "
              f"{row['total_artifact_bytes']:,} bytes) ---")
        for path, size in files:
            print(f"  {size:>12,}  {path}")
        print(f"\nk = {row['k'] or 'NOT FOUND'}   (via {row['k_source']})")
        if not row["k"]:
            print("\nk was not found. Look through the tree above for a row count or\n"
                  "degree, then re-run with --k-regex or --k-json-key. Everything else\n"
                  "in the sweep works without it, but the ladder needs it.")
        print(f"\nclassified: vk={row['vk_bytes']} pk={row['pk_bytes']} "
              f"zkir={row['zkir_bytes']}")
        print(f"build dir: {outdir}")
        if not args.keep:
            shutil.rmtree(tmp, ignore_errors=True)
        return 0

    # ---- bisect ------------------------------------------------------------
    if args.bisect:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        try:
            from gen_circuits import render
        except ImportError:
            raise SystemExit("--bisect needs gen_circuits.py alongside this script")

        targets = [int(x) for x in args.bisect.split(",")]
        tmp = tempfile.mkdtemp(prefix="cbisect_")
        cache = {}

        def k_for(rounds):
            if rounds in cache:
                return cache[rounds]
            src = os.path.join(tmp, f"BenchR{rounds}_S{args.slots_for_bisect}.compact")
            with open(src, "w") as f:
                f.write(render(rounds, args.slots_for_bisect))
            row, _f, _l, _o, _t = compile_one(src, args, workdir=tmp)
            k = row["k"] if row["k"] != "" else None
            cache[rounds] = (k, row)
            print(f"  rounds={rounds:<7} k={k}  vk={row['vk_bytes']}  "
                  f"{row['compile_s']}s  {'ok' if row['compiled'] else 'FAILED'}")
            return cache[rounds]

        k0, _ = k_for(1)
        if k0 is None:
            raise SystemExit(
                "k extraction failed on the smallest circuit, so bisection cannot "
                "work. Run --inspect first and supply --k-regex or --k-json-key.")

        results = []
        for target in targets:
            print(f"\nsearching for k={target}:")
            if k0 >= target:
                print(f"  minimum circuit is already k={k0}; k={target} unreachable")
                continue
            lo, hi = 1, 2
            while True:
                k, _row = k_for(hi)
                if k is None:
                    print("  compile failed while growing; stopping")
                    break
                if k >= target or hi >= args.max_rounds:
                    break
                lo, hi = hi, hi * 2
            while lo + 1 < hi:
                mid = (lo + hi) // 2
                k, _row = k_for(mid)
                if k is None:
                    break
                if k < target:
                    lo = mid
                else:
                    hi = mid
            k, row = k_for(hi)
            if k == target:
                print(f"  -> k={target} at rounds={hi}")
                results.append(row)
            else:
                print(f"  -> no rounds value yields exactly k={target} "
                      f"(nearest {k} at rounds={hi}). The staircase skipped it.")

        with open(args.out, "w", newline="") as f:
            wr = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction="ignore")
            wr.writeheader()
            for r in sorted(results, key=lambda r: r["k"]):
                wr.writerow(r)
        print(f"\nwrote {args.out}")
        if not args.keep:
            shutil.rmtree(tmp, ignore_errors=True)
        return 0

    # ---- compile everything ------------------------------------------------
    srcs = sorted(os.path.join(args.dir, f) for f in os.listdir(args.dir)
                  if f.endswith(".compact"))
    if not srcs:
        raise SystemExit(f"no .compact files in {args.dir}")
    print(f"compiling {len(srcs)} variants")

    rows = []
    for src in srcs:
        row, _files, _log, _outdir, tmp = compile_one(src, args)
        rows.append(row)
        print(f"  {row['source']:<28} k={row['k'] or '?':<4} "
              f"vk={row['vk_bytes'] or '?':<8} pk={row['pk_bytes'] or '?':<10} "
              f"{row['compile_s']:>7}s  {'ok' if row['compiled'] else 'FAILED: ' + row['error']}")
        if not args.keep:
            shutil.rmtree(tmp, ignore_errors=True)

    with open(args.out, "w", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction="ignore")
        wr.writeheader()
        wr.writerows(rows)

    ok = [r for r in rows if r["compiled"]]
    vks = [r["vk_bytes"] for r in ok if r["vk_bytes"] != ""]
    print(f"\n{len(ok)}/{len(rows)} compiled -> {args.out}")
    if vks:
        print(f"verifier key bytes: min {min(vks):,}  max {max(vks):,}")
        if max(vks) == min(vks):
            print("  VK size is CONSTANT across the sweep. Ledger 9's cost_with_state")
            print("  will therefore not introduce a k-dependence either.")
        else:
            print("  VK size VARIES. On ledger 8 fees are unaffected (the cost model")
            print("  hardcodes VERIFIER_KEY_SIZE = 2875), but ledger 9 reads real sizes")
            print("  from state, so bigger circuits would cost more to call.")
        if max(vks) > 2875:
            print(f"  NOTE: max VK ({max(vks):,} B) exceeds the cost model's assumed")
            print("  2,875 B, so ledger 8 is under-charging these contract calls.")
        if max(vks) > 50_000:
            print("  WARNING: exceeds VerifierKey MAX_EXPECTED_SIZE of 50,000 B -- these")
            print("  will fail to deserialize. You have found the hard ceiling on k.")
    if not any(r["k"] != "" for r in ok):
        print("\nk was not extracted for any variant. Run --inspect and supply "
              "--k-regex or --k-json-key.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())