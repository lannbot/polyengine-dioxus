#!/usr/bin/env bash
# bench/run.sh — builds the bench-rows app component (both transports) and
# runs bench/bench.ts.
#
# Deliberately NOT in justfile (dispatch: "you may not edit justfile").
# Replicates justfile's `example` recipe's two commands
# (cargo build --target wasm32-unknown-unknown --release, then
# `wasm-tools component new`) for examples/bench-rows, once per transport
# feature — mirrors the `fixtures` recipe's stream/call pairing.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

mkdir -p bench/build

echo "== building bench-rows (stream transport) =="
cargo build -p bench-rows-example --target wasm32-unknown-unknown --release
wasm-tools component new \
  target/wasm32-unknown-unknown/release/bench_rows_example.wasm \
  -o bench/build/bench-rows-stream.component.wasm
wasm-tools validate --features component-model,cm-async bench/build/bench-rows-stream.component.wasm

echo "== building bench-rows (call transport) =="
cargo build -p bench-rows-example --target wasm32-unknown-unknown --release --features call-transport
wasm-tools component new \
  target/wasm32-unknown-unknown/release/bench_rows_example.wasm \
  -o bench/build/bench-rows-call.component.wasm
wasm-tools validate --features component-model,cm-async bench/build/bench-rows-call.component.wasm

echo "== running bench.ts =="
deno run --allow-read=. --allow-write=bench --allow-env --allow-run bench/bench.ts "$@"
