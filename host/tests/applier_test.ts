import { assertEquals } from "jsr:@std/assert@1";
import { parseHTML } from "linkedom";
import { DomApplier, type ListenerDelegate } from "../src/applier.ts";
import type { TemplateNodeDesc } from "../src/decoder.ts";

function makeRoot() {
  const { document } = parseHTML("<!doctype html><html><body><div id=root></div></body></html>");
  const root = document.getElementById("root")!;
  return { document, root };
}

function recordingDelegate(): { events: unknown[]; delegate: ListenerDelegate } {
  const events: unknown[] = [];
  return {
    events,
    delegate: {
      add(_el, elementId, nameId, name, bubbles) {
        events.push({ op: "add", elementId, nameId, name, bubbles });
      },
      remove(_el, elementId, nameId, name, bubbles) {
        events.push({ op: "remove", elementId, nameId, name, bubbles });
      },
      purge(elementId, el) {
        events.push({ op: "purge", elementId, el });
      },
    },
  };
}

Deno.test("template register + loadTemplate + appendChildren -> innerHTML", () => {
  const { root } = makeRoot();
  const { delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);

  applier.cacheString(0, "div");
  applier.cacheString(1, "class");

  const tmplRoots: TemplateNodeDesc[] = [
    {
      kind: "element",
      tag: 0,
      ns: null,
      attrs: [{ name: 1, ns: null, value: "container" }],
      children: [{ kind: "text", value: "hi" }],
    },
  ];
  applier.registerTemplate(0, tmplRoots);
  applier.loadTemplate(0, 0, 1); // pushes cloned root, records node 1
  applier.appendChildren(0, 1); // root (id 0) <- top 1 stack node

  assertEquals(root.innerHTML, '<div class="container">hi</div>');
});

Deno.test("assignId + setText on a template text node via path", () => {
  const { root } = makeRoot();
  const { delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);
  applier.cacheString(0, "div");

  const tmplRoots: TemplateNodeDesc[] = [
    {
      kind: "element",
      tag: 0,
      ns: null,
      attrs: [],
      children: [{ kind: "text", value: "old" }, { kind: "dynamic" }],
    },
  ];
  applier.registerTemplate(0, tmplRoots);
  applier.loadTemplate(0, 0, 1);
  applier.appendChildren(0, 1);

  // path [0] from the loaded root (top of stack was the loaded template,
  // but appendChildren already popped it — assignId must walk from the
  // template root while it's still on the stack, so do it before append).
  const { root: root2 } = makeRoot();
  const applier2 = new DomApplier(root2, delegate);
  applier2.cacheString(0, "div");
  applier2.registerTemplate(0, tmplRoots);
  applier2.loadTemplate(0, 0, 1);
  applier2.assignId(new Uint8Array([0]), 2); // first child = text "old"
  applier2.setText(2, "new");
  applier2.appendChildren(0, 1);

  assertEquals(root2.innerHTML, "<div>new<!--placeholder--></div>");
});

Deno.test("replacePlaceholder with created nodes", () => {
  const { root } = makeRoot();
  const { delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);
  applier.cacheString(0, "div");

  const tmplRoots: TemplateNodeDesc[] = [
    { kind: "element", tag: 0, ns: null, attrs: [], children: [{ kind: "dynamic" }] },
  ];
  applier.registerTemplate(0, tmplRoots);
  applier.loadTemplate(0, 0, 1);
  // replacePlaceholder must run while the loaded template root is still on
  // the stack (path walks from the stack top) — same ordering as
  // dioxus-core mutation streams: dynamic-node fixups precede the append
  // that finally pops the root off the stack.
  applier.createTextNode(2, "dynamic-text");
  applier.replacePlaceholder(new Uint8Array([0]), 1);
  applier.appendChildren(0, 1);

  assertEquals(root.innerHTML, "<div>dynamic-text</div>");
});

Deno.test("insertBefore/insertAfter/replaceWith/remove ordering", () => {
  const { root } = makeRoot();
  const { delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);

  applier.createTextNode(1, "a");
  applier.appendChildren(0, 1);
  applier.createTextNode(2, "b");
  applier.appendChildren(0, 1);
  assertEquals(root.innerHTML, "ab");

  applier.createTextNode(3, "X");
  applier.insertBefore(1, 1); // insert X before "a"
  assertEquals(root.innerHTML, "Xab");

  applier.createTextNode(4, "Y");
  applier.insertAfter(1, 1); // insert Y after "a" (node 1)
  assertEquals(root.innerHTML, "XaYb");

  applier.createTextNode(5, "Z");
  applier.replaceWith(2, 1); // replace "b" (node 2) with Z
  assertEquals(root.innerHTML, "XaYZ");

  applier.remove(3); // remove X
  assertEquals(root.innerHTML, "aYZ");
});

Deno.test("attribute semantics: class, checked, value, style ns, boolean removal, dangerous_inner_html, ns attr", () => {
  const { root, document } = makeRoot();
  const { delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);

  applier.cacheString(0, "input");
  applier.cacheString(1, "class");
  applier.cacheString(2, "checked");
  applier.cacheString(3, "value");
  applier.cacheString(4, "color");
  applier.cacheString(5, "style");
  applier.cacheString(6, "disabled");
  applier.cacheString(7, "dangerous_inner_html");
  applier.cacheString(8, "href");
  applier.cacheString(9, "http://www.w3.org/1999/xlink");

  // Build an <input> directly via a template so we exercise the element
  // path (cacheString ids for tag/attrs already set above).
  const tmplRoots: TemplateNodeDesc[] = [
    { kind: "element", tag: 0, ns: null, attrs: [], children: [] },
  ];
  applier.registerTemplate(0, tmplRoots);
  applier.loadTemplate(0, 0, 2);
  applier.appendChildren(0, 1);

  const input = root.firstElementChild!;
  assertEquals(input.tagName, "INPUT");

  // class attr (default path, non-boolean)
  applier.setAttributeText(2, 1, null, "container");
  assertEquals(input.getAttribute("class"), "container");

  // checked=true -> property, not reflected as attribute string necessarily
  applier.setAttributeBool(2, 2, null, true);
  assertEquals((input as unknown as HTMLInputElement).checked, true);
  applier.setAttributeBool(2, 2, null, false);
  assertEquals((input as unknown as HTMLInputElement).checked, false);

  // value as property
  applier.setAttributeText(2, 3, null, "hello");
  assertEquals((input as unknown as HTMLInputElement).value, "hello");

  // style namespace -> style object property
  applier.setAttributeText(2, 4, 5, "red");
  assertEquals((input as unknown as HTMLElement).style.getPropertyValue("color"), "red");

  // boolean attribute removal on falsy value (default path): "disabled" is
  // in the bool-attr table; setting to "false" must remove the attribute
  // rather than set it to the literal string "false".
  applier.setAttributeText(2, 6, null, "true");
  assertEquals(input.hasAttribute("disabled"), true);
  applier.setAttributeText(2, 6, null, "false");
  assertEquals(input.hasAttribute("disabled"), false);

  // dangerous_inner_html
  applier.setAttributeText(2, 7, null, "<b>x</b>");
  assertEquals(input.innerHTML, "<b>x</b>");

  // namespaced attribute (xlink:href) via setAttributeNS path
  applier.setAttributeText(2, 8, 9, "http://example.com");
  assertEquals(input.getAttributeNS("http://www.w3.org/1999/xlink", "href"), "http://example.com");

  void document;
});

// Advisory: removeAttribute("value") alone does not reset a live input's
// `.value` property (removeAttribute only affects the reflected attribute,
// not the property once the user/host has diverged it) — setAttributeNone
// must special-case property-backed fields the same way the truthy path
// does. Ported from dioxus v0.7.10's `remove_attribute` sledgehammer op
// (packages/interpreter/src/unified_bindings.rs); see wit/world.wit's
// attrval `none` doc comment.
Deno.test("setAttributeNone(\"value\") clears a live input's .value property, not just the attribute", () => {
  const { root } = makeRoot();
  const { delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);

  applier.cacheString(0, "input");
  applier.cacheString(1, "value");

  const tmplRoots: TemplateNodeDesc[] = [
    { kind: "element", tag: 0, ns: null, attrs: [], children: [] },
  ];
  applier.registerTemplate(0, tmplRoots);
  applier.loadTemplate(0, 0, 2);
  applier.appendChildren(0, 1);

  const input = root.firstElementChild! as unknown as HTMLInputElement;

  // Simulate the host setting an initial value, then the user typing into
  // the field (a plain property write, same as what a real `input` event
  // would leave behind — removeAttribute("value") never touches this).
  applier.setAttributeText(2, 1, null, "initial");
  input.value = "user typed this";
  assertEquals(input.value, "user typed this");

  applier.setAttributeNone(2, 1, null);

  assertEquals(input.value, "", "setAttributeNone(value) must reset the live .value property");
  assertEquals(input.hasAttribute("value"), false);
});

Deno.test("listener delegate recording for add/remove with resolved names", () => {
  const { root } = makeRoot();
  const { events, delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);

  applier.cacheString(0, "click");
  applier.createPlaceholder(1);
  applier.appendChildren(0, 1);

  applier.newEventListener(1, 0, true);
  applier.removeEventListener(1, 0, false);

  assertEquals(events, [
    { op: "add", elementId: 1, nameId: 0, name: "click", bubbles: true },
    { op: "remove", elementId: 1, nameId: 0, name: "click", bubbles: false },
  ]);
});

// ElementIds are slab indices dioxus REUSES, and the guest never emits
// remove-event-listener ops for an unmounted subtree — so overwriting a node
// table slot is the unmount signal, and the delegate must be told to drop the
// old node's registrations before the new node inherits the id.
Deno.test("purge: node-table overwrite reports the OLD node (loadTemplate/createTextNode/assignId)", () => {
  const { root } = makeRoot();
  const { events, delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);
  applier.cacheString(0, "div");

  const tmplRoots: TemplateNodeDesc[] = [
    { kind: "element", tag: 0, ns: null, attrs: [], children: [{ kind: "text", value: "t" }] },
  ];
  applier.registerTemplate(0, tmplRoots);

  // First write to id 1: fresh slot, nothing to purge.
  applier.loadTemplate(0, 0, 1);
  assertEquals(events, []);

  // Reassign id 1 via loadTemplate -> purge(1, <the first cloned root>).
  applier.loadTemplate(0, 0, 1);
  assertEquals(events.length, 1);
  const p0 = events[0] as { op: string; elementId: number; el: Node };
  assertEquals(p0.op, "purge");
  assertEquals(p0.elementId, 1);
  assertEquals((p0.el as Element).tagName, "DIV");

  // Reassign id 1 via createTextNode -> purge(1, <the second cloned root>).
  applier.createTextNode(1, "x");
  assertEquals(events.length, 2);
  assertEquals((events[1] as { elementId: number }).elementId, 1);

  // Reassign id 1 via assignId (walks from the stack top, the text node) ->
  // purge(1, <that text node>).
  applier.assignId(new Uint8Array([]), 1);
  // assignId with an empty path resolves to the stack top, which IS the
  // node already in slot 1 — same node, so no purge (guarded by old !== node).
  assertEquals(events.length, 2, "same-node rewrite must not purge");

  applier.loadTemplate(0, 0, 2); // push a template root
  applier.assignId(new Uint8Array([0]), 1); // its text child -> id 1
  assertEquals(events.length, 3);
  const p2 = events[2] as { op: string; elementId: number; el: Node };
  assertEquals(p2.op, "purge");
  assertEquals(p2.elementId, 1);
  assertEquals(p2.el.textContent, "x", "the OLD node, not the newly assigned one");
});

Deno.test("purge: remove(id) purges before detaching the node", () => {
  const { root } = makeRoot();
  const { events, delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);

  applier.createTextNode(1, "a");
  applier.appendChildren(0, 1);
  assertEquals(events, []);

  applier.remove(1);
  assertEquals(events.length, 1);
  const p = events[0] as { op: string; elementId: number; el: Node };
  assertEquals(p.op, "purge");
  assertEquals(p.elementId, 1);
  assertEquals(p.el.textContent, "a");
  assertEquals(root.innerHTML, "");
});

Deno.test("svg: template element with ns creates namespaced element", () => {
  const { root } = makeRoot();
  const { delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);

  const SVG_NS = "http://www.w3.org/2000/svg";
  applier.cacheString(0, "svg");
  applier.cacheString(1, SVG_NS);

  const tmplRoots: TemplateNodeDesc[] = [
    { kind: "element", tag: 0, ns: 1, attrs: [], children: [] },
  ];
  applier.registerTemplate(0, tmplRoots);
  applier.loadTemplate(0, 0, 1);
  applier.appendChildren(0, 1);

  const svg = root.firstElementChild!;
  assertEquals(svg.tagName.toLowerCase(), "svg");
  // linkedom's createElementNS fidelity: verified to set namespaceURI
  // correctly (checked interactively at authoring time; see report).
  assertEquals(svg.namespaceURI, SVG_NS);
});

// `nodeFor` is the ElementId->Node resolution the `dom` interface's
// element handles are built on (wit/world.wit `interface dom`): a miss is
// legal, since ids are reused slab indices.
Deno.test("nodeFor: live id resolves, unknown id is undefined", () => {
  const { root } = makeRoot();
  const { delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);

  // id 0 is the mount root (wit: "id 0 is the mount root").
  assertEquals(applier.nodeFor(0), root);

  applier.createTextNode(3, "hi");
  assertEquals(applier.nodeFor(3)?.textContent, "hi");

  assertEquals(applier.nodeFor(9), undefined);
  assertEquals(applier.nodeFor(1), undefined);
});

// `remove` unlinks the node but deliberately keeps the table slot (the
// slot is cleared when dioxus reuses the id). Documented here because the
// `dom` interface relies on it: that is exactly why its shared resolver
// checks `isConnected` on top of `nodeFor` — see createDomImports in
// host/src/host.ts.
Deno.test("nodeFor: a removed id still resolves, to a detached node", () => {
  const { root } = makeRoot();
  const { delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);

  applier.createTextNode(1, "hi");
  applier.pushRoot(1);
  applier.appendChildren(0, 1);
  assertEquals(applier.nodeFor(1)!.isConnected, true);

  applier.remove(1);
  assertEquals(applier.nodeFor(1)?.textContent, "hi", "slot survives the removal");
  assertEquals(applier.nodeFor(1)!.isConnected, false, "but the node is out of the document");
});
