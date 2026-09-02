// GitHub Pages static-site assembly for the harness's example apps (owned
// by harness/). Run via `deno run -A harness/pages.ts`, or through `just
// pages`.
//
// Produces a FLAT harness/dist-pages/ (gitignored — see repo .gitignore's
// `dist-pages/` entry) that works when served from any base path,
// including a GitHub Pages project-site subpath
// (https://<user>.github.io/polyengine-dioxus/). Every URL in the
// assembled page/bundle must be relative:
//   - index.html's <script src> is "./entry.js" (page-relative).
//   - entry.js's own `new URL("./translator_shim.wasm", import.meta.url)`
//     and `new URL("./build-stamp.json", import.meta.url)` resolve
//     relative to wherever entry.js itself is fetched from — so entry.js
//     must sit directly next to those assets, i.e. NOT nested under a
//     dist/ subdirectory the way harness/dist/ is for the dev lane. This
//     assembly copies dist/entry.js straight into dist-pages/'s root
//     alongside translator_shim.wasm and build-stamp.json to match.
//   - entry.ts's component fetch (`./${app}.component.wasm`) and its
//     per-app stylesheet `<link>` (harness/entry.ts's APP_CSS map) are
//     already page-relative — both resolve correctly once copied next to
//     index.html here.
//
// Default app: index.html sets `window.__DEFAULT_APP = "todomvc"` in an
// inline script BEFORE the module script runs (entry.ts reads
// `?app=` first, falling back to `window.__DEFAULT_APP`, then
// "counter" — see harness/entry.ts). `?app=counter` still works against
// this same deployed bundle since counter.component.wasm is included
// too.

import { dirname, fromFileUrl, join, normalize } from "jsr:@std/path@1";
import { buildHarness } from "./build.ts";

const repoRoot = normalize(join(dirname(fromFileUrl(import.meta.url)), ".."));
const harnessDir = join(repoRoot, "harness");
const distDir = join(harnessDir, "dist");
const distPagesDir = join(harnessDir, "dist-pages");
const buildDir = join(repoRoot, "examples", "build");

const PAGES_INDEX_HTML = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <!-- Mobile: without width=device-width the page lays out at a 980px
         desktop viewport scaled to ~0.4x on a phone, AND Android Chrome
         and Firefox keep the ~300ms double-tap-zoom wait on every tap
         (they only drop it for mobile-optimized pages) — which reads as
         sluggish interaction no matter how fast the renderer is.
         initial-scale=1 without maximum-scale/user-scalable keeps
         pinch-zoom available (blocking it is an accessibility problem);
         the touch-action rule below removes the double-tap delay on its
         own, belt-and-braces with the meta. -->
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>polymorph-dioxus examples — GitHub Pages demo</title>
    <!-- No hardcoded stylesheet here: entry.ts injects each app's CSS
         (APP_CSS map). A hardcoded todomvc.css link would leak TodoMVC's
         UNLAYERED global button/input resets into the other demos, where
         they beat Tailwind's @layer utilities rules regardless of
         specificity — observed live as unstyled gallery buttons. -->
    <style>
      /* Drops the double-tap-zoom wait on taps (pinch-zoom still works). */
      html { touch-action: manipulation; }
      nav.examples-nav { font-family: sans-serif; padding: 0.5rem 1rem; border-bottom: 1px solid #ccc; }
      nav.examples-nav a { margin-right: 1rem; }
    </style>
  </head>
  <body>
    <nav class="examples-nav">
      <a href="./?app=todomvc">TodoMVC</a>
      <a href="./?app=counter">Counter</a>
      <a href="./?app=components">Components</a>
    </nav>
    <pre id="status">loading…</pre>
    <div id="app"></div>
    <script>
      window.__DEFAULT_APP = "todomvc";
    </script>
    <script type="module" src="./entry.js"></script>
  </body>
</html>
`;

async function requireComponent(name: string): Promise<string> {
  const path = join(buildDir, `${name}.component.wasm`);
  try {
    await Deno.stat(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(
        `${path} missing — run \`just example ${name}\` first (or \`just pages\`, which does this for you).`,
      );
    }
    throw e;
  }
  return path;
}

export async function buildPages(): Promise<void> {
  // Reuse the dev bundle build (dist/entry.js, dist/translator_shim.wasm,
  // dist/build-stamp.json) — the assembly below just re-lays those flat.
  await buildHarness();

  const todomvcWasm = await requireComponent("todomvc");
  const counterWasm = await requireComponent("counter");
  const componentsWasm = await requireComponent("components");

  await Deno.mkdir(distPagesDir, { recursive: true });

  await Deno.writeTextFile(join(distPagesDir, "index.html"), PAGES_INDEX_HTML);
  // GitHub Pages runs Jekyll processing by default, which ignores
  // dotfiles/underscore-prefixed paths; harness assets don't use those
  // conventions but the marker is the standard opt-out and costs nothing.
  await Deno.writeTextFile(join(distPagesDir, ".nojekyll"), "");

  await Deno.copyFile(join(distDir, "entry.js"), join(distPagesDir, "entry.js"));
  await Deno.copyFile(join(distDir, "translator_shim.wasm"), join(distPagesDir, "translator_shim.wasm"));
  await Deno.copyFile(join(distDir, "build-stamp.json"), join(distPagesDir, "build-stamp.json"));
  await Deno.copyFile(join(harnessDir, "todomvc.css"), join(distPagesDir, "todomvc.css"));
  await Deno.copyFile(todomvcWasm, join(distPagesDir, "todomvc.component.wasm"));
  await Deno.copyFile(counterWasm, join(distPagesDir, "counter.component.wasm"));
  await Deno.copyFile(join(harnessDir, "components.css"), join(distPagesDir, "components.css"));
  await Deno.copyFile(componentsWasm, join(distPagesDir, "components.component.wasm"));
}

if (import.meta.main) {
  await buildPages();
  console.log("GitHub Pages site assembled at", distPagesDir);
}
