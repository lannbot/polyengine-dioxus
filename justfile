# polyengine-dioxus — build/test entry points.
#
# `just deps` first: pins a polyengine checkout (runtime with amendment A21
# readDirect + matching translator shim) under .deps/ — the local sibling
# checkout at ~/p/polymorph/polyengine has diverged from origin and predates
# A21, so we build against a pinned upstream rev instead.

POLYENGINE_REPO := "https://github.com/polymorph-components/polyengine.git"
# Advanced 9e17dc97dd3e -> 22b5d3d for polyengine#261's optimization PRs
# (#263 layout-node cache, #264 embedder adapter tables, #265 flatten-count
# memoization, #270 variant kind/value): the typed mutation channel's cost is
# almost entirely that lift path, so the Channel A/B in bench/README.md is
# only meaningful against a runtime that has them.
POLYENGINE_REV := "22b5d3d"
TAILWIND_VERSION := "v4.3.3"

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
    cargo check --workspace --target wasm32-wasip2
    cargo clippy --workspace --target wasm32-wasip2 -- -D warnings
    deno task check

test:
    cargo test
    deno task test

# Build the surface-probe fixture component into fixtures/build/. The
# full-stack host tests load it. wasm32-wasip2 emits a component directly.
fixtures:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p fixtures/build
    cargo build -p surface-probe --target wasm32-wasip2 --release
    cp target/wasm32-wasip2/release/surface_probe.wasm \
      fixtures/build/surface-probe.component.wasm
    wasm-tools validate --features component-model,cm-async fixtures/build/surface-probe.component.wasm

# Build an example app component into examples/build/.
#
# The wasm32-wasip2 target emits a COMPONENT directly (rustc runs the
# module→component step itself against the wasi:cli p2 world), so there is no
# separate `wasm-tools component new` and no JS-boundary surgery: wasm-bindgen
# compiles to off-target stubs here and emits no imports at all. What the
# component does import beyond our own world is the WASI p2 surface that
# wasi-libc pulls in (cli/io/clocks/random); the host satisfies it with
# `@polyengine/wasi` (see host/src/host.ts).
example name:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p examples/build
    cargo build -p {{name}}-example --target wasm32-wasip2 --release
    component="target/wasm32-wasip2/release/$(echo {{name}} | tr - _)_example.wasm"
    cp "$component" examples/build/{{name}}.component.wasm
    wasm-tools validate --features component-model,cm-async examples/build/{{name}}.component.wasm
    # Build-time translation (embedder-api.md amendment A4): the translation
    # ENVELOPE is the blessed deploy artifact, so the deployed site ships
    # component.wasm + envelope + runtime and NO translator.
    deno run --allow-read --allow-write --config .deps/polyengine/deno.json \
      .deps/polyengine/tools/translate/main.ts \
      examples/build/{{name}}.component.wasm \
      -o examples/build/{{name}}.plan.json

# Regenerate golden vectors (runs the Rust generator, then verifies the TS
# decoder agrees).
vectors:
    cargo test --test vectors -- --ignored generate
    deno task test

# Real-browser (Chromium via Playwright) E2E lane for the counter example.
# First run: `cd e2e && npm install && npx playwright install chromium --with-deps`.
# GitHub-Pages-ready static site for the TodoMVC example, assembled flat
# at harness/dist-pages/ (works under any base path — see
# harness/pages.ts's header for the relative-URL discipline).
pages:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -f examples/build/counter.component.wasm ]; then
      just example counter
    fi
    if [ ! -f examples/build/todomvc.component.wasm ]; then
      just example todomvc
    fi
    if [ ! -f examples/build/components.component.wasm ]; then
      just example components
    fi
    deno run -A harness/pages.ts

e2e:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -f examples/build/counter.component.wasm ]; then
      just example counter
    fi
    if [ ! -f examples/build/todomvc.component.wasm ]; then
      just example todomvc
    fi
    deno run -A harness/build.ts
    cd e2e && npx playwright test

# Regenerate harness/components.css (committed artifact): Tailwind v4 over
# the dioxus_components crate sources (its per-component CSS + utility
# classes named in .rs files + safelist.json) plus this repo's example.
# Pinned standalone binary; no Node in the pipeline.
components-css:
    #!/usr/bin/env bash
    set -euo pipefail
    case "$(uname -sm)" in
      "Linux x86_64")  asset=tailwindcss-linux-x64 ;;
      "Linux aarch64") asset=tailwindcss-linux-arm64 ;;
      "Darwin arm64")  asset=tailwindcss-macos-arm64 ;;
      *) echo "components-css: unhandled platform $(uname -sm)" >&2; exit 1 ;;
    esac
    bin=".deps/$asset-{{TAILWIND_VERSION}}"
    if [ ! -x "$bin" ]; then
      mkdir -p .deps
      curl -sL -o "$bin" "https://github.com/tailwindlabs/tailwindcss/releases/download/{{TAILWIND_VERSION}}/$asset"
      chmod +x "$bin"
    fi
    crate=$(ls -d ~/.cargo/registry/src/*/dioxus_components-0.1.2 | head -1)
    tmp=$(mktemp -d)
    {
      echo '@import "tailwindcss";'
      # Theme tokens first: the crate styles itself with shadcn-convention
      # color tokens it expects the consumer to define (see
      # harness/components-theme.css).
      echo "@import \"$(pwd)/harness/components-theme.css\";"
      # NOT the crate's src/components.css aggregate: its published form
      # imports ./<name>/<name>.css but the files live under
      # ./components/<name>/<name>.css, and four of them (card, dialog,
      # empty, portal) are missing from the package entirely. Import the
      # per-component css that actually exists, skipping the JS-boundary
      # components this repo excludes (see examples/components/src/lib.rs).
      for f in "$crate"/src/components/*/*.css; do
        case "$f" in
          */dialog/*|*/portal/*|*/tooltip/*) ;;
          *) echo "@import \"$f\";" ;;
        esac
      done
      echo "@source \"$crate\";"
      echo "@source \"$(pwd)/examples/components/src\";"
    } > "$tmp/input.css"
    "$bin" -i "$tmp/input.css" -o harness/components.css --minify
    rm -rf "$tmp"

