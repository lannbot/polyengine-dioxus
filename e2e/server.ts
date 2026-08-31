// Static file server for the E2E lane (owned by e2e/). Serves the
// harness/ directory (index.html, dist/*) at "/" and additionally maps
// "/counter.component.wasm" to examples/build/counter.component.wasm
// (built by `just example counter`, outside harness/'s own tree).
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
const componentPath = join(repoRoot, "examples", "build", "counter.component.wasm");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
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

function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let pathname = url.pathname;
  if (pathname === "/") pathname = "/index.html";

  if (pathname === "/counter.component.wasm") {
    return serveFile(componentPath);
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
