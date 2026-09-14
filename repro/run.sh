#!/bin/bash
# Run the defect reproductions. Groups A and B always; --wallet, --docker,
# --install add groups C, D and 01. Group E is never run from here.
cd "$(dirname "$0")/.." || exit 2
WALLET=0; DOCKER=0; INSTALL=0
for a in "$@"; do case "$a" in --wallet) WALLET=1;; --docker) DOCKER=1;; --install) INSTALL=1;; esac; done

declare -a NAMES RESULTS
run() { # run <label> <command...>
  local label="$1"; shift
  echo; echo "━━━ $label"
  local out; out=$("$@" 2>&1); local rc=$?
  echo "$out" | tail -25
  local line; line=$(echo "$out" | grep -E '^RESULT ' | tail -1)
  [ -z "$line" ] && line="RESULT $label: SKIPPED — no RESULT line (exit $rc)"
  NAMES+=("$label"); RESULTS+=("$line")
}

# A. offline
run A1 node stagenet/repro/keystore-kind.mjs
run A2 node stagenet/repro/password-policy.mjs
run A3 bash repro/02-ledger-package-name.sh
run A4 bash repro/03-compactc-033-missing.sh
# B. read-only network
run B1 node stagenet/repro/indexer-hides-fullness.mjs
run B2 node stagenet/repro/fee-genesis-vs-live.mjs
run B3 bash -c 'cd stagenet && npx tsx repro/ws-no-retry.ts'

if [ $WALLET = 1 ]; then
  if [ ! -f stagenet/.env.stagenet ]; then echo "no stagenet/.env.stagenet"; exit 2; fi
  set -a; . ./stagenet/.env.stagenet; set +a
  run C1 bash -c 'cd stagenet && NODE_OPTIONS=--max-old-space-size=8192 npx tsx repro/fee-flag-default.ts'
  run C2 bash -c 'cd stagenet && NODE_OPTIONS=--max-old-space-size=8192 npx tsx repro/initswap-night.ts'
  run C3 bash -c 'cd stagenet && NODE_OPTIONS=--max-old-space-size=8192 npx tsx repro/signrecipe-192.ts'
  run C4 bash -c 'cd stagenet && NODE_OPTIONS=--max-old-space-size=8192 npx tsx repro/submit-finalized.ts'
fi
if [ $DOCKER = 1 ]; then
  run D1 bash repro/05-proof-server-latest-tag.sh
  run D2 bash repro/06-proof-server-9-flags.sh
fi
if [ $INSTALL = 1 ]; then
  run 01 bash repro/01-wallet-sdk-beta2-install.sh
fi

echo; echo "━━━ summary"
for i in "${!NAMES[@]}"; do echo "  ${RESULTS[$i]}"; done
