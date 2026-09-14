#!/bin/bash
# Defect (migration note, revised): ledger-v9 is published under TWO npm scopes.
# The 2.0 SDK betas depend on the unhyphenated `@midnightntwrk/ledger-v9`, whose
# `latest` dist-tag points at a June prerelease (0.1.0-rc.1) even though newer
# rc's exist, so `npm i @midnightntwrk/ledger-v9` without a version installs a
# stale package. The hyphenated `@midnight-ntwrk/ledger-v9` (the scope every other
# Midnight package uses) only started publishing in August.
j() { npm view "$1" dist-tags.latest versions --json 2>/dev/null; }
U=$(j @midnightntwrk/ledger-v9); H=$(j @midnight-ntwrk/ledger-v9)
python3 - "$U" "$H" <<'EOF'
import json, sys
def parse(s):
    try:
        d=json.loads(s); return d.get('dist-tags.latest'), d.get('versions', [])
    except Exception: return None, []
ul, uv = parse(sys.argv[1]); hl, hv = parse(sys.argv[2])
print(f"@midnightntwrk/ledger-v9   latest={ul}  versions={uv}")
print(f"@midnight-ntwrk/ledger-v9  latest={hl}  versions={hv}")
newest = sorted(uv, key=lambda v: [int(x) if x.isdigit() else x for x in v.replace('-rc.', '.').split('.')])[-1] if uv else None
stale = ul is not None and newest is not None and ul != newest
if stale and hv:
    print(f"RESULT 02-ledger-package-name: REPRODUCED — two scopes; SDK betas pin the unhyphenated one, whose latest tag is {ul} while {newest} exists; hyphenated scope has {hv[0]}..{hv[-1]}")
    sys.exit(0)
print(f"RESULT 02-ledger-package-name: NOT REPRODUCED — unhyphenated latest={ul} newest={newest}; hyphenated versions={hv}")
sys.exit(1)
EOF
