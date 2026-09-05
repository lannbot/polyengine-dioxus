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
    # The workspace pass above sees every crate at DEFAULT features, so it
    # never compiles the prerenderer's `serve` module or the `launch_ssr!`
    # expansion. Checking the example covers both.
    cargo clippy -p counter-example --no-default-features --features ssr \
      --target wasm32-wasip2 -- -D warnings
    # Explicit: whether the workspace pass above unifies the `eval` feature
    # onto the renderer depends on which crates are in the graph.
    cargo clippy -p polyengine-dioxus --features eval --target wasm32-wasip2 -- -D warnings
    deno task check

test:
    cargo test
    # The workspace root is a package, so plain `cargo test` above is
    # `-p polyengine-dioxus` and nothing else.
    cargo test -p polyengine-dioxus-ssr
    deno task test

# Build the fixture components into fixtures/build/. The full-stack host
# tests load them. wasm32-wasip2 emits a component directly.
fixtures:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p fixtures/build
    cargo build -p surface-probe --target wasm32-wasip2 --release
    cp target/wasm32-wasip2/release/surface_probe.wasm \
      fixtures/build/surface-probe.component.wasm
    wasm-tools validate --features component-model,cm-async fixtures/build/surface-probe.component.wasm
    cargo build -p eval-probe --target wasm32-wasip2 --release
    cp target/wasm32-wasip2/release/eval_probe.wasm \
      fixtures/build/eval-probe.component.wasm
    wasm-tools validate --features component-model,cm-async fixtures/build/eval-probe.component.wasm
    # Built with the renderer's `eval` feature, so the import must be there:
    # the host tests mount it with `MountOptions.eval` (wit/world.wit, the
    # `eval` interface doc).
    if ! wasm-tools component wit fixtures/build/eval-probe.component.wasm | grep -q 'polymorph:dioxus/eval@'; then echo "eval-probe does not import polymorph:dioxus/eval" >&2; exit 1; fi

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
    # Built without the renderer's `eval` feature, so the import must be
    # absent (wit/world.wit, the `eval` interface doc: opt-in on both sides).
    if wasm-tools component wit examples/build/{{name}}.component.wasm | grep -q 'polymorph:dioxus/eval@'; then echo "{{name}} imports polymorph:dioxus/eval without the eval feature" >&2; exit 1; fi
    # Build-time translation (embedder-api.md amendment A4): the translation
    # ENVELOPE is the blessed deploy artifact, so the deployed site ships
    # component.wasm + envelope + runtime and NO translator.
    deno run --allow-read --allow-write --config .deps/polyengine/deno.json \
      .deps/polyengine/tools/translate/main.ts \
      examples/build/{{name}}.component.wasm \
      -o examples/build/{{name}}.plan.json

# Prerender the example to HTML, as a `wasi:cli/command` component.
#
# Checked twice against one golden file: natively, then as a component under
# `wasmtime run`. Same source, same bytes — so a divergence between the two
# is itself the signal, and neither check needs HTTP, ports or p3.
ssg-example name:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p examples/build
    cargo run -q -p {{name}}-example --no-default-features --features ssg \
      --bin {{name}}-ssg | diff - examples/{{name}}/golden.html
    cargo build -p {{name}}-example --no-default-features --features ssg \
      --bin {{name}}-ssg --target wasm32-wasip2 --release
    cp target/wasm32-wasip2/release/{{name}}-ssg.wasm \
      examples/build/{{name}}.ssg.component.wasm
    wasm-tools validate --features component-model examples/build/{{name}}.ssg.component.wasm
    wasmtime run examples/build/{{name}}.ssg.component.wasm | diff - examples/{{name}}/golden.html

# Build the example as a `wasi:http/service` component (prerender per request).
ssr-example name:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p examples/build
    cargo build -p {{name}}-example --no-default-features --features ssr --lib \
      --target wasm32-wasip2 --release
    cp "target/wasm32-wasip2/release/$(echo {{name}} | tr - _)_example.wasm" \
      examples/build/{{name}}.ssr.component.wasm
    wasm-tools validate --features component-model,cm-async \
      examples/build/{{name}}.ssr.component.wasm

# Serve the prerendered example.
#
# `-S cli` is not optional: without it wasmtime links only the proxy world,
# and a rustc wasm32-wasip2 component imports wasi:cli/environment,
# wasi:filesystem/preopens and exit through wasi-libc. That one flag adds
# both the p2 and the wasi:cli@0.3.x tracks.
serve name:
    #!/usr/bin/env bash
    set -euo pipefail
    # Unconditional rather than guarded on the file existing: nothing is
    # worse than demoing a stale build, and cargo makes the up-to-date case
    # free.
    just ssr-example {{name}}
    wasmtime serve -S cli examples/build/{{name}}.ssr.component.wasm

# Smoke-test the served component: it answers, with the golden HTML.
#
# HTML correctness is already settled by `just test` and `just ssg-example`;
# what this covers is only the ~20-line HTTP wrapper. Binds port 0 and reads
# the real port back from wasmtime's own output, so parallel checkouts cannot
# collide, and kills by PID rather than by port.
serve-test name:
    #!/usr/bin/env bash
    set -euo pipefail
    # Unconditional rather than guarded on the file existing: a stale
    # artifact from before a source change fails as a confusing golden diff
    # rather than as "you forgot to rebuild", and cargo makes the up-to-date
    # case free.
    just ssr-example {{name}}
    log=$(mktemp)
    wasmtime serve -S cli --addr 127.0.0.1:0 \
      examples/build/{{name}}.ssr.component.wasm > "$log" 2>&1 &
    pid=$!
    trap 'kill $pid 2>/dev/null || true; rm -f "$log"' EXIT
    port=""
    for _ in $(seq 100); do
      # No match yet is the normal case while wasmtime is still starting, and
      # `set -euo pipefail` would otherwise abort the recipe on it.
      port=$(grep -o 'http://127\.0\.0\.1:[0-9]*' "$log" | head -1 | cut -d: -f3 || true)
      if [ -n "$port" ]; then break; fi
      sleep 0.1
    done
    if [ -z "$port" ]; then
      echo "serve never reported a port:" >&2
      cat "$log" >&2
      exit 1
    fi
    curl -sS --fail "http://127.0.0.1:$port/" | diff - examples/{{name}}/golden.html

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
    # Unconditional, unlike the component builds above: tests/hydrate.spec.ts
    # serves examples/counter/golden.html as the page the client adopts, so a
    # golden that has drifted from the component would fail as a hydration
    # mismatch. This recipe re-derives and diffs it rather than trusting it.
    just ssg-example counter
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

