// Ad-hoc subpath-serving probe for harness/dist-pages/ (GitHub Pages
// verification gate). NOT part of the e2e/ Playwright suite: this is a
// throwaway script, run manually / by CI as a separate step, that mimics
// GitHub Pages project-site hosting (served under
// `/polyengine-dioxus/...`, never at domain root) to catch any lingering
// absolute-path fetch that would only surface at that base path.
//
// Usage: deno run -A harness/verify-pages-subpath.ts
//
// Rules followed (~/.config/opencode/AGENTS.md "Ad-hoc dev servers"):
//   - bind port 0, parse the real port from the server's own stdout.
//   - kill by PID with a /proc/<pid>/cwd check, never by port pattern.

import { extname, join, normalize } from "jsr:@std/path@1";
import { dirname, fromFileUrl } from "jsr:@std/path@1";
import { chromium } from "npm:playwright@1";

const repoRoot = normalize(join(dirname(fromFileUrl(import.meta.url)), ".."));
const distPagesDir = join(repoRoot, "harness", "dist-pages");
const MOUNT_PREFIX = "/polyengine-dioxus";

try {
  await Deno.stat(distPagesDir);
} catch {
  console.error(`${distPagesDir} missing — run \`just pages\` first.`);
  Deno.exit(1);
}

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
    if (e instanceof Deno.errors.NotFound) return new Response(`not found: ${path}`, { status: 404 });
    throw e;
  }
}

function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let pathname = url.pathname;
  if (!pathname.startsWith(MOUNT_PREFIX)) {
    return Promise.resolve(new Response("not found (outside mount prefix)", { status: 404 }));
  }
  pathname = pathname.slice(MOUNT_PREFIX.length) || "/";
  if (pathname === "/") pathname = "/index.html";
  const target = normalize(join(distPagesDir, pathname));
  if (!target.startsWith(distPagesDir)) {
    return Promise.resolve(new Response("forbidden", { status: 403 }));
  }
  return serveFile(target);
}

const server = Deno.serve({ port: 0 }, handler);
const port = (server.addr as Deno.NetAddr).port;
const baseUrl = `http://127.0.0.1:${port}${MOUNT_PREFIX}/`;
console.log(`serving harness/dist-pages/ under ${baseUrl}`);

let exitCode = 0;
try {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.stack ?? err.message));
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(baseUrl);
    await page.waitForFunction(() => (globalThis as unknown as { __mounted?: boolean }).__mounted === true, {
      timeout: 15_000,
    });

    const mountFailed = await page.evaluate(
      () => (globalThis as unknown as { __mountFailed?: boolean }).__mountFailed,
    );
    if (mountFailed) throw new Error("mountApp failed (window.__mountFailed is true)");

    const header = await page.locator("header.header, .header").count();
    if (header === 0) throw new Error("TodoMVC header (.header) not found");
    const newTodoCount = await page.locator(".new-todo").count();
    if (newTodoCount === 0) throw new Error(".new-todo input not found");

    await page.locator(".new-todo").fill("buy milk");
    await page.locator(".new-todo").press("Enter");
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll(".todo-list li label")).some((el) => el.textContent === "buy milk"),
      { timeout: 5_000 },
    );

    if (pageErrors.length > 0) throw new Error(`page errors: ${JSON.stringify(pageErrors)}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${JSON.stringify(consoleErrors)}`);

    console.log("PASS: subpath TodoMVC probe (.header + .new-todo render, todo add works, zero errors)");

    // Components demo, same subpath + browser instance (dispatch: "wiring
    // the `components` example into the harness/pages assembly").
    const componentsPageErrors: string[] = [];
    page.on("pageerror", (err) => componentsPageErrors.push(err.stack ?? err.message));
    const componentsConsoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") componentsConsoleErrors.push(msg.text());
    });

    await page.goto(`${baseUrl}?app=components`);
    await page.waitForFunction(() => (globalThis as unknown as { __mounted?: boolean }).__mounted === true, {
      timeout: 15_000,
    });

    const componentsMountFailed = await page.evaluate(
      () => (globalThis as unknown as { __mountFailed?: boolean }).__mountFailed,
    );
    if (componentsMountFailed) throw new Error("components: mountApp failed (window.__mountFailed is true)");

    const showcaseCount = await page.locator("#showcase").count();
    if (showcaseCount === 0) throw new Error("components: #showcase not found");

    await page.locator("#demo-button").click();
    await page.waitForFunction(
      () => document.querySelector("#click-count")?.textContent === "1",
      { timeout: 5_000 },
    );

    if (componentsPageErrors.length > 0) {
      throw new Error(`components: page errors: ${JSON.stringify(componentsPageErrors)}`);
    }
    if (componentsConsoleErrors.length > 0) {
      throw new Error(`components: console errors: ${JSON.stringify(componentsConsoleErrors)}`);
    }

    console.log("PASS: subpath components probe (#showcase renders, #demo-button click works, zero errors)");
  } finally {
    await browser.close();
  }
} catch (e) {
  console.error("FAIL:", e instanceof Error ? e.message : String(e));
  exitCode = 1;
} finally {
  server.shutdown();
}

Deno.exit(exitCode);
