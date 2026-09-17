#!/usr/bin/env bash
# compile_all.sh — compile every .compact file in SRC_DIR into its own
# subdirectory under OUT_DIR, named after the source file.
#
# Fixes exactly the overwrite trap from before: `compact compile X out` and
# `compact compile Y out` both write into the SAME out/{keys,zkir,contract},
# so Y silently clobbers X. This gives each variant out/<name>/ instead.
#
# Usage:
#   ./compile_all.sh <src_dir> <out_dir> [compact_bin]
#
#   ./compile_all.sh . out
#   ./compile_all.sh ./circuits ./circuits/out compact
#
# After it finishes, out/<name>/ is a valid --managed target:
#   python3 make_manifest.py --managed out --artifacts artifacts.csv --out ladder.json
#
# It also writes out/compile_log.csv (name, k, rows, seconds, ok/fail) so you
# have machine-readable k values even without running sweep_compile.py's own
# artifact classification.

set -uo pipefail

SRC_DIR="${1:?usage: compile_all.sh <src_dir> <out_dir> [compact_bin]}"
OUT_DIR="${2:?usage: compile_all.sh <src_dir> <out_dir> [compact_bin]}"
COMPACT_BIN="${3:-compact}"

if ! command -v "$COMPACT_BIN" >/dev/null 2>&1; then
  echo "error: '$COMPACT_BIN' not found on PATH. Pass the binary as the 3rd arg" >&2
  echo "  e.g. ./compile_all.sh . out /path/to/compact" >&2
  exit 1
fi

shopt -s nullglob
files=("$SRC_DIR"/*.compact)
if [ ${#files[@]} -eq 0 ]; then
  echo "error: no .compact files found in '$SRC_DIR'" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
LOG="$OUT_DIR/compile_log.csv"

# Preserve k/rows from a prior run: if a dest already exists, we skip recompiling
# it below, but its earlier log entry still has the k value that ladder.json
# needs. Load any existing log BEFORE truncating it, and carry those rows
# forward for anything we skip this run.
declare -A PREV_ROW
if [ -f "$LOG" ]; then
  while IFS=, read -r pname prest; do
    [ "$pname" = "name" ] && continue  # header
    PREV_ROW["$pname"]="$pname,$prest"
  done < "$LOG"
fi

echo "name,source,k,rows,seconds,status,error" > "$LOG"

ok=0
fail=0
total=${#files[@]}
echo "compiling $total contract(s) from '$SRC_DIR' into '$OUT_DIR/<name>/'"
echo

i=0
for src in "${files[@]}"; do
  i=$((i+1))
  name="$(basename "$src" .compact)"
  dest="$OUT_DIR/$name"

  if [ -d "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then
    if [ -n "${PREV_ROW[$name]:-}" ] && [[ "${PREV_ROW[$name]}" == *,ok,* ]]; then
      echo "[$i/$total] $name  ->  SKIPPED, k carried forward from prior run ($dest)"
      echo "${PREV_ROW[$name]}" >> "$LOG"
    else
      echo "[$i/$total] $name  ->  SKIPPED (dest exists, no prior 'ok' log entry -- k unknown: $dest)"
      echo "  delete it first if you want to recompile: rm -rf '$dest'"
      echo "$name,$src,,,,skipped,dest already existed" >> "$LOG"
    fi
    continue
  fi

  mkdir -p "$dest"
  start=$(date +%s)
  out="$(mktemp)"
  if "$COMPACT_BIN" compile "$src" "$dest" >"$out" 2>&1; then
    secs=$(( $(date +%s) - start ))
    # Compiler prints e.g.: circuit "run" (k=18, rows=248986)
    line="$(grep -Eo 'k=[0-9]+, rows=[0-9]+' "$out" | head -1)"
    k="$(echo "$line" | grep -Eo 'k=[0-9]+' | cut -d= -f2)"
    rows="$(echo "$line" | grep -Eo 'rows=[0-9]+' | cut -d= -f2)"
    echo "[$i/$total] $name  ->  ok  k=${k:-?} rows=${rows:-?}  (${secs}s)"
    echo "$name,$src,${k:-},${rows:-},$secs,ok," >> "$LOG"
    ok=$((ok+1))
  else
    secs=$(( $(date +%s) - start ))
    errline="$(tail -1 "$out" | tr ',' ';')"
    echo "[$i/$total] $name  ->  FAILED (${secs}s): $errline"
    echo "$name,$src,,,$secs,failed,\"$errline\"" >> "$LOG"
    fail=$((fail+1))
    # An empty dest dir from a failed compile would look like a valid managed
    # dir to make_manifest.py's is_managed_dir() check once keys/ exists
    # partially; safer to remove it entirely on failure.
    rm -rf "$dest"
  fi
  rm -f "$out"
done

echo
echo "$ok ok, $fail failed, out of $total"
echo "log -> $LOG"
if [ "$ok" -gt 0 ]; then
  echo
  echo "next:"
  echo "  python3 make_manifest.py --managed $OUT_DIR --artifacts <artifacts.csv or omit> --out ladder.json"
  echo "  (if you don't have artifacts.csv, k comes out of $LOG -- you can build"
  echo "   a compatible artifacts.csv from it, or pass --k per contract by hand)"
fi
[ "$fail" -eq 0 ]
