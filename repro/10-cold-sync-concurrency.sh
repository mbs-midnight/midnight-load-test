#!/bin/bash
# Defect: dust cold-sync takes minutes per wallet and collapses under
# concurrency (two wallets in 446 s; six concurrent produced one usable wallet in
# 49 min). Times src/test_sync.ts for 1 wallet, then N in parallel, on preview.
# Needs fleet.json and .env.preprod. Read-only on chain, but slow, and it hits the
# hosted indexer hard enough to trip its rate limit. Refuses without --confirm.
# (uses perl alarm instead of coreutils timeout, which macOS lacks)
cd "$(dirname "$0")/.." || exit 2
[ "$1" = "--confirm" ] || { echo "RESULT 10-cold-sync-concurrency: SKIPPED — pass --confirm (slow; may rate-limit your IP)"; exit 2; }
[ -f fleet.json ] && [ -f .env.preprod ] || { echo "RESULT 10-cold-sync-concurrency: SKIPPED — fleet.json or .env.preprod missing"; exit 2; }
N=${N:-4}
set -a; . ./.env.preprod; set +a
export MN_STATE_DIR=$(mktemp -d)   # force a COLD sync: no snapshot to restore
t0=$(date +%s); NODE_OPTIONS=--max-old-space-size=8192 perl -e 'alarm shift; exec @ARGV' 2700 npx tsx src/test_sync.ts --wallets fleet.json --only w001 >/dev/null 2>&1; one=$(( $(date +%s) - t0 ))
echo "1 wallet cold sync: ${one}s"
rm -rf "$MN_STATE_DIR"; export MN_STATE_DIR=$(mktemp -d)
t0=$(date +%s); pids=()
for i in $(seq 1 $N); do w=$(printf 'w%03d' $i); NODE_OPTIONS=--max-old-space-size=8192 perl -e 'alarm shift; exec @ARGV' 2700 npx tsx src/test_sync.ts --wallets fleet.json --only $w >/dev/null 2>&1 & pids+=($!); done
okc=0; for p in "${pids[@]}"; do wait $p && okc=$((okc+1)); done; many=$(( $(date +%s) - t0 ))
echo "$N wallets concurrent: ${many}s, $okc/$N finished"
if [ $many -gt $((one*2)) ] || [ $okc -lt $N ]; then echo "RESULT 10-cold-sync-concurrency: REPRODUCED — 1 wallet ${one}s; $N concurrent ${many}s with $okc/$N finished"; exit 0; fi
echo "RESULT 10-cold-sync-concurrency: NOT REPRODUCED — 1 wallet ${one}s; $N concurrent ${many}s, all finished"; exit 1
