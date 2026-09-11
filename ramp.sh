#!/bin/bash
# Offer increasing tx/s and record where 1016 (pool limit) starts appearing.
# Snapshots make each step's warm-up seconds instead of minutes.
cd /Users/maheshsashital/Midnight/load-test
set -a && . ./.env.preprod && set +a
export MN_INDEXER_HTTP="http://127.0.0.1:6310/api/v4/graphql"
export MN_INDEXER_WS="wss://indexer.preview.midnight.network/api/v4/graphql/ws"
export MN_NODE_RPC="ws://127.0.0.1:6311"
export MN_PROOF_SERVERS="http://127.0.0.1:6300/,http://127.0.0.1:6302/"
W="w001,w002,w003,w004,w005,w006,w007,w021"
for TPS in 0.5 1 2 3 4 6; do
  rm -f ramp_${TPS}.jsonl
  NODE_OPTIONS=--max-old-space-size=10240 npx tsx src/flood.ts --phase churn \
    --wallets fleet.json --only "$W" --lanes 1 --outputs 1 --submit-wait Submitted \
    --target-tps $TPS --duration-s 180 --stagger-ms 2000 --log ramp_${TPS}.jsonl \
    > /dev/null 2>&1
  echo "STEP_DONE tps=$TPS"
done
echo "RAMP_DONE"
