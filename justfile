# polyengine-dioxus — build/test entry points.
#
# `just deps` first: pins a polyengine checkout (runtime with amendment A21
# readDirect + matching translator shim) under .deps/ — the local sibling
# checkout at ~/p/polymorph/polyengine has diverged from origin and predates
# A21, so we build against a pinned upstream rev instead.

POLYENGINE_REPO := "https://github.com/polymorph-components/polyengine.git"
POLYENGINE_REV := "9e17dc97dd3e"

default: check test

# Pinned polyengine checkout + translator shim build (wasm32).
deps:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -d .deps/polyengine ]; then
      mkdir -p .deps
      git clone --filter=blob:none {{POLYENGINE_REPO}} .deps/polyengine
    fi
    git -C .deps/polyengine fetch -q origin
    git -C .deps/polyengine checkout -q {{POLYENGINE_REV}}
    if [ ! -f .deps/polyengine/translator/translator_shim.wasm ]; then
      (cd .deps/polyengine && \
        CARGO_PROFILE_RELEASE_OPT_LEVEL=z \
        CARGO_PROFILE_RELEASE_LTO=fat \
        CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
        CARGO_PROFILE_RELEASE_PANIC=abort \
        CARGO_PROFILE_RELEASE_STRIP=symbols \
        cargo build -p translator-shim --target wasm32-unknown-unknown --release && \
        cp target/wasm32-unknown-unknown/release/translator_shim.wasm translator/translator_shim.wasm)
    fi

check:
    cargo check --workspace --target wasm32-unknown-unknown
    cargo clippy --workspace --target wasm32-unknown-unknown -- -D warnings
    deno task check

test:
    cargo test
    deno task test

# Build the surface-probe fixture component into fixtures/build/. The
# full-stack host tests load it.
fixtures:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p fixtures/build
    cargo build -p surface-probe --target wasm32-unknown-unknown --release
    wasm-tools component new \
      target/wasm32-unknown-unknown/release/surface_probe.wasm \
      -o fixtures/build/surface-probe.component.wasm
    wasm-tools validate --features component-model,cm-async fixtures/build/surface-probe.component.wasm

# Build an example app component into examples/build/.
example name:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p examples/build
    cargo build -p {{name}}-example --target wasm32-unknown-unknown --release
    wasm-tools component new \
      "target/wasm32-unknown-unknown/release/$(echo {{name}} | tr - _)_example.wasm" \
      -o examples/build/{{name}}.component.wasm
    wasm-tools validate --features component-model,cm-async examples/build/{{name}}.component.wasm

# Regenerate golden vectors (runs the Rust generator, then verifies the TS
# decoder agrees).
vectors:
    cargo test --test vectors -- --ignored generate
    deno task test

# Real-browser (Chromium via Playwright) E2E lane for the counter example.
# First run: `cd e2e && npm install && npx playwright install chromium --with-deps`.
e2e:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -f examples/build/counter.component.wasm ]; then
      just example counter
    fi
    deno run -A harness/build.ts
    cd e2e && npx playwright test
