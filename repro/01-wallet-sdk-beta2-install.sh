#!/bin/bash
# Defect: wallet-sdk@2.0.0-beta.2 does not install cleanly. Its barrel pins
# wallet-sdk-utilities@1.2.0 while wallet-sdk-facade@5.0.0-beta.2 imports
# `Clock`, which first exists in 1.2.1. A clean install fails at IMPORT time.
# Then: the same install with an override to utilities@1.2.1 imports fine.
set -u
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cd "$T" || exit 2
npm init -y >/dev/null 2>&1
echo "installing @midnight-ntwrk/wallet-sdk@2.0.0-beta.2 into $T (clean, no override)…"
if ! npm i --no-audit --no-fund --silent @midnight-ntwrk/wallet-sdk@2.0.0-beta.2 >/dev/null 2>&1; then
  echo "RESULT 01-wallet-sdk-beta2-install: SKIPPED — npm install itself failed (network?)"; exit 2
fi
UTIL=$(node -p "require('./node_modules/@midnight-ntwrk/wallet-sdk-utilities/package.json').version")
ERR=$(node --input-type=module -e "await import('@midnight-ntwrk/wallet-sdk'); console.log('IMPORT_OK')" 2>&1)
LINE=$(echo "$ERR" | grep -m1 -E "does not provide an export named|IMPORT_OK|Error" )
echo "resolved wallet-sdk-utilities: $UTIL"; echo "import result: ${LINE:-$(echo "$ERR" | tail -1)}"
if echo "$ERR" | grep -q "does not provide an export named 'Clock'"; then
  echo "applying override wallet-sdk-utilities@1.2.1 and reinstalling…"
  node -e "const p=require('./package.json');p.overrides={'@midnight-ntwrk/wallet-sdk-utilities':'1.2.1'};require('fs').writeFileSync('package.json',JSON.stringify(p,null,2))"
  npm i --no-audit --no-fund --silent >/dev/null 2>&1
  FIX=$(node --input-type=module -e "await import('@midnight-ntwrk/wallet-sdk'); console.log('IMPORT_OK')" 2>&1 | grep -m1 -E "IMPORT_OK|Error")
  echo "with override: $FIX"
  echo "RESULT 01-wallet-sdk-beta2-install: REPRODUCED — clean install resolves utilities@$UTIL and fails to import (missing export 'Clock'); override to 1.2.1 → $FIX"
  exit 0
fi
echo "RESULT 01-wallet-sdk-beta2-install: NOT REPRODUCED — utilities@$UTIL, import: ${LINE:-$(echo "$ERR" | tail -1)}"
exit 1
