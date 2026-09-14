#!/bin/bash
# Defect (migration note): compactc 0.33.0-rc.2, the version the partner
# document specifies, was never published to the compact release channel.
command -v compact >/dev/null || { echo "RESULT 03-compactc-033-missing: SKIPPED — compact CLI not installed"; exit 2; }
OUT=$(compact update 0.33 2>&1 | tail -2)
LIST=$(compact list 2>&1 | grep -oE "0\.3[3-9]\.[0-9]+[^ ]*" | sort -u | tr '\n' ' ')
echo "compact update 0.33 → $OUT"
echo "0.3x toolchains listed: $LIST"
if echo "$OUT" | grep -qi "no version matching 0.33"; then
  echo "RESULT 03-compactc-033-missing: REPRODUCED — 'No version matching 0.33'; available: $LIST"; exit 0
fi
echo "RESULT 03-compactc-033-missing: NOT REPRODUCED — $OUT"; exit 1
