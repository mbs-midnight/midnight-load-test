#!/bin/bash
# Defect: midnightnetwork/proof-server:latest (note the org spelling) is a
# ledger-7 build, two generations behind midnightntwrk/proof-server:8.1.0.
command -v docker >/dev/null || { echo "RESULT 05-proof-server-latest-tag: SKIPPED — docker not available"; exit 2; }
probe() { # probe <image> <port>
  docker rm -f repro-ps >/dev/null 2>&1
  docker run -d --rm --name repro-ps -p "$2:6300" "$1" >/dev/null 2>&1 || { echo "run-failed"; return; }
  for i in $(seq 1 40); do v=$(curl -s -m 2 "http://localhost:$2/version" 2>/dev/null); [ -n "$v" ] && break; sleep 3; done
  docker rm -f repro-ps >/dev/null 2>&1
  echo "${v:-no-answer}"
}
echo "pulling both images (may take a while)…"
docker pull -q midnightnetwork/proof-server:latest >/dev/null 2>&1
docker pull -q midnightntwrk/proof-server:8.1.0 >/dev/null 2>&1
STALE=$(probe midnightnetwork/proof-server:latest 6390)
GOOD=$(probe midnightntwrk/proof-server:8.1.0 6391)
echo "midnightnetwork/proof-server:latest /version → $STALE"
echo "midnightntwrk/proof-server:8.1.0    /version → $GOOD"
if echo "$STALE" | grep -q "^7\." && echo "$GOOD" | grep -q "^8\."; then
  echo "RESULT 05-proof-server-latest-tag: REPRODUCED — latest=$STALE vs 8.1.0=$GOOD"; exit 0
fi
echo "RESULT 05-proof-server-latest-tag: NOT REPRODUCED — latest=$STALE, 8.1.0=$GOOD"; exit 1
