#!/usr/bin/env python3
"""Fake `compact` CLI: emits a plausible artifact tree so the driver can be tested
without the real compiler. Rows scale with hash-round count; k = ceil(log2(rows))."""
import sys, os, re, json, math
if len(sys.argv) < 4 or sys.argv[1] != "compile": sys.exit(2)
src, outdir = sys.argv[-2], sys.argv[-1]
text = open(src).read()
rounds = len(re.findall(r"persistentHash", text))
slots  = len(re.findall(r"export ledger slot", text))
rows = max(1, rounds * 220 + slots * 40 + 300)
k = max(4, math.ceil(math.log2(rows)))
os.makedirs(os.path.join(outdir, "keys"), exist_ok=True)
os.makedirs(os.path.join(outdir, "zkir"), exist_ok=True)
# VK: constant-size commitments, so flat in k -- the hypothesis under test
open(os.path.join(outdir,"keys","run.verifier"),"wb").write(b"\0"*2875)
open(os.path.join(outdir,"keys","run.prover"),"wb").write(b"\0"*(rows*32))
open(os.path.join(outdir,"zkir","run.bzkir"),"wb").write(b"\0"*(rounds*64+512))
json.dump({"circuits":[{"name":"run","k":k,"rows":rows,"public_inputs":slots*3+7}]},
          open(os.path.join(outdir,"compiler.json"),"w"))
print(f"compiled run: rows={rows} k={k}")
