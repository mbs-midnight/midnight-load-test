#!/bin/bash
# Defect: single-client mempool ingest saturates near 2 tx/s; `1016: Immediately
# Dropped — the transaction couldn't enter the pool because of the limit`
# appears at 2 tx/s offered and achieved throughput rolls over above 3.
# Wraps ramp.sh (preview fleet, split HTTP/WS proxies on 6310/6311, two
# ledger-8 proof servers). Runs ~20 minutes and spends preview DUST.
cd "$(dirname "$0")/.." || exit 2
[ "$1" = "--confirm" ] || { echo "RESULT 09-mempool-ramp: SKIPPED — pass --confirm (20 min, preview fleet, proxies, 2 proof servers)"; exit 2; }
[ -f fleet.json ] && [ -f .env.preprod ] || { echo "RESULT 09-mempool-ramp: SKIPPED — fleet.json or .env.preprod missing"; exit 2; }
bash ramp.sh || exit 2
python3 - <<'EOF'
import json, glob, re
rows=[]
for f in sorted(glob.glob('ramp_*.jsonl'), key=lambda p: float(re.search(r'ramp_([0-9.]+)', p).group(1))):
    tps=float(re.search(r'ramp_([0-9.]+)', f).group(1)); ok=fail=e1016=0
    for l in open(f):
        try: r=json.loads(l)
        except: continue
        if r.get('event')=='churn_ok': ok+=1
        elif r.get('event')=='churn_fail':
            fail+=1; e1016+= '1016' in json.dumps(r)
    rows.append((tps, ok, fail, e1016))
for tps,ok,fail,e in rows: print(f"offered {tps:>4} tx/s  ok={ok:4}  fail={fail:4}  1016={e}")
first=[t for t,_,_,e in rows if e]
if first: print(f"RESULT 09-mempool-ramp: REPRODUCED — 1016 first appears at {first[0]} tx/s offered")
else: print("RESULT 09-mempool-ramp: NOT REPRODUCED — no 1016 at any offered rate")
EOF
