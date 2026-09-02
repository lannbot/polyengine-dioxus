#!/usr/bin/env bash
# bench/run.sh — builds the bench-rows app component and runs bench/bench.ts.
#
# Deliberately NOT in justfile (dispatch: "you may not edit justfile").
# Replicates justfile's `example` recipe's build command
# (cargo build --target wasm32-wasip2 --release, which emits a component
# directly) for examples/bench-rows.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

mkdir -p bench/build

echo "== building bench-rows =="
cargo build -p bench-rows-example --target wasm32-wasip2 --release
cp target/wasm32-wasip2/release/bench_rows_example.wasm \
  bench/build/bench-rows-stream.component.wasm
wasm-tools validate --features component-model,cm-async bench/build/bench-rows-stream.component.wasm

echo "== running bench.ts =="
deno run --allow-read=. --allow-write=bench --allow-env --allow-run bench/bench.ts "$@"
