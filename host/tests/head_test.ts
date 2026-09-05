// Unit coverage for the host side of `polymorph:dioxus/head` (wit/world.wit
// `interface head`), driven directly against a linkedom `Document` + bare
// `DispatchGate` — no component, no instantiation.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { parseHTML } from "linkedom";
import { DispatchGate } from "../src/dispatch.ts";
import { createHeadImports } from "../src/head.ts";

function setup(allowScript = false) {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const errors: unknown[] = [];
  const gate = new DispatchGate((e) => errors.push(e));
  return { document, gate, errors, allowScript };
}

Deno.test("head: setTitle sets document.title and returns true", () => {
  const { document, gate } = setup();
  const head = createHeadImports(document, gate, { allowScript: false });
  assertEquals(head.setTitle("hello"), true);
  assertEquals(document.title, "hello");
});

Deno.test("head: createElement lands a meta tag with attrs in <head>", () => {
  const { document, gate } = setup();
  const head = createHeadImports(document, gate, { allowScript: false });
  const ok = head.createElement("meta", [["name", "probe"], ["content", "meta-value"]], undefined);
  assertEquals(ok, true);
  const meta = document.head.querySelector("meta[name=probe]")!;
  assertEquals(meta.getAttribute("content"), "meta-value");
});

Deno.test("head: createElement sets textContent from `contents` (a style body)", () => {
  const { document, gate } = setup();
  const head = createHeadImports(document, gate, { allowScript: false });
  head.createElement("style", [], "/* probe-style */");
  const style = document.head.querySelector("style")!;
  assertStringIncludes(style.textContent ?? "", "probe-style");
});

Deno.test("head: createElement refuses a script tag when allowScript is false", () => {
  const { document, gate } = setup();
  const head = createHeadImports(document, gate, { allowScript: false });
  const ok = head.createElement("script", [], "globalThis.x = 1");
  assertEquals(ok, false);
  assertEquals(document.head.querySelector("script"), null);
});

Deno.test("head: createElement allows a script tag when allowScript is true", () => {
  const { document, gate } = setup();
  const head = createHeadImports(document, gate, { allowScript: true });
  const ok = head.createElement("script", [], "globalThis.x = 1");
  assertEquals(ok, true);
  assertEquals(document.head.querySelector("script") !== null, true);
});

Deno.test("head: an interceptor can rewrite setTitle's argument (a prefix policy)", () => {
  const { document, gate } = setup();
  const head = createHeadImports(document, gate, { allowScript: false }, {
    setTitle: (next, title) => next(`prefixed: ${title}`),
  });
  head.setTitle("hello");
  assertEquals(document.title, "prefixed: hello");
});

Deno.test("head: an interceptor can refuse createElement for a specific tag (link)", () => {
  const { document, gate } = setup();
  const head = createHeadImports(document, gate, { allowScript: false }, {
    createElement: (next, tag, attrs, contents) => tag === "link" ? false : next(tag, attrs, contents),
  });
  assertEquals(head.createElement("link", [["rel", "stylesheet"]], undefined), false);
  assertEquals(document.head.querySelector("link"), null);
  assertEquals(head.createElement("meta", [], undefined), true);
});
