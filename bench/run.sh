#!/usr/bin/env bash
# bench/run.sh — builds the bench-rows app component and runs bench/bench.ts.
#
# Deliberately NOT in justfile (dispatch: "you may not edit justfile").
# Replicates justfile's `example` recipe's two commands
# (cargo build --target wasm32-unknown-unknown --release, then
# `wasm-tools component new`) for examples/bench-rows.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

mkdir -p bench/build

SEVER_BIN=tools/wbg-sever/target/release/wbg-sever
if [ ! -x "$SEVER_BIN" ]; then
  cargo build --release --manifest-path tools/wbg-sever/Cargo.toml
fi

echo "== building bench-rows =="
cargo build -p bench-rows-example --target wasm32-unknown-unknown --release
MODULE=target/wasm32-unknown-unknown/release/bench_rows_example.wasm
"$SEVER_BIN" "$MODULE" "$MODULE.severed.wasm"
wasm-tools component new \
  "$MODULE.severed.wasm" \
  -o bench/build/bench-rows-stream.component.wasm
wasm-tools validate --features component-model,cm-async bench/build/bench-rows-stream.component.wasm

echo "== running bench.ts =="
deno run --allow-read=. --allow-write=bench --allow-env --allow-run bench/bench.ts "$@"
