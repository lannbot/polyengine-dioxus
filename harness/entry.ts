/// <reference lib="dom" />
// Browser dev-host page entry (real-Chromium E2E lane, owned by e2e/ +
// harness/). Bundled by `deno bundle --platform browser` (same mechanism
// .deps/polyengine/tools/release-bundle/build.ts uses for the embedder
// release asset) into harness/dist/entry.js and loaded by
// harness/index.html.
//
// Which example to mount is chosen via the page's `?app=` query param
// (e.g. `?app=todomvc`); defaults to `counter`. The component is fetched
// from `./${app}.component.wasm` (page-relative — see e2e/server.ts's
// mapping for dev, harness/pages.ts's flat assembly for the
// GitHub-Pages build). For
// `todomvc` specifically, a `<link>` to harness/todomvc.css is injected —
// examples/todomvc drops its `asset!`-based Stylesheet (needs the `dx`
// CLI's asset pipeline; see examples/todomvc/src/lib.rs's header), so the
// harness supplies the same stylesheet directly instead.
//
// Governing docs: host/tests/counter_test.ts (what the app does / how
// mounting works in Deno — same mountApp API, real DOM here instead of
// linkedom), host/src/host.ts (mountApp contract).
//
// Translator-in-browser handling: @deltic/translator's defaultTranslator()
// (.deps/polyengine/translator/mod.ts) already has a browser arm — when
// neither Deno nor Node globals are present it `fetch()`es
// `new URL("./translator_shim.wasm", import.meta.url)`. `deno bundle`
// preserves that `new URL(..., import.meta.url)` pattern as a plain
// string relative to the bundle's own module URL (verified empirically —
// see harness/README-ish note in the E2E track report), so we just need
// the wasm asset served alongside dist/entry.js at the same relative
// path the source module used
// (.deps/polyengine/translator/translator_shim.wasm ->
// harness/dist/translator_shim.wasm). No special-casing needed here.

import { defaultTranslator } from "@deltic/translator";
import { mountApp } from "../host/src/host.ts";

// Pages assembly mode (harness/pages.ts) injects `window.__DEFAULT_APP`
// via an inline script before this module loads, so a static
// GitHub-Pages deployment can pick a non-"counter" default (todomvc)
// without relying on a `?app=` query param the index.html doesn't set.
declare global {
  interface Window {
    __DEFAULT_APP?: string;
  }
}

interface HarnessError {
  source: "onError" | "window.onerror" | "unhandledrejection";
  detail: string;
}

const errors: HarnessError[] = [];
(globalThis as unknown as { __e2eErrors: HarnessError[] }).__e2eErrors = errors;

globalThis.addEventListener("error", (ev) => {
  errors.push({ source: "window.onerror", detail: String(ev.error ?? ev.message) });
});
globalThis.addEventListener("unhandledrejection", (ev) => {
  errors.push({ source: "unhandledrejection", detail: String(ev.reason) });
});

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) throw new Error("harness/index.html must have <div id=app>");

  const app = new URLSearchParams(location.search).get("app") ??
    (globalThis as unknown as Window).__DEFAULT_APP ?? "counter";
  if (app === "todomvc") {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "./todomvc.css";
    document.head.appendChild(link);
  }

  // Build-identity probe (dispatch's mandatory rule: verify the served
  // build before trusting any probe). harness/build.ts writes this stamp
  // alongside dist/entry.js; the test asserts its gitRev against
  // `git rev-parse HEAD`.
  try {
    const stampRes = await fetch(new URL("./build-stamp.json", import.meta.url));
    if (stampRes.ok) {
      (globalThis as unknown as { __buildStamp: unknown }).__buildStamp = await stampRes.json();
    }
  } catch {
    // best-effort; absence just means the identity probe test fails loudly
  }

  const res = await fetch(`./${app}.component.wasm`);
  if (!res.ok) {
    throw new Error(`fetching component failed: ${res.status} ${res.statusText}`);
  }
  const componentBytes = new Uint8Array(await res.arrayBuffer());

  const translator = await defaultTranslator();

  const mounted = await mountApp({
    componentBytes,
    translator,
    root,
    onError: (err) => {
      errors.push({ source: "onError", detail: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    },
  });

  // Test hooks (README-in-comment: the E2E dispatch's contract for what
  // window surface the tests may depend on).
  //   - window.__mounted: resolves once mountApp has returned and the
  //     initial render has happened (waited on below via a DOM poll, since
  //     mountApp resolving is necessary but the initial mutation batch may
  //     still be async-in-flight — see host/tests/counter_test.ts's own
  //     waitFor(() => root.querySelector("#count") !== null, ...)).
  //   - window.__mountedHandle: the raw `Mounted` object (frameDecoder,
  //     dispatcher, dispose) for smoke assertions (STREAM transport
  //     engagement via frameDecoder.pending()).
  //   - window.__e2eErrors: collected page/onError errors (asserted empty).
  (globalThis as unknown as { __mountedHandle: typeof mounted }).__mountedHandle = mounted;

  const mountedSelector = app === "todomvc" ? ".todoapp" : "#count";
  await waitFor(() => root.querySelector(mountedSelector) !== null);

  (globalThis as unknown as { __mounted: boolean }).__mounted = true;
  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.textContent = "mounted";
}

function waitFor(cond: () => boolean, maxIters = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tick = () => {
      if (cond()) return resolve();
      if (++i >= maxIters) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 0);
    };
    tick();
  });
}

main().catch((err) => {
  errors.push({ source: "onError", detail: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
  (globalThis as unknown as { __mountFailed: boolean }).__mountFailed = true;
});
