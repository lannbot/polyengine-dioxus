// Unit coverage for the host side of `polymorph:dioxus/dom` (wit/world.wit
// `interface dom`), driven directly against a `DomApplier` + linkedom
// document — no component, no instantiation.
//
// Geometry caveat: linkedom (like jsdom) has no layout engine.
// `getBoundingClientRect()` returns all-zeros and `scrollLeft`/`scrollWidth`
// are not implemented as accessors at all. So these tests assert PLUMBING —
// that the right property is read, that its value is forwarded unchanged
// into the right record field, and that the DOM call receives the right
// argument shape — never real geometry. Where linkedom lacks a method
// outright (`scrollTo`, `scrollIntoView`), the tests install a recording
// stub on the element, which is also how the argument mapping is checked.

import { assertEquals } from "jsr:@std/assert@1";
import { parseHTML } from "linkedom";
import { DomApplier, type ListenerDelegate } from "../src/applier.ts";
import { DispatchGate } from "../src/dispatch.ts";
import { createDomImports } from "../src/host.ts";

const noopDelegate: ListenerDelegate = {
  add() {},
  remove() {},
  purge() {},
};

function setup() {
  const { document } = parseHTML("<!doctype html><html><body><div id=root></div></body></html>");
  const root = document.getElementById("root")!;
  const applier = new DomApplier(root, noopDelegate);
  const errors: unknown[] = [];
  const gate = new DispatchGate((e) => errors.push(e));
  const dom = createDomImports(applier, gate);
  return { document, root, applier, gate, dom, errors };
}

/** A `dom` interface bound to a single node, whatever id is asked for.
 * The applier's own `nodeFor` is exercised separately (applier_test.ts,
 * and the unknown-id test below uses a real applier); these tests are
 * about what happens once a node has been resolved. */
function domOver(s: ReturnType<typeof setup>, node: unknown) {
  return createDomImports(
    { nodeFor: () => node as Node } as unknown as DomApplier,
    s.gate,
  );
}

/** An element attached to the root, typed loosely so the tests can install
 * members linkedom does not implement. */
function attached(s: ReturnType<typeof setup>, tag = "div"): Record<string, unknown> {
  const el = s.document.createElement(tag);
  s.root.appendChild(el);
  return el as unknown as Record<string, unknown>;
}

// linkedom DOES implement `isConnected` (true for an attached element,
// false for a detached one), so the detached-node liveness case below is
// genuinely exercised rather than skipped.

Deno.test("dom: getScrollOffset / getScrollSize read the element's own properties", () => {
  const s = setup();
  const el = attached(s);
  // linkedom implements no scroll accessors; assigning creates plain own
  // properties, which is exactly what the plumbing reads. Values are
  // arbitrary — there is no layout engine to produce real ones.
  el.scrollLeft = 5;
  el.scrollTop = 6;
  el.scrollWidth = 100;
  el.scrollHeight = 200;
  const dom = domOver(s, el);

  assertEquals(dom.getScrollOffset(2), { x: 5, y: 6 });
  assertEquals(dom.getScrollSize(2), { width: 100, height: 200 });
});

Deno.test("dom: an element without scroll properties is a miss, not zeros", () => {
  const s = setup();
  // A bare linkedom element: no scrollLeft/scrollWidth at all. Reporting
  // `{x: 0, y: 0}` would be inventing an answer; the contract's `none` is
  // the truthful one.
  const dom = domOver(s, attached(s));
  assertEquals(dom.getScrollOffset(1), undefined);
  assertEquals(dom.getScrollSize(1), undefined);
});

Deno.test("dom: getClientRect forwards the four record fields", () => {
  const s = setup();
  const el = attached(s);
  // No layout engine: linkedom's own getBoundingClientRect answers zeros.
  // Assert the shape (exactly the record's fields, nothing else) there,
  // then a stub to prove the values are forwarded rather than invented.
  const dom = domOver(s, el);
  assertEquals(dom.getClientRect(1), { x: 0, y: 0, width: 0, height: 0 });

  el.getBoundingClientRect = () => ({
    x: 1,
    y: 2,
    width: 3,
    height: 4,
    top: 2,
    left: 1,
    right: 4,
    bottom: 6,
  });
  assertEquals(dom.getClientRect(1), { x: 1, y: 2, width: 3, height: 4 });
});

Deno.test("dom: scrollTo maps vertical/horizontal onto block/inline", () => {
  const s = setup();
  const el = attached(s);
  const dom = domOver(s, el);

  // linkedom has no scrollIntoView at all: unsupported member => false,
  // the same miss an unknown id produces.
  assertEquals(dom.scrollTo(1, { behavior: "smooth", vertical: "start", horizontal: "end" }), false);

  const seen: unknown[] = [];
  el.scrollIntoView = (opts: unknown) => seen.push(opts);
  assertEquals(dom.scrollTo(1, { behavior: "smooth", vertical: "center", horizontal: "nearest" }), true);
  assertEquals(seen, [{ behavior: "smooth", block: "center", inline: "nearest" }]);
});

Deno.test("dom: scroll maps offset onto left/top", () => {
  const s = setup();
  const el = attached(s);
  const dom = domOver(s, el);

  assertEquals(dom.scroll(1, { x: 10, y: 20 }, "instant"), false, "linkedom has no scrollTo");

  const seen: unknown[] = [];
  el.scrollTo = (opts: unknown) => seen.push(opts);
  assertEquals(dom.scroll(1, { x: 10, y: 20 }, "instant"), true);
  assertEquals(seen, [{ left: 10, top: 20, behavior: "instant" }]);
});

Deno.test("dom: setFocus calls focus/blur", () => {
  const s = setup();
  const el = attached(s, "input");
  const dom = domOver(s, el);

  const seen: string[] = [];
  el.focus = () => seen.push("focus");
  el.blur = () => seen.push("blur");
  assertEquals(dom.setFocus(1, true), true);
  assertEquals(dom.setFocus(1, false), true);
  assertEquals(seen, ["focus", "blur"]);
});

// -- misses -------------------------------------------------------------------

Deno.test("dom: unknown id is none / false for every operation", () => {
  const s = setup();
  const dom = s.dom;
  const id = 99; // never bound

  assertEquals(dom.getScrollOffset(id), undefined);
  assertEquals(dom.getScrollSize(id), undefined);
  assertEquals(dom.getClientRect(id), undefined);
  assertEquals(dom.scrollTo(id, { behavior: "instant", vertical: "start", horizontal: "start" }), false);
  assertEquals(dom.scroll(id, { x: 0, y: 0 }, "instant"), false);
  assertEquals(dom.setFocus(id, true), false);
});

Deno.test("dom: a detached node is not live (isConnected is implemented by linkedom)", () => {
  const s = setup();
  const el = s.document.createElement("div") as unknown as Record<string, unknown>;
  // Never appended: isConnected === false.
  assertEquals((el as unknown as Node).isConnected, false, "linkedom implements isConnected");
  el.scrollLeft = 1;
  el.scrollTop = 2;
  el.focus = () => {};
  el.scrollTo = () => {};
  const dom = domOver(s, el);

  // Every capability is present; only liveness fails. This is the case
  // `DomApplier.remove` leaves behind: the node table keeps the slot until
  // dioxus reuses the id, but the node is out of the document.
  assertEquals(dom.getScrollOffset(1), undefined);
  assertEquals(dom.getClientRect(1), undefined);
  assertEquals(dom.setFocus(1, true), false);
  assertEquals(dom.scroll(1, { x: 0, y: 0 }, "instant"), false);
});

Deno.test("dom: a Text node supports nothing (same miss as an unknown id)", () => {
  const s = setup();
  const text = s.document.createTextNode("hi");
  s.root.appendChild(text);
  const dom = domOver(s, text);

  assertEquals(dom.getScrollOffset(1), undefined);
  assertEquals(dom.getScrollSize(1), undefined);
  assertEquals(dom.getClientRect(1), undefined);
  assertEquals(dom.setFocus(1, true), false);
  assertEquals(dom.scroll(1, { x: 0, y: 0 }, "instant"), false);
});

// -- reentrancy bracketing ----------------------------------------------------

Deno.test("dom: a command brackets the apply window; a query does not", async () => {
  const s = setup();
  const el = attached(s);
  const dom = domOver(s, el);

  const order: string[] = [];

  // Stand-in for the synchronous `scroll` event a real scrollTo fires,
  // whose delegated listener would dispatch into the guest that is still
  // on the stack inside this very import call.
  el.scrollTo = () => {
    s.gate.dispatch(() => {
      order.push("guest-entered");
      return Promise.resolve();
    });
    order.push("native-event-handled");
  };
  assertEquals(dom.scroll(1, { x: 0, y: 0 }, "instant"), true);
  order.push("import-returned");
  assertEquals(order, ["native-event-handled", "import-returned"], "the entry was queued, not taken");
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(order[2], "guest-entered", "and drained once the stack unwound");

  // A query fires no events, so it takes no bracket: a dispatch raised
  // during one is (correctly) entered synchronously, proving the gate is
  // idle rather than in an apply window.
  order.length = 0;
  Object.defineProperty(el, "scrollLeft", {
    get() {
      s.gate.dispatch(() => {
        order.push("guest-entered");
        return Promise.resolve();
      });
      return 0;
    },
    configurable: true,
  });
  el.scrollTop = 0;
  dom.getScrollOffset(1);
  assertEquals(order, ["guest-entered"], "no apply window around a read-only query");
});
