#!/bin/bash
# Defect (resolved on ledger-9): wallet-sdk 1.x fails every shielded transfer on
# preview with `1010: Invalid Transaction: Custom error: 170`
# (MalformedError::InvalidDustSpendProof). Wraps src/shielded_check.ts, which
# needs the preview fleet manifest (fleet.json, gitignored) with wallets that
# hold a user-created shielded token, .env.preprod, and a ledger-8 proof server
# on localhost:6300. Spends preview DUST. Refuses without --confirm.
cd "$(dirname "$0")/.." || exit 2
[ "$1" = "--confirm" ] || { echo "RESULT 08-error-170-ledger8: SKIPPED — pass --confirm (needs preview fleet + ledger-8 proof server)"; exit 2; }
[ -f fleet.json ] && [ -f .env.preprod ] || { echo "RESULT 08-error-170-ledger8: SKIPPED — fleet.json or .env.preprod missing"; exit 2; }
set -a; . ./.env.preprod; set +a
OUT=$(NODE_OPTIONS=--max-old-space-size=8192 npx tsx src/shielded_check.ts --wallets fleet.json --only "${ONLY:-w001}" --watch-s 300 2>&1 | tee /dev/stderr)
if echo "$OUT" | grep -q "Custom error: 170"; then echo "RESULT 08-error-170-ledger8: REPRODUCED — shielded transfer rejected with Custom error: 170 on wallet-sdk 1.x"; exit 0; fi
echo "RESULT 08-error-170-ledger8: NOT REPRODUCED — no error 170 in output"; exit 1
