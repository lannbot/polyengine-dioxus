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
// Per-app CSS (see APP_CSS below) is injected via a `<link>` for apps
// whose example drops an `asset!`-based Stylesheet (needs the `dx` CLI's
// asset pipeline; see e.g. examples/todomvc/src/lib.rs's header) — the
// harness supplies the same stylesheet directly instead.
//
// Governing docs: host/tests/counter_test.ts (what the app does / how
// mounting works in Deno — same mountApp API, real DOM here instead of
// linkedom), host/src/host.ts (mountApp contract).
//
// Translation happens at BUILD time (embedder-api.md amendment A4): `just
// example <name>` emits a translation envelope `<name>.plan.json` next to
// the component, and this page fetches the two together and reconstitutes
// artifacts via `artifactsFromEnvelope`. No translator and no
// translator_shim.wasm is shipped — importing @deltic/translator here,
// even lazily, would put it back in the bundle.

import { artifactsFromEnvelope } from "@deltic/runtime/embedder";
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

// Per-app stylesheet map: app name -> page-relative CSS href to inject.
const APP_CSS: Record<string, string> = {
  todomvc: "./todomvc.css",
  components: "./components.css",
  primitives: "./primitives.css",
};

// Per-app selector that indicates the initial render has landed (waited
// on below before signaling window.__mounted).
const APP_MOUNTED_SELECTOR: Record<string, string> = {
  todomvc: ".todoapp",
  components: "#showcase",
  primitives: "#primitives-showcase",
};

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
  const cssHref = APP_CSS[app];
  if (cssHref) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = cssHref;
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

  // Component and envelope are independent fetches — issue them together.
  const [res, planRes] = await Promise.all([
    fetch(`./${app}.component.wasm`),
    fetch(`./${app}.plan.json`),
  ]);
  if (!res.ok) {
    throw new Error(`fetching component failed: ${res.status} ${res.statusText}`);
  }
  if (!planRes.ok) {
    throw new Error(
      `fetching translation envelope ${app}.plan.json failed: ${planRes.status} ` +
        `${planRes.statusText} — run \`just example ${app}\` to build it.`,
    );
  }
  const componentBytes = new Uint8Array(await res.arrayBuffer());
  const envelopeText = await planRes.text();

  // Build-time translation (A4): the envelope embeds the component's
  // sha-256, so a mismatched deploy fails loudly at instantiation.
  const source = artifactsFromEnvelope(envelopeText, componentBytes);

  const mounted = await mountApp({
    source,
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

  const mountedSelector = APP_MOUNTED_SELECTOR[app] ?? "#count";
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
