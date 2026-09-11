#!/bin/bash
# Cold sync is self-throttling above ~2 concurrent wallets: batches of 6 produced
# ~1 snapshot each in 49 minutes, while 2 wallets synced in 446s. So prime in
# PAIRS, with a 15-min ceiling so a bad pair costs minutes not 45.
cd /Users/maheshsashital/Midnight/load-test
set -a && . ./.env.preprod && set +a
export MN_INDEXER_HTTP="http://127.0.0.1:6310/api/v4/graphql"
export MN_INDEXER_WS="wss://indexer.preview.midnight.network/api/v4/graphql/ws"
export MN_NODE_RPC="ws://127.0.0.1:6311"
export MN_PROOF_SERVERS="http://127.0.0.1:6300/,http://127.0.0.1:6302/"
export MN_SYNC_TIMEOUT_MS=900000
while read -r pair; do
  [ -z "$pair" ] && continue
  S=$(date +%s)
  NODE_OPTIONS=--max-old-space-size=8192 npx tsx src/flood.ts --phase churn \
    --wallets fleet.json --only "$pair" --lanes 1 --outputs 1 --submit-wait Submitted \
    --duration-s 20 --stagger-ms 4000 --log prime.jsonl > /dev/null 2>&1
  echo "  $pair -> $(( $(date +%s) - S ))s   snapshots=$(ls .wallet-state/ 2>/dev/null | wc -l | tr -d ' ')"
done < /private/tmp/claude-501/-Users-maheshsashital-Midnight/8433f632-6e7d-4ae9-a9c1-cfa48e5103cb/scratchpad/pairs.txt
echo "PAIRS_DONE snapshots=$(ls .wallet-state/ | wc -l | tr -d ' ')"
