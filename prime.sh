#!/bin/bash
# Prime wallet snapshots in batches: one cold sync each, then reusable forever.
cd /Users/maheshsashital/Midnight/load-test
set -a && . ./.env.preprod && set +a
export MN_INDEXER_HTTP="http://127.0.0.1:6310/api/v4/graphql"
export MN_INDEXER_WS="wss://indexer.preview.midnight.network/api/v4/graphql/ws"
export MN_NODE_RPC="ws://127.0.0.1:6311"
export MN_PROOF_SERVERS="http://127.0.0.1:6300/,http://127.0.0.1:6302/"
for batch in "$@"; do
  echo "=== priming $batch @ $(date -u +%H:%M:%SZ) ==="
  NODE_OPTIONS=--max-old-space-size=12288 npx tsx src/flood.ts --phase churn \
    --wallets fleet.json --only "$batch" --lanes 1 --outputs 1 --submit-wait Submitted \
    --duration-s 30 --stagger-ms 6000 --log prime.jsonl 2>&1 \
    | grep -E "ready  native|snapshot|churn done" | tail -12
  echo "  snapshots now: $(ls .wallet-state/ 2>/dev/null | wc -l | tr -d ' ')"
done
echo "PRIME_DONE $(ls .wallet-state/ | wc -l | tr -d ' ') snapshots"
