// Unit tests for `DomApplier.hydrate` / the `hydrate` operation, driven via
// `applyOperations` against hand-written prerendered fragments in linkedom.
// No component is instantiated: the prebuilt `.wasm` fixtures under
// examples/build and fixtures/build are stale against the new WIT until a
// rebuild, so any test loading one would fail for reasons unrelated to
// hydration (dispatch note in this track's dispatch).
//
// Marker HTML is lifted from dioxus-ssr-0.7.9's own hydration.rs tests
// (cited per fragment below), not invented, per this track's dispatch.

import { assertEquals, assertStrictEquals, assertThrows } from "jsr:@std/assert@1";
import { parseHTML } from "linkedom";
import { DomApplier, type ListenerDelegate } from "../src/applier.ts";
import { applyOperations } from "../src/operations.ts";
import type { Operation } from "../src/operations.ts";

function makeRoot(innerHTML: string) {
  const { document } = parseHTML(`<!doctype html><html><body><div id=root>${innerHTML}</div></body></html>`);
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

// dioxus-ssr-0.7.9 tests/hydration.rs `dynamic_attributes`:
// <div style="width:100px;" data-node-hydration="0"><div style="width:123px;"
// data-node-hydration="1"></div></div>
Deno.test("hydrate: element marker on the mount root itself, and a nested one, bind the SAME nodes already in the document", () => {
  const { root } = makeRoot(
    '<div style="width:123px;" data-node-hydration="1"></div>',
  );
  root.setAttribute("data-node-hydration", "0");
  const inner = root.firstElementChild!;
  const { delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);

  applyOperations([{ kind: "hydrate", value: [100, 200] } as unknown as Operation], applier);

  // Identity, not just equality — the property that distinguishes
  // hydration from re-rendering (dispatch).
  assertStrictEquals(applier.nodeFor(100), root);
  assertStrictEquals(applier.nodeFor(200), inner);
});

// dioxus-ssr-0.7.9 tests/hydration.rs `listeners`:
// <div width="100px" data-node-hydration="0"><div data-node-hydration="1,click:1"></div></div>
Deno.test("hydrate: a marker with a listener suffix binds and the suffix is IGNORED — no listener attached, no data-dioxus-id set", () => {
  const { root } = makeRoot('<div data-node-hydration="1,click:1"></div>');
  root.setAttribute("data-node-hydration", "0");
  const inner = root.firstElementChild!;
  const { events, delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);

  applyOperations([{ kind: "hydrate", value: [10, 20] } as unknown as Operation], applier);

  assertStrictEquals(applier.nodeFor(20), inner);
  assertEquals(events, [], "hydrate itself must not call the ListenerDelegate");
  assertEquals(inner.hasAttribute("data-dioxus-id"), false, "EventDispatcher.add sets this, not hydrate");
});

// dioxus-ssr-0.7.9 tests/hydration.rs `text_nodes`:
// <div data-node-hydration="0"><!--node-id1-->hello<!--#--></div>
Deno.test("hydrate: dynamic text — the text node between the markers binds, and BOTH marker comments are gone", () => {
  const { root } = makeRoot("<!--node-id1-->hello<!--#-->");
  root.setAttribute("data-node-hydration", "0");
  const { delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);

  applyOperations([{ kind: "hydrate", value: [1, 2] } as unknown as Operation], applier);

  const textNode = applier.nodeFor(2);
  assertEquals(textNode?.nodeType, 3 /* TEXT_NODE */);
  assertEquals(textNode?.textContent, "hello");
  assertEquals(root.innerHTML, "hello", "both <!--node-id1--> and <!--#--> must be consumed");
});

// dioxus-ssr-0.7.9 tests/hydration.rs `components_hydrate`'s `Child4`
// (empty-dynamic-text case): <!--node-id0-->1<!--#--><!--node-id1-->1<!--#-->
// adapted here to the empty-text shape core.ts:281-291 documents:
// <!--node-idN--><!--#--> with no text node between the comments.
Deno.test("hydrate: empty dynamic text — a text node is CREATED, bound, and left in the document", () => {
  const { root } = makeRoot("<!--node-id0--><!--#-->");
  const { delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);

  applyOperations([{ kind: "hydrate", value: [5] } as unknown as Operation], applier);

  const textNode = applier.nodeFor(5);
  assertEquals(textNode?.nodeType, 3 /* TEXT_NODE */);
  assertEquals(textNode?.textContent, "");
  assertStrictEquals(textNode?.parentNode, root);
  assertEquals(root.innerHTML, "", "the created empty text node renders as nothing");
});

// Placeholder marker format from dioxus-ssr-0.7.9 src/renderer.rs:215
// (`write!(buf, "<!--placeholder{}-->", ...)`) — no `pre_render` output in
// hydration.rs happens to contain one, so the shape (not a full app) is
// taken straight from the renderer source (dispatch cites this authority).
Deno.test("hydrate: a placeholder comment binds to the comment node itself", () => {
  const { root } = makeRoot("<!--placeholder0-->");
  const { delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);
  const placeholderComment = root.firstChild!;

  applyOperations([{ kind: "hydrate", value: [42] } as unknown as Operation], applier);

  assertStrictEquals(applier.nodeFor(42), placeholderComment);
  assertEquals(placeholderComment.nodeType, 8 /* COMMENT_NODE */);
});

// dioxus-ssr-0.7.9 tests/hydration.rs `hello_world_hydrates`.
Deno.test("hydrate: a subsequent set-text/set-attribute op against a hydrated id reaches the pre-existing node", () => {
  const { root } = makeRoot(
    '<h1 data-node-hydration="0"><!--node-id1-->High-Five counter: 0<!--#--></h1>' +
      '<button data-node-hydration="2,click:1">Up high!</button>',
  );
  const h1 = root.firstElementChild!;
  const button = root.lastElementChild!;
  const { delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);

  applyOperations(
    [
      { kind: "hydrate", value: [10, 11, 12] } as unknown as Operation,
      { kind: "cache-string", value: { id: 0, str: "class" } } as unknown as Operation,
      { kind: "set-text", value: { id: 11, text: "High-Five counter: 1" } } as unknown as Operation,
      {
        kind: "set-attribute",
        value: { id: 12, name: 0, value: { kind: "text", value: "active" } },
      } as unknown as Operation,
    ],
    applier,
  );

  assertStrictEquals(applier.nodeFor(10), h1);
  assertStrictEquals(applier.nodeFor(12), button);
  assertEquals(h1.textContent, "High-Five counter: 1");
  assertEquals(button.getAttribute("class"), "active");
});

// -- validation -------------------------------------------------------------

Deno.test("hydrate: throws on an out-of-range marker index", () => {
  const { root } = makeRoot('<div data-node-hydration="5"></div>');
  const { delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);

  assertThrows(
    () => applyOperations([{ kind: "hydrate", value: [1, 2] } as unknown as Operation], applier),
    Error,
  );
});

Deno.test("hydrate: throws on a duplicated marker index", () => {
  const { root } = makeRoot(
    '<div data-node-hydration="0"></div><div data-node-hydration="0"></div>',
  );
  const { delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);

  assertThrows(
    () => applyOperations([{ kind: "hydrate", value: [1] } as unknown as Operation], applier),
    Error,
  );
});

Deno.test("hydrate: throws when a marker index is never matched", () => {
  const { root } = makeRoot('<div data-node-hydration="0"></div>');
  const { delegate } = recordingDelegate();
  const applier = new DomApplier(root, delegate);

  // ids has two slots (0 and 1), but only marker "0" is present in the DOM.
  assertThrows(
    () => applyOperations([{ kind: "hydrate", value: [1, 2] } as unknown as Operation], applier),
    Error,
  );
});
