#!/bin/bash
# Wait for priming, then start the 2-hour run with the primed wallets only.
cd /Users/maheshsashital/Midnight/load-test

# 1) wait for priming to finish (or give up after 3h)
for i in $(seq 1 360); do
  grep -q 'PAIRS_DONE' /private/tmp/claude-501/-Users-maheshsashital-Midnight/8433f632-6e7d-4ae9-a9c1-cfa48e5103cb/scratchpad/pairs.log 2>/dev/null && break
  sleep 30
done

# 2) only run wallets that HAVE a snapshot. An un-primed wallet would cold sync
#    and, because the load window opens only when every wallet settles, one
#    straggler would hold the entire run hostage for up to 45 minutes.
PRIMED=$(ls .wallet-state/ 2>/dev/null | sed 's/\.preview\.json//' | sort | paste -sd, -)
N=$(ls .wallet-state/ 2>/dev/null | wc -l | tr -d ' ')
echo "PRIMED_COUNT $N"
echo "PRIMED_LIST $PRIMED"
if [ "$N" -lt 8 ]; then echo "ABORT: only $N snapshots, not worth a 2h run"; exit 1; fi

set -a && . ./.env.preprod && set +a
export MN_INDEXER_HTTP="http://127.0.0.1:6310/api/v4/graphql"
export MN_INDEXER_WS="wss://indexer.preview.midnight.network/api/v4/graphql/ws"
export MN_NODE_RPC="ws://127.0.0.1:6311"
export MN_PROOF_SERVERS="http://127.0.0.1:6300/,http://127.0.0.1:6302/"

rm -f HALT final_churn.jsonl final_fullness.csv
python3 -u live_fullness.py --target 0.25 --window 30 --backfill 3 --csv final_fullness.csv \
  > /private/tmp/claude-501/-Users-maheshsashital-Midnight/8433f632-6e7d-4ae9-a9c1-cfa48e5103cb/scratchpad/final_mon.log 2>&1 &

echo "RUN_START $(date -u +%Y-%m-%dT%H:%M:%SZ)"
NODE_OPTIONS=--max-old-space-size=14336 npx tsx src/flood.ts --phase churn \
  --wallets fleet.json --only "$PRIMED" --lanes 1 --outputs 1 --submit-wait Submitted \
  --duration-s 7200 --stagger-ms 4000 --halt-file ./HALT --log final_churn.jsonl \
  > /private/tmp/claude-501/-Users-maheshsashital-Midnight/8433f632-6e7d-4ae9-a9c1-cfa48e5103cb/scratchpad/final_run.log 2>&1
echo "RUN_END $(date -u +%Y-%m-%dT%H:%M:%SZ) exit=$?"
pkill -f live_fullness 2>/dev/null
