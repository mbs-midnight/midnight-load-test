#!/usr/bin/env python3
"""
gen_wallets.py -- generate wallets.json for the fleet load test.

Two secret formats:

  # 64-hex seeds (original behaviour):
  python3 gen_wallets.py --count 20 --out wallets.json

  # BIP39 24-word mnemonics (Lace-importable):
  python3 gen_wallets.py --count 24 --mnemonic --out fleet.json --start-index 1

Both emit [{label, seed}]. The harness's seedToBytes() accepts EITHER a hex
string or a space-separated BIP39 mnemonic in the "seed" field, so nothing
downstream changes -- derive_addresses, delegate, status, load_test all just work.

Why --mnemonic: a raw hex seed cannot be reversed into a mnemonic (BIP39's
mnemonic->seed step is one-way PBKDF2), so a hex-seeded wallet can never be
imported into Lace. If you want fleet wallets you can also open in Lace, generate
them mnemonic-first here. Mnemonics are produced by @scure/bip39 via
src/gen_mnemonics.mjs -- the SAME audited library the wallet uses -- so the
harness and Lace derive identical addresses. Do NOT mix: a given wallet is either
hex or mnemonic end to end, never both, or you will derive two different wallets.

--start-index lets you generate w001..wNNN without overwriting an existing w000
(e.g. keep w000 as the hex-seeded contract owner and add a mnemonic fleet).

SECURITY: the output contains spend secrets for testnet funds. Gitignored. Treat
it like .env.preprod. A mnemonic is just as sensitive as a raw seed.
"""
import argparse, json, secrets, subprocess, sys, os

ap = argparse.ArgumentParser()
ap.add_argument("--count", type=int, default=20, help="number of wallets to generate")
ap.add_argument("--out", default="wallets.json")
ap.add_argument("--prefix", default="w")
ap.add_argument("--start-index", type=int, default=0,
                help="first wallet index (use 1 to preserve an existing w000)")
ap.add_argument("--mnemonic", action="store_true",
                help="emit BIP39 24-word mnemonics instead of 64-hex seeds (Lace-importable)")
ap.add_argument("--words", type=int, default=24, choices=(12, 24),
                help="mnemonic length when --mnemonic (default 24)")
a = ap.parse_args()

labels = [f"{a.prefix}{i:03d}" for i in range(a.start_index, a.start_index + a.count)]

if a.mnemonic:
    # Generate via the audited @scure/bip39 lib (same one the wallet uses), NOT a
    # hand-rolled BIP39 -- a wrong wordlist or checksum would mint unfundable
    # wallets. gen_mnemonics.mjs lives beside the TS sources.
    here = os.path.dirname(os.path.abspath(__file__))
    helper = os.path.join(here, "src", "gen_mnemonics.mjs")
    if not os.path.exists(helper):
        sys.exit(f"missing {helper} -- cannot generate mnemonics safely without it.")
    try:
        out = subprocess.run(
            ["node", helper, str(a.count), str(a.words)],
            capture_output=True, text=True, check=True,
        )
    except FileNotFoundError:
        sys.exit("node not found on PATH -- needed to run the BIP39 generator.")
    except subprocess.CalledProcessError as e:
        sys.exit(f"mnemonic generation failed: {e.stderr.strip() or e}")
    secrets_list = [ln.strip() for ln in out.stdout.splitlines() if ln.strip()]
    if len(secrets_list) != a.count:
        sys.exit(f"expected {a.count} mnemonics, got {len(secrets_list)} -- aborting.")
    kind = f"{a.words}-word mnemonics"
else:
    secrets_list = [secrets.token_hex(32) for _ in range(a.count)]
    kind = "64-hex seeds"

wallets = [{"label": lbl, "seed": sec} for lbl, sec in zip(labels, secrets_list)]

# Refuse to silently clobber an existing file that has different wallets.
if os.path.exists(a.out):
    print(f"NOTE: {a.out} already exists and will be overwritten. Ctrl-C now to abort.",
          file=sys.stderr)

with open(a.out, "w") as f:
    json.dump(wallets, f, indent=2)

print(f"wrote {a.out}: {a.count} wallets ({kind}), labels {labels[0]}..{labels[-1]}.")
print()
if a.mnemonic:
    print("These are BIP39 mnemonics -- importable into Lace AND usable by the harness.")
    print("The harness derives the SAME address Lace shows, because seedToBytes() runs")
    print("the identical mnemonic->seed path. (A hex-seeded wallet like w000 cannot be")
    print("converted to a mnemonic after the fact; that is why the fleet is generated")
    print("mnemonic-first here.)")
    print()
print("NEXT STEP -- you cannot fund a secret directly. Derive the addresses:")
print(f"  npx tsx src/derive_addresses.ts --wallets {a.out} --out-dir .")
print()
print("That writes fund_list.txt (one unshielded address per line) and fleet.csv.")
print("Fund each UNSHIELDED address with tNIGHT, then delegate to start DUST")
print("generation. Nothing can transact until its DUST balance is non-zero.")
if a.start_index > 0:
    print()
    print(f"NOTE: indices start at {a.start_index}, so an existing "
          f"{a.prefix}{0:03d} is untouched. To load BOTH the owner and the fleet,")
    print("either keep them in separate files or merge the JSON arrays by hand.")