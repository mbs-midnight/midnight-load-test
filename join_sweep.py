#!/usr/bin/env python3
"""
join_sweep.py — produce the final "DUST and fullness vs k" table.

Joins the harness's calls.jsonl (txId -> k) against midnight_dust_probe.py's
transactions.csv (txId -> fee, size, dimensions) and blocks.csv (fullness), then
summarizes per k. This is the deliverable the whole exercise was for.

  python3 join_sweep.py --calls harness/calls.jsonl \\
      --transactions sweep_out/transactions.csv \\
      --blocks sweep_out/blocks.csv \\
      --out by_k.csv

Reports, per k: call count, median/p90 fee in DUST, median SPECK/byte, median tx
size, and the fullness of the blocks those calls landed in. Also emits the
control check: does fee track k (expected: no) or public-input count (expected:
via slots)?
"""

from __future__ import annotations

import argparse
import csv
import json
import statistics
from collections import defaultdict

SPECKS_PER_DUST = 1_000_000_000_000_000


def load_calls(path):
    """txId -> {k, slots, rounds, name}. Skips failed calls (no txId)."""
    out = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            tx = rec.get("txId")
            if tx:
                out[tx] = rec
    return out


def load_tx(path):
    """txId/tx_hash -> row from the probe's transactions.csv."""
    out = {}
    with open(path) as f:
        for r in csv.DictReader(f):
            for key in (r.get("tx_id"), r.get("tx_hash")):
                if key:
                    out[key] = r
    return out


def load_blocks(path):
    out = {}
    with open(path) as f:
        for r in csv.DictReader(f):
            out[r["height"]] = r
    return out


def fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def pct(vals, q):
    if not vals:
        return None
    s = sorted(vals)
    if len(s) == 1:
        return s[0]
    pos = q * (len(s) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def main():
    ap = argparse.ArgumentParser(description="Join sweep calls to probe output; summarize per k.")
    ap.add_argument("--calls", required=True)
    ap.add_argument("--transactions", required=True)
    ap.add_argument("--blocks")
    ap.add_argument("--out", default="by_k.csv")
    ap.add_argument("--out-slots", default="by_slots.csv")
    args = ap.parse_args()

    calls = load_calls(args.calls)
    txs = load_tx(args.transactions)
    blocks = load_blocks(args.blocks) if args.blocks else {}

    matched, unmatched = [], 0
    for tx_id, call in calls.items():
        row = txs.get(tx_id)
        if not row:
            unmatched += 1
            continue
        fee_speck = fnum(row.get("fee_speck"))
        size = fnum(row.get("size_bytes"))
        blk = blocks.get(row.get("height"), {})
        matched.append({
            "k": call.get("k"),
            "slots": call.get("slots"),
            "rounds": call.get("rounds"),
            "fee_speck": fee_speck,
            "fee_dust": fee_speck / SPECKS_PER_DUST if fee_speck is not None else None,
            "size_bytes": size,
            "speck_per_byte": (fee_speck / size) if (fee_speck and size) else None,
            "height": row.get("height"),
            "block_usage_fullness": fnum(blk.get("block_usage_fullness")),
            "status": row.get("status"),
        })

    print(f"matched {len(matched)} calls to indexer transactions "
          f"({unmatched} unmatched -- likely not yet indexed or failed pre-submit)")

    def summarize(rows, key):
        groups = defaultdict(list)
        for r in rows:
            if r[key] is not None:
                groups[r[key]].append(r)
        table = []
        for kv in sorted(groups):
            g = groups[kv]
            fees = [r["fee_dust"] for r in g if r["fee_dust"] is not None]
            ppb = [r["speck_per_byte"] for r in g if r["speck_per_byte"] is not None]
            sizes = [r["size_bytes"] for r in g if r["size_bytes"] is not None]
            full = [r["block_usage_fullness"] for r in g if r["block_usage_fullness"] is not None]
            table.append({
                key: kv,
                "calls": len(g),
                "median_fee_dust": f"{statistics.median(fees):.15f}" if fees else "",
                "p90_fee_dust": f"{pct(fees, 0.9):.15f}" if fees else "",
                "median_speck_per_byte": round(statistics.median(ppb), 3) if ppb else "",
                "median_size_bytes": round(statistics.median(sizes)) if sizes else "",
                "median_block_fullness": round(statistics.median(full), 5) if full else "",
            })
        return table

    by_k = summarize(matched, "k")
    by_slots = summarize(matched, "slots")

    def write(path, table, key):
        if not table:
            print(f"  (no data for {key})")
            return
        cols = [key, "calls", "median_fee_dust", "p90_fee_dust",
                "median_speck_per_byte", "median_size_bytes", "median_block_fullness"]
        with open(path, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            w.writerows(table)
        print(f"\n{key} summary -> {path}")
        print(f"  {key:>6} {'calls':>6} {'med_fee_dust':>20} {'med_spk/byte':>14} {'med_full':>10}")
        for row in table:
            print(f"  {str(row[key]):>6} {row['calls']:>6} {str(row['median_fee_dust']):>20} "
                  f"{str(row['median_speck_per_byte']):>14} {str(row['median_block_fullness']):>10}")

    write(args.out, by_k, "k")
    write(args.out_slots, by_slots, "slots")

    # The control readout.
    fees_by_k = {r["k"]: fnum(r["median_fee_dust"]) for r in by_k if r["median_fee_dust"]}
    if len(fees_by_k) > 1:
        vals = list(fees_by_k.values())
        spread = (max(vals) - min(vals)) / max(min(vals), 1e-18)
        print(f"\ncontrol: fee spread across k = {spread:.1%} "
              f"(min {min(vals):.15f}, max {max(vals):.15f} DUST)")
        if spread < 0.02:
            print("  -> fee is ~flat across k, as the cost model predicts (proof_verify is")
            print("     parameterized by public inputs, not circuit size). k is a prover-cost")
            print("     axis, not a fee axis.")
        else:
            print("  -> fee VARIES with k by more than rounding. That contradicts the ledger-8")
            print("     cost model reading; check whether slots (public inputs) co-varied, or")
            print("     whether block fullness differed across the k groups' time windows.")
    fees_by_slots = {r["slots"]: fnum(r["median_fee_dust"]) for r in by_slots if r["median_fee_dust"]}
    if len(fees_by_slots) > 1:
        vals = list(fees_by_slots.values())
        spread = (max(vals) - min(vals)) / max(min(vals), 1e-18)
        print(f"control: fee spread across slots (public inputs) = {spread:.1%}")
        print("  -> this is the axis the cost model says SHOULD move the fee.")


if __name__ == "__main__":
    main()
