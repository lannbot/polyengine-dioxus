// Mounts the real counter example (examples/counter/src/lib.rs) and asserts
// the resulting `innerHTML` against expected literals at each step of a
// fixed interaction sequence, then unit-tests `applyOperations`'s riskier
// corners directly against a recording sink.
//
// AUTHORITY FOR THE EXPECTED LITERALS BELOW: captured from THIS repo's own
// mountApp output before the byte mutation channel (`run`/decodeBatch) was
// deleted, at a point where host/tests/typed_test.ts's differential test
// ("typed channel matches byte channel") was green — i.e. the byte and
// typed channels were proven to produce byte-for-byte identical DOM for
// this exact sequence. That equivalence makes the captured output a
// trustworthy oracle: this test pins today's (post-deletion) output to
// what was, at capture time, independently cross-checked against the other
// implementation. There is no live second implementation to diff against
// any more (deleting one side of a differential test removes its ability
// to prove anything), so an absolute assertion is what replaces it.

import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { parseHTML } from "linkedom";
import { defaultTranslator } from "@deltic/translator";
import { mountApp } from "../src/host.ts";
import { applyOperations } from "../src/operations.ts";
import type { OpSink, TemplateNodeDesc } from "../src/applier.ts";

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

const EXPECTED_INITIAL =
  '<div class="app"><section class="counter"><button data-dioxus-id="2" id="dec">-</button>' +
  '<span id="count">0</span><button data-dioxus-id="3" id="inc">+</button>' +
  '<p class="even" id="parity">count is 0</p></section><section class="echo">' +
  '<input data-dioxus-id="5" id="draft"><p id="echo"></p></section><section class="list">' +
  '<button data-dioxus-id="6" id="add">add</button><button data-dioxus-id="7" id="remove">remove</button>' +
  '<ul id="items"><li>alpha</li><li>beta</li></ul></section>' +
  '<form data-dioxus-id="8" id="form"><input id="who" name="who">' +
  '<button type="submit" id="submit">submit</button><p id="submitted">submitted 0 time(s)</p></form></div>';

const EXPECTED_AFTER_INC1 = EXPECTED_INITIAL
  .replace('<span id="count">0</span>', '<span id="count">1</span>')
  .replace('class="even" id="parity">count is 0<', 'class="odd" id="parity">count is 1<');

const EXPECTED_AFTER_INC2 = EXPECTED_INITIAL
  .replace('<span id="count">0</span>', '<span id="count">2</span>')
  .replace('class="even" id="parity">count is 0<', 'class="even" id="parity">count is 2<');

const EXPECTED_AFTER_DEC = EXPECTED_AFTER_INC1; // 2 -> 1: back to the same rendered string as after the first inc

const EXPECTED_AFTER_INC3 = EXPECTED_AFTER_INC2; // 1 -> 2: same rendered string as after the second inc

const EXPECTED_AFTER_INPUT = EXPECTED_AFTER_INC3
  .replace('<input data-dioxus-id="5" id="draft">', '<input value="hello" data-dioxus-id="5" id="draft">')
  .replace('<p id="echo"></p>', '<p id="echo">hello</p>');

const EXPECTED_AFTER_LIST = EXPECTED_AFTER_INPUT
  .replace('<ul id="items"><li>alpha</li><li>beta</li></ul>', '<ul id="items"><li>alpha</li><li>beta</li><li>item-0</li></ul>');

const EXPECTED_AFTER_SUBMIT = EXPECTED_AFTER_LIST
  .replace('<p id="submitted">submitted 0 time(s)</p>', '<p id="submitted">submitted 1 time(s)</p>');

Deno.test("mountApp + applyOperations: counter example, full interaction sequence, absolute DOM assertions", async () => {
  const root = makeRoot();
  const componentBytes = await loadComponentBytes();
  const translator = await defaultTranslator();
  const errors: unknown[] = [];
  const mounted = await mountApp({
    source: { componentBytes, translator },
    root,
    onError: (err) => errors.push(err),
  });
  await waitFor(() => root.querySelector("#count") !== null, "initial mount");
  assertEquals(root.innerHTML, EXPECTED_INITIAL, "initial mount");
  assertEquals(errors, []);

  // +/- buttons: set-text + set-attribute (class toggling even/odd).
  const steps: [string, string][] = [
    ["inc", EXPECTED_AFTER_INC1],
    ["inc", EXPECTED_AFTER_INC2],
    ["dec", EXPECTED_AFTER_DEC],
    ["inc", EXPECTED_AFTER_INC3],
  ];
  let expectedCount = 0;
  for (const [step, expected] of steps) {
    expectedCount += step === "inc" ? 1 : -1;
    const want = String(expectedCount);
    mounted.dispatch(byId(root, step), "click", click());
    await waitFor(() => byId(root, "count").textContent === want, `click ${step}`);
    assertEquals(root.innerHTML, expected, `after click ${step}`);
  }

  // Typed text input: attribute of "text" kind (value) plus dynamic text.
  mounted.dispatch(byId(root, "draft"), "input", { type: "input", value: "hello" });
  await waitFor(() => byId(root, "echo").textContent === "hello", "input");
  assertEquals(root.innerHTML, EXPECTED_AFTER_INPUT, "after typed input");

  // List add/add/remove: keyed diff exercises load-template (nested
  // template children: li > text) / assign-id / replace-placeholder /
  // remove.
  for (const step of ["add", "add", "remove"]) {
    mounted.dispatch(byId(root, step), "click", click());
  }
  await waitFor(() => root.querySelectorAll("#items li").length === 3, "list settle");
  assertEquals(root.innerHTML, EXPECTED_AFTER_LIST, "after list add/add/remove");

  // Form submit: onsubmit calls prevent_default(); assert the DOM
  // (submitted counter text) matches.
  mounted.dispatch(byId(root, "form"), "submit", { ...click(), type: "submit" });
  await waitFor(() => byId(root, "submitted").textContent === "submitted 1 time(s)", "submit");
  assertEquals(root.innerHTML, EXPECTED_AFTER_SUBMIT, "after form submit");

  assertEquals(errors, [], "no onError on the mutation channel");

  mounted.dispose();
});

// -- applyOperations risk areas: unit tests directly against a recording --
// OpSink -------------------------------------------------------------------
//
// The counter example above never happens to emit a template with more
// than one level of nesting under `register-template` per templates
// batch, nor a non-text `attr-value` case (dioxus's own attribute encoding
// only uses `text` for string-interpolated attrs, which is everything
// counter has) — so those two risks (the arena rehydration walk; the four
// non-text attr-value cases) are exercised here directly against a
// recording OpSink, independent of any guest.

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

Deno.test("applyOperations: register-template arena rehydrates nested children into a tree", () => {
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
  applyOperations([{ kind: "register-template", value: { id: 7, nodes, roots: [0] } }] as never, sink);

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

Deno.test("applyOperations: register-template rejects an out-of-range arena index", () => {
  const nodes = [{ kind: "element", value: { tag: 0, attrs: [], children: [99] } }];
  let threw = false;
  try {
    applyOperations(
      [{ kind: "register-template", value: { id: 0, nodes, roots: [0] } }] as never,
      recordingSink([]),
    );
  } catch (e) {
    threw = true;
    assertEquals(e instanceof Error, true);
  }
  assertEquals(threw, true, "expected a thrown Error, not a silently wrong tree");
});

Deno.test("applyOperations: register-template rejects a cyclic arena", () => {
  // nodes[0].children includes 0 itself.
  const nodes = [{ kind: "element", value: { tag: 0, attrs: [], children: [0] } }];
  let threw = false;
  try {
    applyOperations(
      [{ kind: "register-template", value: { id: 0, nodes, roots: [0] } }] as never,
      recordingSink([]),
    );
  } catch (e) {
    threw = true;
    assertEquals(e instanceof Error, true);
  }
  assertEquals(threw, true, "expected a thrown Error, not a hang");
});

Deno.test("applyOperations: set-attribute's non-text attr-value cases survive to the sink", () => {
  const ops: unknown[] = [];
  const sink = recordingSink(ops);

  applyOperations(
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

Deno.test("applyOperations: option<str-ref> ns absent lifts to null, not {kind:'none'}", () => {
  const ops: unknown[] = [];
  const sink = recordingSink(ops);
  applyOperations(
    [{ kind: "set-attribute", value: { id: 1, name: 2, value: { kind: "text", value: "v" } } }] as never,
    sink,
  );
  assertEquals((ops[0] as { ns: unknown }).ns, null);
  assertNotEquals(ops[0], { op: "set-attribute-text", id: 1, name: 2, ns: { kind: "none" }, value: "v" });
});

// -- F12 coverage gaps ------------------------------------------------------
//
// The counter example's full-stack test above never exercises these shapes
// (its listeners are all bubbling, its templates are single-root with no
// namespaced attrs, and its list never empties to a placeholder) — cheap
// unit cases against the recording sink instead of new integration mounts.

Deno.test("applyOperations: new-event-listener/remove-event-listener carry bubbles verbatim, both values", () => {
  // This matters more than most: an inverted `bubbles` bit would NOT show
  // up in an innerHTML diff at all (it only changes the host's listener
  // delegation strategy — root-delegated vs per-element — not the
  // markup), so this has to be asserted directly against the sink.
  const ops: unknown[] = [];
  const sink = recordingSink(ops);
  applyOperations(
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

Deno.test("applyOperations: option<str-ref> ns PRESENT lifts to the bare id, on set-attribute and template attrs", () => {
  const ops: unknown[] = [];
  const sink = recordingSink(ops);

  // set-attribute path.
  applyOperations(
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
  applyOperations([{ kind: "register-template", value: { id: 0, nodes, roots: [0] } }] as never, sink);
  const roots = (ops[0] as { roots: TemplateNodeDesc[] }).roots;
  assertEquals(roots, [{ kind: "element", tag: 0, ns: 9, attrs: [{ name: 3, ns: 9, value: "v" }], children: [] }]);
});

Deno.test("applyOperations: register-template with multiple roots indexes each root correctly", () => {
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
  applyOperations([{ kind: "register-template", value: { id: 0, nodes, roots: [0, 1] } }] as never, sink);

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

Deno.test("applyOperations: create-placeholder reaches the sink with the bare element id", () => {
  const ops: unknown[] = [];
  const sink = recordingSink(ops);
  applyOperations([{ kind: "create-placeholder", value: 4 }] as never, sink);
  assertEquals(ops, [{ op: "create-placeholder", id: 4 }]);
});
