#!/bin/bash
# RETRACTION CHECK. The report's migration note said proof server 9.x dropped
# `--network` and that ledger-8 launch commands therefore fail. Running the
# binary in each image shows the flag set is IDENTICAL across 7.0.0-rc.1, 8.1.0
# and 9.0.0-rc.5, and none of them ever had `--network`. The flag came from
# somewhere in our own tooling, not from an 8.x proof server. This script exits
# 1 ("not reproduced") by design and prints the evidence.
command -v docker >/dev/null || { echo "RESULT 06-proof-server-9-flags: SKIPPED — docker not available"; exit 2; }
flags() { docker run --rm "$1" "midnight-proof-server --help" 2>&1 | grep -oE "^\s+(-[a-z], )?--[a-z-]+" | grep -oE "\-\-[a-z-]+" | sort -u | tr '\n' ' '; }
declare -A F
for img in midnightnetwork/proof-server:latest midnightntwrk/proof-server:8.1.0 midnightntwrk/proof-server:9.0.0-rc.5_experimental; do
  docker pull -q "$img" >/dev/null 2>&1; F[$img]=$(flags "$img"); echo "$img → ${F[$img]}"
done
NET9=$(docker run --rm midnightntwrk/proof-server:9.0.0-rc.5_experimental "midnight-proof-server --network preview" 2>&1 | head -1)
NET8=$(docker run --rm midnightntwrk/proof-server:8.1.0 "midnight-proof-server --network preview" 2>&1 | head -1)
echo "9.x  --network → $NET9"; echo "8.1.0 --network → $NET8"
if [ "${F[midnightntwrk/proof-server:8.1.0]}" = "${F[midnightntwrk/proof-server:9.0.0-rc.5_experimental]}" ]; then
  echo "RESULT 06-proof-server-9-flags: NOT REPRODUCED — 8.1.0 and 9.x accept the same flags (${F[midnightntwrk/proof-server:9.0.0-rc.5_experimental]}); neither has --network. The migration-note claim is retracted."; exit 1
fi
echo "RESULT 06-proof-server-9-flags: REPRODUCED — flag sets differ: 8.1.0 [${F[midnightntwrk/proof-server:8.1.0]}] vs 9.x [${F[midnightntwrk/proof-server:9.0.0-rc.5_experimental]}]"; exit 0
