// Equivalence test: the byte channel (`run`/decodeBatch) and the typed
// channel (`run-typed`/applyTyped) must produce identical DOM output for
// the same interaction sequence against the same component. A benchmark of
// a wrong implementation is worthless, so this is the load-bearing test for
// the typed track.
//
// Uses the counter example (host/tests/counter_test.ts's mount/dispatch/
// poll pattern) — it exercises templates (including nested children),
// dynamic text, several attribute value kinds, event listeners, and keyed
// list insert/remove.

import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { parseHTML } from "linkedom";
import { defaultTranslator } from "@deltic/translator";
import { mountApp } from "../src/host.ts";
import type { Mounted } from "../src/host.ts";
import { applyTyped } from "../src/typed.ts";
import type { OpSink, TemplateNodeDesc } from "../src/decoder.ts";

const COMPONENT_PATH = "../../examples/build/counter.component.wasm";

async function waitFor(cond: () => boolean, what: string, maxIters = 2000): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`waitFor timed out: ${what}`);
}

function makeRoot() {
  const { document } = parseHTML("<!doctype html><html><body><div id=root></div></body></html>");
  return document.getElementById("root")!;
}

async function loadComponentBytes(): Promise<Uint8Array> {
  const url = new URL(COMPONENT_PATH, import.meta.url);
  try {
    return await Deno.readFile(url);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(
        `component not found at ${url}. Run \`just example counter\` first ` +
          `(builds examples/build/counter.component.wasm).`,
      );
    }
    throw e;
  }
}

function byId(root: Element, id: string): Element {
  const el = root.querySelector(`#${id}`);
  if (!el) throw new Error(`no element with id=${id} in ${root.innerHTML}`);
  return el;
}

interface TrackedEvent {
  type: string;
  clientX: number;
  clientY: number;
  button: number;
  buttons: number;
  preventDefault(): void;
  stopPropagation(): void;
}

function click(): TrackedEvent {
  return {
    type: "click",
    clientX: 0,
    clientY: 0,
    button: 0,
    buttons: 0,
    preventDefault: () => {},
    stopPropagation: () => {},
  };
}

async function mountOn(channel: "bytes" | "typed"): Promise<{ root: Element; mounted: Mounted; errors: unknown[] }> {
  const root = makeRoot();
  const componentBytes = await loadComponentBytes();
  const translator = await defaultTranslator();
  const errors: unknown[] = [];
  const mounted = await mountApp({
    source: { componentBytes, translator },
    root,
    channel,
    onError: (err) => errors.push(err),
  });
  await waitFor(() => root.querySelector("#count") !== null, `${channel}: initial mount`);
  return { root, mounted, errors };
}

Deno.test("typed channel matches byte channel: counter example, full interaction sequence", async () => {
  const bytes = await mountOn("bytes");
  const typed = await mountOn("typed");

  function assertSame(step: string) {
    assertEquals(typed.root.innerHTML, bytes.root.innerHTML, `DOM mismatch after ${step}`);
  }

  assertSame("initial mount");
  assertEquals(bytes.errors, []);
  assertEquals(typed.errors, []);

  // +/- buttons: set-text + set-attribute (class toggling even/odd).
  let expectedCount = 0;
  for (const step of ["inc", "inc", "dec", "inc"]) {
    expectedCount += step === "inc" ? 1 : -1;
    const want = String(expectedCount);
    bytes.mounted.dispatch(byId(bytes.root, step), "click", click());
    typed.mounted.dispatch(byId(typed.root, step), "click", click());
    await waitFor(() => byId(bytes.root, "count").textContent === want, `${step} (bytes)`);
    await waitFor(() => byId(typed.root, "count").textContent === want, `${step} (typed)`);
    assertSame(`click ${step}`);
  }

  // Typed text input: attribute of "text" kind (value) plus dynamic text.
  bytes.mounted.dispatch(byId(bytes.root, "draft"), "input", { type: "input", value: "hello" });
  typed.mounted.dispatch(byId(typed.root, "draft"), "input", { type: "input", value: "hello" });
  await waitFor(() => byId(bytes.root, "echo").textContent === "hello", "input (bytes)");
  await waitFor(() => byId(typed.root, "echo").textContent === "hello", "input (typed)");
  assertSame("typed input");

  // List add/add/remove: keyed diff exercises load-template (nested
  // template children: li > text) / assign-id / replace-placeholder /
  // remove.
  for (const step of ["add", "add", "remove"]) {
    bytes.mounted.dispatch(byId(bytes.root, step), "click", click());
    typed.mounted.dispatch(byId(typed.root, step), "click", click());
  }
  await waitFor(
    () => bytes.root.querySelectorAll("#items li").length === 3,
    "list settle (bytes)",
  );
  await waitFor(
    () => typed.root.querySelectorAll("#items li").length === 3,
    "list settle (typed)",
  );
  assertSame("list add/add/remove");

  // Form submit: onsubmit calls prevent_default(); assert the DOM (submitted
  // counter text) stays identical across channels.
  bytes.mounted.dispatch(byId(bytes.root, "form"), "submit", { ...click(), type: "submit" });
  typed.mounted.dispatch(byId(typed.root, "form"), "submit", { ...click(), type: "submit" });
  await waitFor(() => byId(bytes.root, "submitted").textContent === "submitted 1 time(s)", "submit (bytes)");
  await waitFor(() => byId(typed.root, "submitted").textContent === "submitted 1 time(s)", "submit (typed)");
  assertSame("form submit");

  assertEquals(bytes.errors, [], "no onError on the byte channel");
  assertEquals(typed.errors, [], "no onError on the typed channel");

  bytes.mounted.dispose();
  typed.mounted.dispose();
});

// -- typed-path risk areas: unit tests directly against applyTyped --------
//
// The counter example above never happens to emit a template with more
// than one level of nesting under `register-template` per templates
// batch, nor a non-text `attr-value` case (dioxus's own attribute encoding
// only uses `text` for string-interpolated attrs, which is everything
// counter has) — so those two typed-path-specific risks (the arena
// rehydration walk; the four non-text attr-value cases) are exercised
// here directly against a recording OpSink, independent of any guest.

function recordingSink(ops: unknown[]): OpSink {
  return {
    cacheString(id, s) {
      ops.push({ op: "cache-string", id, s });
    },
    registerTemplate(tmpl, roots) {
      ops.push({ op: "register-template", tmpl, roots });
    },
    appendChildren(id, m) {
      ops.push({ op: "append-children", id, m });
    },
    assignId(path, id) {
      ops.push({ op: "assign-id", path: Array.from(path), id });
    },
    createPlaceholder(id) {
      ops.push({ op: "create-placeholder", id });
    },
    createTextNode(id, text) {
      ops.push({ op: "create-text-node", id, text });
    },
    loadTemplate(tmpl, root, id) {
      ops.push({ op: "load-template", tmpl, root, id });
    },
    replaceWith(id, m) {
      ops.push({ op: "replace-with", id, m });
    },
    replacePlaceholder(path, m) {
      ops.push({ op: "replace-placeholder", path: Array.from(path), m });
    },
    insertAfter(id, m) {
      ops.push({ op: "insert-after", id, m });
    },
    insertBefore(id, m) {
      ops.push({ op: "insert-before", id, m });
    },
    setAttributeText(id, name, ns, value) {
      ops.push({ op: "set-attribute-text", id, name, ns, value });
    },
    setAttributeFloat(id, name, ns, value) {
      ops.push({ op: "set-attribute-float", id, name, ns, value });
    },
    setAttributeInt(id, name, ns, value) {
      ops.push({ op: "set-attribute-int", id, name, ns, value });
    },
    setAttributeBool(id, name, ns, value) {
      ops.push({ op: "set-attribute-bool", id, name, ns, value });
    },
    setAttributeNone(id, name, ns) {
      ops.push({ op: "set-attribute-none", id, name, ns });
    },
    setText(id, text) {
      ops.push({ op: "set-text", id, text });
    },
    newEventListener(id, name, bubbles) {
      ops.push({ op: "new-event-listener", id, name, bubbles });
    },
    removeEventListener(id, name, bubbles) {
      ops.push({ op: "remove-event-listener", id, name, bubbles });
    },
    remove(id) {
      ops.push({ op: "remove", id });
    },
    pushRoot(id) {
      ops.push({ op: "push-root", id });
    },
  };
}

Deno.test("applyTyped: register-template arena rehydrates nested children into a tree", () => {
  const ops: unknown[] = [];
  const sink = recordingSink(ops);

  // Arena for: <div>text0<span>text1</span><!--dynamic--></div>
  //   nodes[0] = div element, children = [1, 2, 3]
  //   nodes[1] = text "text0"
  //   nodes[2] = span element, children = [4]
  //   nodes[3] = dynamic
  //   nodes[4] = text "text1"
  const nodes = [
    { kind: "element", value: { tag: 0, attrs: [], children: [1, 2, 3] } },
    { kind: "text", value: "text0" },
    { kind: "element", value: { tag: 1, attrs: [], children: [4] } },
    { kind: "dynamic" },
    { kind: "text", value: "text1" },
  ];
  applyTyped([{ kind: "register-template", value: { id: 7, nodes, roots: [0] } }] as never, sink);

  assertEquals(ops.length, 1);
  const roots = (ops[0] as { roots: TemplateNodeDesc[] }).roots;
  assertEquals(roots, [
    {
      kind: "element",
      tag: 0,
      ns: null,
      attrs: [],
      children: [
        { kind: "text", value: "text0" },
        {
          kind: "element",
          tag: 1,
          ns: null,
          attrs: [],
          children: [{ kind: "text", value: "text1" }],
        },
        { kind: "dynamic" },
      ],
    },
  ]);
});

Deno.test("applyTyped: register-template rejects an out-of-range arena index", () => {
  const nodes = [{ kind: "element", value: { tag: 0, attrs: [], children: [99] } }];
  let threw = false;
  try {
    applyTyped(
      [{ kind: "register-template", value: { id: 0, nodes, roots: [0] } }] as never,
      recordingSink([]),
    );
  } catch (e) {
    threw = true;
    assertEquals(e instanceof Error, true);
  }
  assertEquals(threw, true, "expected a thrown Error, not a silently wrong tree");
});

Deno.test("applyTyped: register-template rejects a cyclic arena", () => {
  // nodes[0].children includes 0 itself.
  const nodes = [{ kind: "element", value: { tag: 0, attrs: [], children: [0] } }];
  let threw = false;
  try {
    applyTyped(
      [{ kind: "register-template", value: { id: 0, nodes, roots: [0] } }] as never,
      recordingSink([]),
    );
  } catch (e) {
    threw = true;
    assertEquals(e instanceof Error, true);
  }
  assertEquals(threw, true, "expected a thrown Error, not a hang");
});

Deno.test("applyTyped: set-attribute's non-text attr-value cases survive to the sink", () => {
  const ops: unknown[] = [];
  const sink = recordingSink(ops);

  applyTyped(
    [
      { kind: "set-attribute", value: { id: 1, name: 2, value: { kind: "float", value: 1.5 } } },
      { kind: "set-attribute", value: { id: 1, name: 3, value: { kind: "int", value: 42n } } },
      { kind: "set-attribute", value: { id: 1, name: 4, value: { kind: "boolean", value: true } } },
      { kind: "set-attribute", value: { id: 1, name: 5, value: { kind: "none" } } },
    ] as never,
    sink,
  );

  assertEquals(ops, [
    { op: "set-attribute-float", id: 1, name: 2, ns: null, value: 1.5 },
    { op: "set-attribute-int", id: 1, name: 3, ns: null, value: 42n },
    { op: "set-attribute-bool", id: 1, name: 4, ns: null, value: true },
    { op: "set-attribute-none", id: 1, name: 5, ns: null },
  ]);
  // int arrives as bigint, matching OpSink.setAttributeInt's declared type.
  assertEquals(typeof (ops[1] as { value: unknown }).value, "bigint");
});

Deno.test("applyTyped: option<str-ref> ns absent lifts to null, not {kind:'none'}", () => {
  const ops: unknown[] = [];
  const sink = recordingSink(ops);
  applyTyped(
    [{ kind: "set-attribute", value: { id: 1, name: 2, value: { kind: "text", value: "v" } } }] as never,
    sink,
  );
  assertEquals((ops[0] as { ns: unknown }).ns, null);
  assertNotEquals(ops[0], { op: "set-attribute-text", id: 1, name: 2, ns: { kind: "none" }, value: "v" });
});

// -- F12 coverage gaps ------------------------------------------------------
//
// The counter example's full-stack equivalence test above never exercises
// these shapes (its listeners are all bubbling, its templates are
// single-root with no namespaced attrs, and its list never empties to a
// placeholder) — cheap unit cases against the recording sink instead of new
// integration mounts.

Deno.test("applyTyped: new-event-listener/remove-event-listener carry bubbles verbatim, both values", () => {
  // This matters more than most: an inverted `bubbles` bit would NOT show
  // up in an innerHTML diff at all (it only changes the host's listener
  // delegation strategy — root-delegated vs per-element — not the
  // markup), so this has to be asserted directly against the sink.
  const ops: unknown[] = [];
  const sink = recordingSink(ops);
  applyTyped(
    [
      { kind: "new-event-listener", value: { id: 1, name: 10, bubbles: true } },
      { kind: "new-event-listener", value: { id: 2, name: 11, bubbles: false } },
      { kind: "remove-event-listener", value: { id: 1, name: 10, bubbles: true } },
      { kind: "remove-event-listener", value: { id: 2, name: 11, bubbles: false } },
    ] as never,
    sink,
  );
  assertEquals(ops, [
    { op: "new-event-listener", id: 1, name: 10, bubbles: true },
    { op: "new-event-listener", id: 2, name: 11, bubbles: false },
    { op: "remove-event-listener", id: 1, name: 10, bubbles: true },
    { op: "remove-event-listener", id: 2, name: 11, bubbles: false },
  ]);
});

Deno.test("applyTyped: option<str-ref> ns PRESENT lifts to the bare id, on set-attribute and template attrs", () => {
  const ops: unknown[] = [];
  const sink = recordingSink(ops);

  // set-attribute path.
  applyTyped(
    [{ kind: "set-attribute", value: { id: 1, name: 2, ns: 9, value: { kind: "text", value: "v" } } }] as never,
    sink,
  );
  assertEquals(ops, [{ op: "set-attribute-text", id: 1, name: 2, ns: 9, value: "v" }]);

  // template-attr path (attrs: [] in every other arena test means this is
  // otherwise uncovered): a static template attribute carrying a namespace.
  ops.length = 0;
  const nodes = [
    { kind: "element", value: { tag: 0, ns: 9, attrs: [{ name: 3, ns: 9, value: "v" }], children: [] } },
  ];
  applyTyped([{ kind: "register-template", value: { id: 0, nodes, roots: [0] } }] as never, sink);
  const roots = (ops[0] as { roots: TemplateNodeDesc[] }).roots;
  assertEquals(roots, [{ kind: "element", tag: 0, ns: 9, attrs: [{ name: 3, ns: 9, value: "v" }], children: [] }]);
});

Deno.test("applyTyped: register-template with multiple roots indexes each root correctly", () => {
  // Arena for two roots: root0 = text "a", root1 = element with a child.
  //   nodes[0] = text "a"           (root 0)
  //   nodes[1] = element, children = [2]   (root 1)
  //   nodes[2] = text "b"
  const ops: unknown[] = [];
  const sink = recordingSink(ops);
  const nodes = [
    { kind: "text", value: "a" },
    { kind: "element", value: { tag: 0, attrs: [], children: [2] } },
    { kind: "text", value: "b" },
  ];
  applyTyped([{ kind: "register-template", value: { id: 0, nodes, roots: [0, 1] } }] as never, sink);

  const roots = (ops[0] as { roots: TemplateNodeDesc[] }).roots;
  assertEquals(roots, [
    { kind: "text", value: "a" },
    {
      kind: "element",
      tag: 0,
      ns: null,
      attrs: [],
      children: [{ kind: "text", value: "b" }],
    },
  ]);
});

Deno.test("applyTyped: create-placeholder reaches the sink with the bare element id", () => {
  const ops: unknown[] = [];
  const sink = recordingSink(ops);
  applyTyped([{ kind: "create-placeholder", value: 4 }] as never, sink);
  assertEquals(ops, [{ op: "create-placeholder", id: 4 }]);
});
