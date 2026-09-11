#!/usr/bin/env python3
"""
live_fullness.py -- real-time block fullness readout, for steering a load test
while it runs.

midnight_dust_probe.py is the post-hoc source of truth; this is the control loop
you watch in a second terminal so you can tune --target-tps toward a fullness
target instead of discovering after 30 minutes that you undershot.

Fullness here is the BLOCK_USAGE dimension only:
    sum(len(raw)/2 for cost-counted txs) / block_usage_limit
which for a proven transaction is exactly the ledger's block_usage cost
(tx.serialized_size()). It is ONE of five cost dimensions -- read_time,
compute_time, bytes_written and bytes_churned are not visible from the indexer
-- so treat it as a floor on true fullness, never as "the" fullness. Same caveat
the probe documents.

Only SUCCESS / PARTIAL_SUCCESS transactions count toward cost, mirroring the
indexer's should_count_cost. Failed txs occupy no block budget.

  python3 live_fullness.py --endpoint https://indexer.preview.midnight.network/api/v4/graphql
  python3 live_fullness.py --target 0.5 --window 20 --csv live_fullness.csv
"""
from __future__ import annotations
import argparse, csv, http.client, json, os, sys, time, urllib.request, urllib.error
from collections import deque
from datetime import datetime, timezone

SPECKS_PER_DUST = 1_000_000_000_000_000
COST_COUNTING = {"SUCCESS", "PARTIAL_SUCCESS"}


# Optional rate-limit bypass header, read from the environment so the token
# never lands in source, argv, or a log line. Absent -> normal limits apply.
_BYPASS = os.environ.get("MN_RATELIMIT_BYPASS", "").strip()


def gql(endpoint, query, timeout=45):
    headers = {"content-type": "application/json"}
    if _BYPASS:
        headers["x-shielded-ratelimit-bypass"] = _BYPASS
    req = urllib.request.Request(
        endpoint, data=json.dumps({"query": query}).encode(),
        headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = json.loads(r.read().decode())
    if body.get("errors"):
        raise RuntimeError(json.dumps(body["errors"])[:400])
    return body["data"]


BLOCK_SEL = """
  height timestamp
  transactions {
    __typename
    ... on RegularTransaction {
      hash fee
      transactionResult { status }
      raw
    }
  }
"""


def fetch(endpoint, height=None):
    off = f"(offset: {{ height: {height} }})" if height is not None else ""
    return gql(endpoint, "query { block%s { %s } }" % (off, BLOCK_SEL)).get("block")


def parse_ts(ts):
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        return float(ts) / (1000.0 if ts > 1e11 else 1.0)
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def block_stats(b, limit):
    counted_bytes = total_bytes = 0
    counted_n = total_n = 0
    fee_speck = 0
    for tx in b.get("transactions") or []:
        raw = tx.get("raw")
        if not raw:
            continue
        h = raw[2:] if raw.startswith("0x") else raw
        size = len(h) // 2
        total_bytes += size
        total_n += 1
        status = ((tx.get("transactionResult") or {}).get("status") or "").upper()
        # No transactionResult at all -> assume it counted, and say so via the
        # 'assumed' flag rather than silently dropping bytes from the numerator.
        if not status or status in COST_COUNTING:
            counted_bytes += size
            counted_n += 1
            try:
                fee_speck += int(tx.get("fee") or 0)
            except (TypeError, ValueError):
                pass
    return {
        "height": b["height"], "ts": parse_ts(b.get("timestamp")),
        "txs": total_n, "counted_txs": counted_n,
        "bytes": counted_bytes, "total_bytes": total_bytes,
        "fullness": counted_bytes / limit if limit else 0.0,
        "fee_speck": fee_speck,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", default="https://indexer.preview.midnight.network/api/v4/graphql")
    # 1,000,000 -- the REAL preview value, decoded from on-chain ledgerParameters
    # with the ledger WASM (LedgerParameters.deserialize().toString()):
    #     block_limits: read_time 2s, compute_time 2s,
    #                   block_usage 1000000, bytes_written 50000,
    #                   bytes_churned 50000000
    # The ledger's INITIAL_LIMITS default is 200,000, which is what
    # midnight_dust_probe.py assumes -- and it is WRONG for preview by 5x.
    # block_limit_block_usage is governance-updatable, so never treat the
    # compiled-in default as the chain's value. Symptom that exposed this: blocks
    # reporting 194% "fullness" (a single 384KB shielded tx against a 200KB limit).
    # Pass --limit explicitly for other networks.
    ap.add_argument("--limit", type=int, default=1_000_000, help="block_usage limit in bytes")
    ap.add_argument("--target", type=float, default=0.5, help="fullness target, 0-1")
    ap.add_argument("--window", type=int, default=20, help="rolling window in blocks")
    ap.add_argument("--poll-s", type=float, default=2.0)
    ap.add_argument("--csv", help="append per-block rows here")
    ap.add_argument("--backfill", type=int, default=10, help="blocks of history to print at start")
    a = ap.parse_args()

    print(f"endpoint={a.endpoint}")
    print(f"rate-limit bypass header: {'ACTIVE' if _BYPASS else 'not set'}")
    print(f"block_usage limit={a.limit} bytes   target={a.target:.0%} "
          f"({int(a.limit*a.target)} bytes/block)\n")
    print(f"{'height':>9} {'gap_s':>6} {'txs':>5} {'bytes':>8} {'full%':>7} "
          f"{'roll%':>7} {'fee_DUST':>10}  bar")

    win = deque(maxlen=a.window)
    gaps = deque(maxlen=a.window)
    last_h = None
    last_ts = None
    writer = None
    if a.csv:
        fh = open(a.csv, "a", newline="")
        writer = csv.writer(fh)
        if fh.tell() == 0:
            writer.writerow(["height", "ts", "gap_s", "txs", "counted_txs",
                             "bytes", "fullness", "fee_speck"])

    tip = fetch(a.endpoint)
    if not tip:
        sys.exit("could not read chain tip")
    start = tip["height"] - a.backfill
    nxt = max(0, start)

    while True:
        try:
            b = fetch(a.endpoint, nxt)
        except (urllib.error.URLError, urllib.error.HTTPError, http.client.HTTPException,
                RuntimeError, TimeoutError, OSError) as e:
            print(f"  (indexer error, retrying: {str(e)[:90]})")
            time.sleep(a.poll_s)
            continue
        if not b:
            time.sleep(a.poll_s)
            continue

        s = block_stats(b, a.limit)
        gap = (s["ts"] - last_ts) if (s["ts"] and last_ts) else None
        if gap:
            gaps.append(gap)
        last_ts = s["ts"] or last_ts
        win.append(s["fullness"])
        roll = sum(win) / len(win)
        bar_n = int(min(1.0, s["fullness"]) * 40)
        tgt_n = int(min(1.0, a.target) * 40)
        bar = "".join("#" if i < bar_n else ("|" if i == tgt_n else "-") for i in range(40))
        print(f"{s['height']:>9} {('%.1f' % gap) if gap else '   -':>6} {s['txs']:>5} "
              f"{s['bytes']:>8} {s['fullness']*100:>6.2f}% {roll*100:>6.2f}% "
              f"{s['fee_speck']/SPECKS_PER_DUST:>10.6f}  {bar}")
        if writer:
            writer.writerow([s["height"], s["ts"], gap, s["txs"], s["counted_txs"],
                             s["bytes"], f"{s['fullness']:.6f}", s["fee_speck"]])
            fh.flush()

        # Every window, restate what the target costs in tx/s at the observed
        # average tx size -- that is the number you actually tune against.
        if len(win) == win.maxlen and s["height"] % a.window == 0:
            avg_gap = (sum(gaps) / len(gaps)) if gaps else None
            counted = [w for w in win if w > 0]
            if avg_gap and counted:
                avg_bytes_per_block = (sum(win) / len(win)) * a.limit
                print(f"    -- rolling {roll:.1%} of target {a.target:.0%}; "
                      f"avg block gap {avg_gap:.1f}s; "
                      f"need {(a.target*a.limit)/avg_gap:,.0f} bytes/s to hold target")

        last_h = s["height"]
        nxt = last_h + 1
        # Wait for the next height to exist rather than hammering the indexer.
        while True:
            try:
                t = fetch(a.endpoint)
            except (urllib.error.URLError, urllib.error.HTTPError, http.client.HTTPException,
                    RuntimeError, TimeoutError, OSError):
                time.sleep(a.poll_s)
                continue
            if t and t["height"] >= nxt:
                break
            time.sleep(a.poll_s)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nstopped.")
