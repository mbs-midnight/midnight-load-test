# contract-gen: the benchmark-circuit ladder

Generates the `BenchR<rounds>_S<slots>` Compact contracts that the root
harness's benchmark path (`make_manifest.py` → `ladder.json` → `src/deploy.ts`
→ `src/load_test.ts`) deploys and calls. Moved here from a standalone
`contract-gen/` directory on 2026-09-17; it has exactly one consumer, this
repository.

## What it does

Two knobs, chosen to be orthogonal:

- `--rounds N` — unrolled hash rounds. Pure in-circuit work; drives circuit size k.
- `--slots M` — distinct ledger cells written. Each is an Impact VM write and a
  public input; drives `bytes_written`, not k.

You cannot ask the compiler for a k. It derives k from the circuit, and k only
steps up when the row count crosses a power of two, so `gen_circuits.py` emits a
padding **ladder** and `sweep_compile.py` / `circuits/record_k.py` find which k
each rung lands on.

```
gen_circuits.py      emit the ladder (one template; --probe emits a one-round Probe.compact first)
sweep_compile.py     compile every variant, tabulate vk/pk/zkir sizes and k → artifacts.csv
fake_compact.py      stub compiler for testing the sweep without the toolchain
circuits/
  Probe.compact, small/, large/, BenchR4096_S0.compact, BenchR8192_S0.compact
                     the 21 generated sources actually used
  compile_all.sh     compile each source into its own out/<name>/ (the plain
                     `compact compile X out` form silently overwrites between variants)
  record_k.py        append (name, k, rows) to circuits/artifacts.csv by hand
  artifacts.csv      the hand-recorded k table for the cheap rungs
  out/, tmp/         compiled output, gitignored (5 GB; identical to ../contracts/)
```

## Two caveats

1. **k extraction never worked automatically.** `sweep_compile.py` records
   `k: NOT FOUND` for every row because it never located where the 0.31 compiler
   reports k; the k values we have came from `record_k.py`, typed in from the
   compiler's terminal output.
2. **The experiment this served was made moot by the fee floor.** Fees were
   1 SPECK at every k on ledger 8 (see `../MNF_REPORT.html`), so the
   fee-versus-k table `join_sweep.py` was built to produce carries no information
   on those networks. The circuits remain useful as write-heavy load shapes.

## Regenerating

```bash
cd load-test/contract-gen
python3 gen_circuits.py --probe --out ./circuits
compact compile +0.31.1 ./circuits/Probe.compact ./circuits/out/Probe   # check the template still compiles
python3 gen_circuits.py --out ./circuits                                  # the ladder
SRC_DIR=./circuits OUT_DIR=./circuits/out bash circuits/compile_all.sh    # hours for the large rungs
```

Then point `../make_manifest.py --managed circuits/out/BenchR…` at the outputs,
or copy them to `../contracts/` where `ladder.json` expects them.
