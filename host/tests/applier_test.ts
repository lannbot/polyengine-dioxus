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
