// Static file server for the E2E lane (owned by e2e/). Serves the
// harness/ directory (index.html, dist/*, todomvc.css) at "/" and
// additionally maps "/<name>.component.wasm" and "/<name>.plan.json" to
// examples/build/<name>.* (built by `just example <name>`, outside
// harness/'s own tree) for each known example.
//
// MANDATORY per dispatch: bind port 0, print the real port so the caller
// can parse it — never hard-code a port (parallel worktrees collide).
//
// Usage: deno run --allow-net --allow-read e2e/server.ts
// Prints exactly one line: `LISTENING <port>`

import { extname, join, normalize } from "jsr:@std/path@1";
import { dirname, fromFileUrl } from "jsr:@std/path@1";

const repoRoot = normalize(join(dirname(fromFileUrl(import.meta.url)), ".."));
const harnessDir = join(repoRoot, "harness");
const buildDir = join(repoRoot, "examples", "build");
const KNOWN_APPS = ["counter", "todomvc", "components", "primitives"];

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
};

async function serveFile(path: string): Promise<Response> {
  try {
    const data = await Deno.readFile(path);
    const type = CONTENT_TYPES[extname(path)] ?? "application/octet-stream";
    return new Response(data, { headers: { "content-type": type } });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return new Response(`not found: ${path}`, { status: 404 });
    }
    throw e;
  }
}

/**
 * `/hydrate.html?app=<name>` — the same harness page, but with `#app`
 * already holding the app's prerendered markup, as a server would have sent
 * it. Synthesized here rather than written to disk: it is index.html plus
 * one file's contents, and a generated page checked into harness/ would
 * immediately go stale against `just ssg-example`.
 *
 * Two inline classic scripts ride along. `window.__HYDRATE` tells entry.ts
 * to ask for `render-mode.hydrate`; the stamping loop marks every
 * server-rendered element so the spec can prove those exact nodes survived
 * — the browser-side equivalent of host/tests/hydrate_component_test.ts's
 * identity assertions, which is the only thing that distinguishes hydration
 * from a re-render that happens to look the same. Classic scripts run
 * before the deferred module script that boots the app, so the stamps are
 * in place before anything hydrates.
 */
async function serveHydratePage(app: string): Promise<Response> {
  const [shell, markup] = await Promise.all([
    Deno.readTextFile(join(harnessDir, "index.html")),
    Deno.readTextFile(join(repoRoot, "examples", app, "golden.html")),
  ]);
  const injected = `<div id="app">${markup}</div>
    <script>
      window.__HYDRATE = true;
      for (const el of document.querySelectorAll("#app, #app *")) {
        el.setAttribute("data-server-rendered", "1");
      }
    </script>`;
  const html = shell.replace('<div id="app"></div>', injected);
  if (html === shell) throw new Error("harness/index.html no longer contains <div id=\"app\"></div>");
  return new Response(html, { headers: { "content-type": CONTENT_TYPES[".html"] } });
}

function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let pathname = url.pathname;
  if (pathname === "/") pathname = "/index.html";

  if (pathname === "/hydrate.html") {
    const app = url.searchParams.get("app") ?? "counter";
    if (!KNOWN_APPS.includes(app)) {
      return Promise.resolve(new Response(`unknown app: ${app}`, { status: 404 }));
    }
    return serveHydratePage(app);
  }

  if (pathname.endsWith(".component.wasm")) {
    const name = pathname.slice(1, -".component.wasm".length);
    if (KNOWN_APPS.includes(name)) {
      return serveFile(join(buildDir, `${name}.component.wasm`));
    }
  }

  // The build-time translation envelope (embedder-api.md amendment A4)
  // sits next to the component in examples/build/; entry.ts fetches it
  // page-relative, same as the component.
  if (pathname.endsWith(".plan.json")) {
    const name = pathname.slice(1, -".plan.json".length);
    if (KNOWN_APPS.includes(name)) {
      return serveFile(join(buildDir, `${name}.plan.json`));
    }
  }

  // Path-traversal guard: reject any resolved path outside harnessDir.
  const target = normalize(join(harnessDir, pathname));
  if (!target.startsWith(harnessDir)) {
    return Promise.resolve(new Response("forbidden", { status: 403 }));
  }
  return serveFile(target);
}

const server = Deno.serve({ port: 0, onListen: ({ port }) => {
  console.log(`LISTENING ${port}`);
} }, handler);

await server.finished;
