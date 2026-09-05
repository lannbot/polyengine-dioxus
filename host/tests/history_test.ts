// Unit coverage for `memoryHistory` and the host side of
// `polymorph:dioxus/history` (wit/world.wit `interface history`) built over
// it — no component, no browser.

import { assertEquals } from "jsr:@std/assert@1";
import { createHistoryImports, memoryHistory } from "../src/history.ts";

async function collectOne(it: AsyncIterator<string>): Promise<IteratorResult<string>> {
  return await it.next();
}

Deno.test("memoryHistory: push/current/canBack, replace does not grow the stack", () => {
  const h = memoryHistory("/");
  assertEquals(h.current(), "/");
  assertEquals(h.canBack(), false);
  h.push("/a");
  assertEquals(h.current(), "/a");
  assertEquals(h.canBack(), true);
  h.replace("/b");
  assertEquals(h.current(), "/b");
  assertEquals(h.canBack(), true);
  h.back();
  assertEquals(h.current(), "/");
  assertEquals(h.canBack(), false);
});

Deno.test("memoryHistory: back/forward move the index and canForward reflects it", () => {
  const h = memoryHistory("/");
  h.push("/a");
  h.push("/b");
  assertEquals(h.canForward(), false);
  h.back();
  assertEquals(h.current(), "/a");
  assertEquals(h.canForward(), true);
  h.forward();
  assertEquals(h.current(), "/b");
  assertEquals(h.canForward(), false);
});

Deno.test("memoryHistory: push after back drops the stale forward history", () => {
  const h = memoryHistory("/");
  h.push("/a");
  h.push("/b");
  h.back(); // at /a, /b still forward-reachable
  h.push("/c"); // drops /b
  assertEquals(h.current(), "/c");
  assertEquals(h.canForward(), false);
});

Deno.test("memoryHistory: external always refuses", () => {
  const h = memoryHistory();
  assertEquals(h.external("https://example.com"), false);
});

Deno.test("memoryHistory: push/replace do not emit; back/forward do", () => {
  const h = memoryHistory("/");
  const seen: string[] = [];
  h.onChange((r) => seen.push(r));
  h.push("/a");
  h.replace("/b");
  assertEquals(seen, []);
  h.back();
  assertEquals(seen, ["/"]);
  h.forward();
  assertEquals(seen, ["/", "/b"]);
});

Deno.test("history import table: current/prefix/canGoBack/canGoForward mirror the provider", () => {
  const h = memoryHistory("/");
  h.push("/a");
  const table = createHistoryImports(h);
  assertEquals(table.currentRoute(), "/a");
  assertEquals(table.currentPrefix(), undefined);
  assertEquals(table.canGoBack(), true);
  assertEquals(table.canGoForward(), false);
});

Deno.test("history import table: push/replace act on the provider and answer true", () => {
  const h = memoryHistory("/");
  const table = createHistoryImports(h);
  assertEquals(table.push("/a"), true);
  assertEquals(h.current(), "/a");
  assertEquals(table.replace("/b"), true);
  assertEquals(h.current(), "/b");
});

Deno.test("history import table: goBack/goForward drive the provider", () => {
  const h = memoryHistory("/");
  h.push("/a");
  const table = createHistoryImports(h);
  table.goBack();
  assertEquals(h.current(), "/");
  table.goForward();
  assertEquals(h.current(), "/a");
});

Deno.test("history import table: changes() yields a route on a host-driven back()", async () => {
  const h = memoryHistory("/");
  h.push("/a");
  const table = createHistoryImports(h);
  const stream = table.changes();
  const it = stream[Symbol.asyncIterator]();
  const pending = collectOne(it);
  h.back();
  assertEquals(await pending, { value: "/", done: false });
});

Deno.test("history import table: a second changes() call returns an already-closed stream", async () => {
  const h = memoryHistory("/");
  const table = createHistoryImports(h);
  table.changes();
  const second = table.changes();
  const it = second[Symbol.asyncIterator]();
  const r = await it.next();
  assertEquals(r.done, true);
});

Deno.test("history import table: an interceptor can refuse push, leaving the provider unchanged", () => {
  const h = memoryHistory("/");
  const table = createHistoryImports(h, {
    push: () => false,
  });
  assertEquals(table.push("/a"), false);
  assertEquals(h.current(), "/");
});
