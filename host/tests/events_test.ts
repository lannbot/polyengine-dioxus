import { assertEquals } from "jsr:@std/assert@1";
import { parseHTML } from "linkedom";
import { EventDispatcher, serializePayload } from "../src/events.ts";

function makeRoot() {
  const { document } = parseHTML("<!doctype html><html><body><div id=root></div></body></html>");
  const root = document.getElementById("root")!;
  return { document, root };
}

type Recorded = { elementId: number; nameId: number; name: string; ev: unknown };

function recordingSink(): { sink: (e: number, n: number, name: string, ev: unknown) => void; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    sink: (elementId, nameId, name, ev) => calls.push({ elementId, nameId, name, ev }),
  };
}

// -- registration / delegation lifecycle -------------------------------------

Deno.test("bubbling: one root listener refcounted across elements", () => {
  const { document, root } = makeRoot();
  const { sink, calls } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);

  const a = document.createElement("button");
  const b = document.createElement("button");
  root.appendChild(a);
  root.appendChild(b);

  dispatcher.add(a, 1, 10, "click", true);
  dispatcher.add(b, 2, 10, "click", true);

  assertEquals(a.getAttribute("data-dioxus-id"), "1");
  assertEquals(b.getAttribute("data-dioxus-id"), "2");

  // Both resolve through the single delegated root listener.
  a.dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
  assertEquals(calls.length, 1);
  assertEquals(calls[0], { elementId: 1, nameId: 10, name: "click", ev: calls[0].ev });

  b.dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
  assertEquals(calls.length, 2);
  assertEquals(calls[1].elementId, 2);

  dispatcher.remove(a, 1, 10, "click", true);
  assertEquals(a.hasAttribute("data-dioxus-id"), false, "attribute dropped once last listener removed");
  dispatcher.remove(b, 2, 10, "click", true);
  assertEquals(b.hasAttribute("data-dioxus-id"), false);
});

Deno.test("non-bubbling: per-element listener, independent of other elements", () => {
  const { document, root } = makeRoot();
  const { sink, calls } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);

  const el = document.createElement("input");
  root.appendChild(el);
  dispatcher.add(el, 5, 20, "focus", false);

  el.dispatchEvent(new document.defaultView!.Event("focus"));
  assertEquals(calls.length, 1);
  assertEquals(calls[0].elementId, 5);

  dispatcher.remove(el, 5, 20, "focus", false);
  assertEquals(el.hasAttribute("data-dioxus-id"), false);
});

Deno.test("data-dioxus-id persists while other registrations remain on the element", () => {
  const { document, root } = makeRoot();
  const { sink } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);

  const el = document.createElement("div");
  root.appendChild(el);
  dispatcher.add(el, 3, 1, "click", true);
  dispatcher.add(el, 3, 2, "keydown", true);

  dispatcher.remove(el, 3, 1, "click", true);
  assertEquals(el.getAttribute("data-dioxus-id"), "3", "keydown registration still live");

  dispatcher.remove(el, 3, 2, "keydown", true);
  assertEquals(el.hasAttribute("data-dioxus-id"), false);
});

// -- target resolution --------------------------------------------------------

Deno.test("dispatchTo walks ancestors to the first element with a matching registration", () => {
  const { document, root } = makeRoot();
  const { sink, calls } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);

  const outer = document.createElement("section");
  const inner = document.createElement("span");
  outer.appendChild(inner);
  root.appendChild(outer);

  dispatcher.add(outer, 7, 1, "click", true);

  // `inner` has no data-dioxus-id of its own; dispatchTo must walk up to
  // `outer` (which does, and has a "click" registration).
  dispatcher.dispatchTo(inner, "click", { type: "click" });
  assertEquals(calls, [{ elementId: 7, nameId: 1, name: "click", ev: { type: "click" } }]);
});

Deno.test("dispatchTo skips an ancestor's data-dioxus-id if it lacks a registration for this name", () => {
  const { document, root } = makeRoot();
  const { sink, calls } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);

  const outer = document.createElement("section");
  const middle = document.createElement("div");
  const inner = document.createElement("span");
  outer.appendChild(middle);
  middle.appendChild(inner);
  root.appendChild(outer);

  // `middle` has an id (registered for "keydown" only); "click" is only
  // registered on `outer`. The walk must skip past `middle`.
  dispatcher.add(middle, 8, 2, "keydown", true);
  dispatcher.add(outer, 9, 1, "click", true);

  dispatcher.dispatchTo(inner, "click", { type: "click" });
  assertEquals(calls, [{ elementId: 9, nameId: 1, name: "click", ev: { type: "click" } }]);
});

Deno.test("dispatchTo is a no-op when no ancestor has a matching registration", () => {
  const { document, root } = makeRoot();
  const { sink, calls } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);

  const el = document.createElement("div");
  root.appendChild(el);

  dispatcher.dispatchTo(el, "click", { type: "click" });
  assertEquals(calls, []);
});

// Registrations belong to THIS dispatcher's mount root, and ElementIds are
// per-instance — an ancestor above the root carrying a `data-dioxus-id`
// (a second mounted app, or a stray attribute in the page) must never
// resolve, or one instance dispatches another's ids.
Deno.test("dispatchTo stops at the mount root and never matches an ancestor above it", () => {
  const { document, root } = makeRoot();
  const { sink, calls } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);

  // A wrapper OUTSIDE the root, carrying an id that IS live in this
  // dispatcher (registered on an element inside the root).
  const wrapper = document.createElement("div");
  root.parentNode!.insertBefore(wrapper, root);
  wrapper.appendChild(root);

  const live = document.createElement("button");
  root.appendChild(live);
  dispatcher.add(live, 7, 1, "click", true);
  wrapper.setAttribute("data-dioxus-id", "7");

  // Walk starts inside the root at an element with no registration; nothing
  // between it and the root matches, so it must stop rather than reach the
  // wrapper's borrowed id.
  const inner = document.createElement("span");
  root.appendChild(inner);
  dispatcher.dispatchTo(inner, "click", { type: "click" });
  assertEquals(calls, []);

  // Sanity: the root itself is still eligible (it is node id 0).
  dispatcher.add(root, 0, 1, "click", true);
  dispatcher.dispatchTo(inner, "click", { type: "click" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].elementId, 0);
});

// -- purge (unmount / id reuse) ----------------------------------------------

Deno.test("purge: dispatchTo on the purged element no-ops and the id attribute is dropped", () => {
  const { document, root } = makeRoot();
  const { sink, calls } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);

  const el = document.createElement("button");
  root.appendChild(el);
  dispatcher.add(el, 4, 1, "click", true);
  dispatcher.add(el, 4, 2, "focus", false);

  dispatcher.dispatchTo(el, "click", { type: "click" });
  assertEquals(calls.length, 1);

  dispatcher.purge(4, el);
  assertEquals(el.hasAttribute("data-dioxus-id"), false);

  dispatcher.dispatchTo(el, "click", { type: "click" });
  assertEquals(calls.length, 1, "no dispatch after purge");

  // The non-bubbling listener was detached from the element itself.
  el.setAttribute("data-dioxus-id", "4");
  el.dispatchEvent(new document.defaultView!.Event("focus"));
  assertEquals(calls.length, 1, "per-element listener detached by purge");
});

Deno.test("purge releases the purged element's share of the bubbling refcount", () => {
  const { document, root } = makeRoot();
  const { sink, calls } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);

  const removals: string[] = [];
  // deno-lint-ignore no-explicit-any
  const realRemove = (root as any).removeEventListener.bind(root);
  // deno-lint-ignore no-explicit-any
  (root as any).removeEventListener = (name: string, listener: any) => {
    removals.push(name);
    return realRemove(name, listener);
  };

  const a = document.createElement("button");
  const b = document.createElement("button");
  root.appendChild(a);
  root.appendChild(b);
  dispatcher.add(a, 1, 10, "click", true); // refcount 1
  dispatcher.add(b, 2, 10, "click", true); // refcount 2

  dispatcher.purge(1, a); // -> refcount 1, root listener still attached
  assertEquals(removals, []);

  dispatcher.remove(b, 2, 10, "click", true); // -> refcount 0
  assertEquals(removals, ["click"], "root listener removed once the count hit zero");

  // And it really is gone: re-attribute an element and dispatch natively.
  b.setAttribute("data-dioxus-id", "2");
  b.dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
  assertEquals(calls, []);
});

Deno.test("purge of an id with no registrations is a cheap no-op", () => {
  const { document, root } = makeRoot();
  const { sink, calls } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);

  dispatcher.purge(99, document.createElement("div"));
  // Also fine for a non-Element node (the node table holds Text/Comment).
  dispatcher.purge(99, document.createTextNode("t"));
  assertEquals(calls, []);
});

// -- dispose ------------------------------------------------------------------

Deno.test("dispose detaches every listener and stops dispatch, leaving DOM alone", () => {
  const { document, root } = makeRoot();
  const { sink, calls } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);

  const a = document.createElement("button");
  const b = document.createElement("input");
  root.appendChild(a);
  root.appendChild(b);
  dispatcher.add(a, 1, 10, "click", true);
  dispatcher.add(b, 2, 20, "focus", false);

  a.dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
  b.dispatchEvent(new document.defaultView!.Event("focus"));
  assertEquals(calls.length, 2);

  dispatcher.dispose();

  a.dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
  b.dispatchEvent(new document.defaultView!.Event("focus"));
  dispatcher.dispatchTo(a, "click", { type: "click" });
  assertEquals(calls.length, 2, "no dispatch of any kind after dispose");

  // dispose detaches the runtime; it does not unrender or strip markers.
  assertEquals(a.getAttribute("data-dioxus-id"), "1");
  assertEquals(root.childNodes.length, 2);
});

// -- payload family mapping / value shapes -----------------------------------

Deno.test("serializePayload: mouse family with full field mapping + modifiers", () => {
  const payload = serializePayload("click", {
    type: "click",
    clientX: 10,
    clientY: 20,
    pageX: 11,
    pageY: 21,
    screenX: 12,
    screenY: 22,
    offsetX: 1,
    offsetY: 2,
    button: 0,
    buttons: 1,
    altKey: true,
    shiftKey: true,
  });
  assertEquals(payload, {
    kind: "mouse",
    value: {
      clientX: 10,
      clientY: 20,
      pageX: 11,
      pageY: 21,
      screenX: 12,
      screenY: 22,
      offsetX: 1,
      offsetY: 2,
      button: 0,
      buttons: 1,
      mods: { alt: true, shift: true },
    },
  });
});

Deno.test("serializePayload: mouse defensive defaults for a duck-typed event missing fields", () => {
  const payload = serializePayload("mouseenter", { type: "mouseenter" }) as {
    kind: string;
    value: Record<string, unknown>;
  };
  assertEquals(payload.kind, "mouse");
  assertEquals(payload.value.clientX, 0);
  assertEquals(payload.value.button, -1, "no applicable button -> -1 per wit doc");
  assertEquals(payload.value.mods, {}, "no true flags -> empty object");
});

Deno.test("serializePayload: pointer family nests mouse-data", () => {
  const payload = serializePayload("pointerdown", {
    type: "pointerdown",
    clientX: 5,
    pointerId: 3,
    pointerType: "touch",
    isPrimary: true,
  }) as { kind: string; value: { mouse: { clientX: number }; pointerId: number; pointerType: string } };
  assertEquals(payload.kind, "pointer");
  assertEquals(payload.value.mouse.clientX, 5);
  assertEquals(payload.value.pointerId, 3);
  assertEquals(payload.value.pointerType, "touch");
});

Deno.test("serializePayload: keyboard family", () => {
  const payload = serializePayload("keydown", {
    type: "keydown",
    key: "Enter",
    code: "Enter",
    ctrlKey: true,
  });
  assertEquals(payload, {
    kind: "keyboard",
    value: {
      key: "Enter",
      code: "Enter",
      location: 0,
      repeat: false,
      isComposing: false,
      mods: { ctrl: true },
    },
  });
});

Deno.test("serializePayload: wheel family nests mouse-data", () => {
  const payload = serializePayload("wheel", {
    type: "wheel",
    deltaY: 100,
    deltaMode: 1,
  }) as { kind: string; value: { deltaY: number; deltaMode: number; mouse: unknown } };
  assertEquals(payload.kind, "wheel");
  assertEquals(payload.value.deltaY, 100);
  assertEquals(payload.value.deltaMode, 1);
});

Deno.test("serializePayload: form family — input/change read value/checked off the target", () => {
  const { document } = makeRoot();
  const input = document.createElement("input") as unknown as { value: string; checked: boolean };
  input.value = "hello";
  input.checked = true;

  const payload = serializePayload("input", { type: "input", target: input as unknown as EventTarget });
  assertEquals(payload, { kind: "form", value: { value: "hello", checked: true, values: [] } });
});

Deno.test("serializePayload: checkbox folds checked into value (dioxus FormData::checked derivation)", () => {
  // dioxus derives checked() by parsing the value ("true"/"false"), per
  // dioxus-web's serializer convention — the real value is intentionally
  // replaced for checkboxes (ref:serialize.ts:185).
  const checkbox = { type: "checkbox", value: "on", checked: true };
  const payload = serializePayload("change", {
    type: "change",
    target: checkbox as unknown as EventTarget,
  });
  assertEquals(payload, { kind: "form", value: { value: "true", checked: true, values: [] } });

  const unchecked = { type: "checkbox", value: "on", checked: false };
  const payload2 = serializePayload("change", {
    type: "change",
    target: unchecked as unknown as EventTarget,
  });
  assertEquals(payload2, { kind: "form", value: { value: "false", checked: false, values: [] } });
});

Deno.test("serializePayload: submit collects FormData-shaped entries from the target form", () => {
  // Duck-typed rather than a real linkedom <form> (whose `tagName` is a
  // getter-only accessor) — this is a defensive-read path anyway, so the
  // family-mapping code must accept a plain object shaped like a form.
  const form = {
    tagName: "FORM",
    elements: [
      { name: "username", value: "alice" },
      { name: "agree", type: "checkbox", value: "on", checked: true },
      { name: "unchecked", type: "checkbox", value: "on", checked: false },
      { name: "ignored", value: "x", disabled: true },
    ],
  };

  const payload = serializePayload("submit", {
    type: "submit",
    target: form as unknown as EventTarget,
  }) as { kind: string; value: { values: [string, string[]][] } };
  assertEquals(payload.kind, "form");
  assertEquals(payload.value.values, [
    ["username", ["alice"]],
    ["agree", ["on"]],
  ]);
  // Note: this plain-object duck type has no native FormData fidelity
  // (radio groups, multi-select) — this covers the checkbox/basic shape
  // the dispatch asks for and flags the fidelity gap rather than fighting
  // linkedom for a full HTMLFormElement.
});

Deno.test("serializePayload: scroll family reads scrollable metrics off the target", () => {
  const target = { scrollTop: 5, scrollLeft: 6, scrollWidth: 100, scrollHeight: 200, clientWidth: 50, clientHeight: 60 };
  const payload = serializePayload("scroll", { type: "scroll", currentTarget: target as unknown as EventTarget });
  assertEquals(payload, {
    kind: "scroll",
    value: {
      scrollTop: 5,
      scrollLeft: 6,
      scrollWidth: 100,
      scrollHeight: 200,
      clientWidth: 50,
      clientHeight: 60,
    },
  });
});

Deno.test("serializePayload: unmapped event names dispatch as empty", () => {
  // `resize`/`visible` used to be the examples here; they now have real
  // payload families (see the observer-backed section at the end of this
  // file), so the assertion moved onto names that are still unmapped.
  assertEquals(serializePayload("focus", { type: "focus" }), { kind: "empty" });
  assertEquals(serializePayload("blur", { type: "blur" }), { kind: "empty" });
});

// dioxus-html-0.7.10 generated.rs name->data-type mapping: reset->Form,
// scrollend->Scroll, gotpointercapture/lostpointercapture/auxclick->Pointer
// (auxclick per the authority file, not the mouse family — see the
// CONTRACT comment on EXTRA_POINTER_EVENTS in src/events.ts).
Deno.test("serializePayload: previously-misclassified names map to their real family", () => {
  const kindOf = (name: string) => (serializePayload(name, { type: name }) as { kind: string }).kind;
  assertEquals(kindOf("reset"), "form");
  assertEquals(kindOf("scrollend"), "scroll");
  assertEquals(kindOf("gotpointercapture"), "pointer");
  assertEquals(kindOf("lostpointercapture"), "pointer");
  assertEquals(kindOf("auxclick"), "pointer");
});

// dioxus-html-0.7.10 generated.rs Drag(DragData) events= list: drag, dragend,
// dragenter, dragexit, dragleave, dragover, dragstart, drop. DragData
// implements HasMouseData, and DOM drag events are MouseEvents, so these
// route to the `mouse` family (src/events.rs's `Drag(wit::MouseData)`
// adapter is the guest-side half of this).
Deno.test("serializePayload: drag family serializes as mouse (dnd reorder needs client-y)", () => {
  const payload = serializePayload("dragover", {
    type: "dragover",
    clientX: 30,
    clientY: 40,
    button: 0,
    buttons: 1,
    altKey: true,
  }) as { kind: string; value: Record<string, unknown> };
  assertEquals(payload, {
    kind: "mouse",
    value: {
      clientX: 30,
      clientY: 40,
      pageX: 0,
      pageY: 0,
      screenX: 0,
      screenY: 0,
      offsetX: 0,
      offsetY: 0,
      button: 0,
      buttons: 1,
      mods: { alt: true },
    },
  });
});

Deno.test("serializePayload: every drag-family name maps to mouse", () => {
  const kindOf = (name: string) => (serializePayload(name, { type: name }) as { kind: string }).kind;
  for (
    const name of [
      "drag",
      "dragend",
      "dragenter",
      "dragexit",
      "dragleave",
      "dragover",
      "dragstart",
      "drop",
    ]
  ) {
    assertEquals(kindOf(name), "mouse", `${name} should map to mouse`);
  }
});

// -- synthetic `mounted` -----------------------------------------------------
//
// wit/world.wit (`handle-event`): `mounted` is SYNTHETIC — no such DOM event
// exists, so the host fires it itself, once per registration, with an
// `empty` payload.

Deno.test("mounted: registration synthesizes exactly one dispatch, no native listener", () => {
  const { document, root } = makeRoot();
  const { sink, calls } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);

  const el = document.createElement("div");
  root.appendChild(el);

  let nativeAdds = 0;
  const realAdd = el.addEventListener.bind(el);
  el.addEventListener = (...args: Parameters<typeof realAdd>) => {
    nativeAdds++;
    return realAdd(...args);
  };
  let rootAdds = 0;
  const realRootAdd = root.addEventListener.bind(root);
  root.addEventListener = (...args: Parameters<typeof realRootAdd>) => {
    rootAdds++;
    return realRootAdd(...args);
  };

  // event_bubbles("mounted") is false, so it arrives as a non-bubbling add.
  dispatcher.add(el, 7, 42, "mounted", false);

  assertEquals(nativeAdds, 0, "no native listener for a synthetic event");
  assertEquals(rootAdds, 0, "and none delegated at the root either");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].elementId, 7);
  assertEquals(calls[0].nameId, 42);
  assertEquals(calls[0].name, "mounted");
  assertEquals(serializePayload("mounted", { type: "mounted" }), { kind: "empty" });
});

Deno.test("mounted: fires once per registration, not again on later events", () => {
  const { document, root } = makeRoot();
  const { sink, calls } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);

  const el = document.createElement("button");
  root.appendChild(el);

  dispatcher.add(el, 1, 42, "mounted", false);
  assertEquals(calls.length, 1);

  // A real event on the same element dispatches on its own registration and
  // does not re-trigger `mounted`.
  dispatcher.add(el, 1, 10, "click", true);
  el.dispatchEvent(new document.defaultView!.Event("click", { bubbles: true }));
  assertEquals(calls.length, 2);
  assertEquals(calls[1].name, "click");

  // `mounted` is not a resolvable dispatch target: no native event carries
  // that name, and it is deliberately absent from #registrations.
  dispatcher.dispatchTo(el, "mounted", { type: "mounted" });
  assertEquals(calls.length, 2);

  // purge/dispose must not break on an element that registered `mounted`.
  dispatcher.purge(1, el);
  dispatcher.dispose();
  assertEquals(calls.length, 2);
});

// -- new families: image/composition/animation/transition/touch ------------

// dioxus-html-0.7.10 generated.rs Image(ImageData) events= list
// (generated.rs:108-113): `onerror => error, onload => load`. `load-error`
// has no field on the native event — it is derived from which of the two
// names fired.
Deno.test("serializePayload: image family — loadError true for error, false for load", () => {
  const errPayload = serializePayload("error", { type: "error" });
  assertEquals(errPayload, { kind: "image", value: { loadError: true } });

  const loadPayload = serializePayload("load", { type: "load" });
  assertEquals(loadPayload, { kind: "image", value: { loadError: false } });
});

Deno.test("serializePayload: composition family", () => {
  const payload = serializePayload("compositionupdate", {
    type: "compositionupdate",
    // deno-lint-ignore no-explicit-any
    data: "こ",
  } as any);
  assertEquals(payload, { kind: "composition", value: { data: "こ" } });
});

Deno.test("serializePayload: composition family defensive default when data missing", () => {
  const payload = serializePayload("compositionstart", { type: "compositionstart" });
  assertEquals(payload, { kind: "composition", value: { data: "" } });
});

Deno.test("serializePayload: animation family", () => {
  const payload = serializePayload("animationstart", {
    type: "animationstart",
    animationName: "fade",
    pseudoElement: "::before",
    elapsedTime: 1.5,
    // deno-lint-ignore no-explicit-any
  } as any);
  assertEquals(payload, {
    kind: "animation",
    value: { animationName: "fade", pseudoElement: "::before", elapsedTime: 1.5 },
  });
});

Deno.test("serializePayload: transition family", () => {
  const payload = serializePayload("transitionend", {
    type: "transitionend",
    propertyName: "opacity",
    pseudoElement: "",
    elapsedTime: 0.3,
    // deno-lint-ignore no-explicit-any
  } as any);
  assertEquals(payload, {
    kind: "transition",
    value: { propertyName: "opacity", pseudoElement: "", elapsedTime: 0.3 },
  });
});

// TouchEvent.touches/changedTouches/targetTouches are TouchList — an
// array-like (indexed + length, no array methods), not a real Array.
function fakeTouchList(points: Record<string, number>[]): ArrayLike<Record<string, number>> {
  const obj: Record<string | number, unknown> = { length: points.length };
  points.forEach((p, i) => (obj[i] = p));
  return obj as unknown as ArrayLike<Record<string, number>>;
}

Deno.test("serializePayload: touch family converts array-like TouchLists", () => {
  const touches = fakeTouchList([
    {
      identifier: 1,
      clientX: 10,
      clientY: 20,
      pageX: 11,
      pageY: 21,
      screenX: 12,
      screenY: 22,
      radiusX: 5,
      radiusY: 6,
      rotationAngle: 7,
      force: 0.5,
    },
  ]);
  const payload = serializePayload("touchstart", {
    type: "touchstart",
    touches,
    changedTouches: touches,
    targetTouches: fakeTouchList([]),
    ctrlKey: true,
  }) as { kind: string; value: Record<string, unknown> };
  assertEquals(payload.kind, "touch");
  assertEquals(payload.value.touches, [
    {
      identifier: 1,
      clientX: 10,
      clientY: 20,
      pageX: 11,
      pageY: 21,
      screenX: 12,
      screenY: 22,
      radiusX: 5,
      radiusY: 6,
      rotationAngle: 7,
      force: 0.5,
    },
  ]);
  assertEquals(payload.value.targetTouches, [], "empty TouchList converts to empty array");
  assertEquals(payload.value.mods, { ctrl: true });
});

Deno.test("serializePayload: touch family defensive defaults when touch lists are absent", () => {
  const payload = serializePayload("touchend", { type: "touchend" }) as {
    kind: string;
    value: Record<string, unknown>;
  };
  assertEquals(payload.value.touches, []);
  assertEquals(payload.value.changedTouches, []);
  assertEquals(payload.value.targetTouches, []);
});

// dioxus-html-0.7.10 generated.rs: `oninvalid => invalid` (Form(FormData)
// events= list, generated.rs:102) and the `doubleclick` raw alias
// (Mouse(MouseData), generated.rs:256) were both previously unmapped
// (fell through to `empty`).
Deno.test("serializePayload: invalid maps to form, doubleclick maps to mouse", () => {
  const kindOf = (name: string) => (serializePayload(name, { type: name }) as { kind: string }).kind;
  assertEquals(kindOf("invalid"), "form");
  assertEquals(kindOf("doubleclick"), "mouse");
});

Deno.test("mounted: each element gets its own single dispatch", () => {
  const { document, root } = makeRoot();
  const { sink, calls } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);

  const a = document.createElement("div");
  const b = document.createElement("div");
  root.appendChild(a);
  root.appendChild(b);

  dispatcher.add(a, 1, 42, "mounted", false);
  dispatcher.add(b, 2, 42, "mounted", false);

  assertEquals(calls.length, 2);
  assertEquals(calls.map((c) => c.elementId), [1, 2]);
});

// -- observer-backed `resize` / `visible` -------------------------------------
//
// Neither is a DOM event: dioxus-web synthesizes them from a ResizeObserver /
// IntersectionObserver (ref:core.ts:109-113). Both are non-bubbling
// (dioxus-core-types-0.7.10/src/bubbles.rs:87,102).

/** `ResizeObserverEntry.borderBoxSize`/`.contentBoxSize` are ARRAYS of
 * writing-mode-relative `{ blockSize, inlineSize }`. */
function boxSize(inlineSize: number, blockSize: number) {
  return [{ inlineSize, blockSize }];
}

Deno.test("serializePayload: resize family resolves inline/block in horizontal-tb", () => {
  const payload = serializePayload("resize", {
    type: "resize",
    borderBoxSize: boxSize(100, 50),
    contentBoxSize: boxSize(90, 40),
    // no getComputedStyle in linkedom -> defaults to horizontal-tb, where
    // inlineSize is the width.
  });
  assertEquals(payload, {
    kind: "resize",
    value: {
      borderBox: { width: 100, height: 50 },
      contentBox: { width: 90, height: 40 },
    },
  });
});

Deno.test("serializePayload: resize family swaps inline/block in a vertical writing mode", () => {
  const { document, root } = makeRoot();
  const el = document.createElement("div");
  root.appendChild(el);

  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const had = "getComputedStyle" in g;
  const prev = g.getComputedStyle;
  g.getComputedStyle = () => ({ writingMode: "vertical-rl" });
  try {
    const payload = serializePayload("resize", {
      type: "resize",
      target: el as unknown as EventTarget,
      borderBoxSize: boxSize(100, 50),
      contentBoxSize: boxSize(90, 40),
    });
    assertEquals(payload, {
      kind: "resize",
      value: {
        // vertical-rl: inlineSize runs down the page, so it is the HEIGHT.
        borderBox: { width: 50, height: 100 },
        contentBox: { width: 40, height: 90 },
      },
    });
  } finally {
    if (had) g.getComputedStyle = prev;
    else delete g.getComputedStyle;
  }
});

Deno.test("serializePayload: resize family falls back to contentRect when box arrays absent", () => {
  const payload = serializePayload("resize", {
    type: "resize",
    contentRect: { x: 0, y: 0, width: 12, height: 34 },
  });
  assertEquals(payload, {
    kind: "resize",
    value: {
      borderBox: { width: 12, height: 34 },
      contentBox: { width: 12, height: 34 },
    },
  });
});

Deno.test("serializePayload: resize family defensive defaults when the entry is empty", () => {
  assertEquals(serializePayload("resize", { type: "resize" }), {
    kind: "resize",
    value: { borderBox: { width: 0, height: 0 }, contentBox: { width: 0, height: 0 } },
  });
});

Deno.test("serializePayload: visible family maps entry fields across", () => {
  const payload = serializePayload("visible", {
    type: "visible",
    boundingClientRect: { x: 1, y: 2, width: 3, height: 4 },
    intersectionRatio: 0.5,
    intersectionRect: { x: 5, y: 6, width: 7, height: 8 },
    isIntersecting: true,
    rootBounds: { x: 9, y: 10, width: 11, height: 12 },
    time: 0,
  }) as { kind: string; value: Record<string, unknown> };
  assertEquals(payload.kind, "visible");
  assertEquals(payload.value.boundingClientRect, { x: 1, y: 2, width: 3, height: 4 });
  assertEquals(payload.value.intersectionRatio, 0.5);
  assertEquals(payload.value.intersectionRect, { x: 5, y: 6, width: 7, height: 8 });
  assertEquals(payload.value.isIntersecting, true);
  assertEquals(payload.value.rootBounds, { x: 9, y: 10, width: 11, height: 12 });
});

// `IntersectionObserverEntry.rootBounds` is null when the root is an
// implicit cross-origin viewport; wit `option<rect>` lowers as `undefined`.
Deno.test("serializePayload: visible family maps rootBounds null to undefined", () => {
  const payload = serializePayload("visible", {
    type: "visible",
    rootBounds: null,
  }) as { kind: string; value: Record<string, unknown> };
  assertEquals(payload.value.rootBounds, undefined);
  assertEquals("rootBounds" in payload.value, true, "field present, value undefined");
  // Defensive defaults for a partial entry, like every other family.
  assertEquals(payload.value.boundingClientRect, { x: 0, y: 0, width: 0, height: 0 });
  assertEquals(payload.value.isIntersecting, false);
});

// DELIBERATE DEVIATION from ref:serialize.ts:163 (`Date.now() + detail.time`):
// the guest reads time-ms as ms since the Unix epoch, and `entry.time` is
// measured from the page's TIME ORIGIN, so the correct sum is
// `performance.timeOrigin + entry.time`. Upstream's overshoots by uptime.
Deno.test("serializePayload: visible timeMs converts from the time origin, not Date.now", () => {
  const time = 1234.7;
  const payload = serializePayload("visible", { type: "visible", time }) as {
    value: { timeMs: bigint };
  };
  // A BigInt, not a number: wit `time-ms` is u64, and the component-model
  // binding rejects a JS number for a 64-bit integer at dispatch time
  // ("u64 expects a bigint"). Asserting the type here is what keeps this
  // suite honest — it synthesizes events and never crosses the real
  // boundary, so a plain number would pass this file and throw in a browser.
  assertEquals(typeof payload.value.timeMs, "bigint");
  assertEquals(payload.value.timeMs, BigInt(Math.floor(performance.timeOrigin + time)));
  // And it is NOT the upstream formula: Date.now() already includes the
  // page's uptime, so that sum lands a full uptime in the future.
  const upstream = BigInt(Math.floor(Date.now() + time));
  assertEquals(
    payload.value.timeMs < upstream,
    true,
    "time-origin conversion must not include the page uptime twice",
  );
});

Deno.test("resize/visible: registration degrades safely with no observers available", () => {
  const { document, root } = makeRoot();
  const { sink, calls } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);

  // linkedom provides neither constructor — the environment every host unit
  // test runs in.
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  assertEquals(typeof g.ResizeObserver, "undefined");
  assertEquals(typeof g.IntersectionObserver, "undefined");

  const el = document.createElement("div");
  root.appendChild(el);

  let nativeAdds = 0;
  const realAdd = el.addEventListener.bind(el);
  el.addEventListener = (...args: Parameters<typeof realAdd>) => {
    nativeAdds++;
    return realAdd(...args);
  };
  let rootAdds = 0;
  const realRootAdd = root.addEventListener.bind(root);
  root.addEventListener = (...args: Parameters<typeof realRootAdd>) => {
    rootAdds++;
    return realRootAdd(...args);
  };

  // event_bubbles is false for both, so they arrive as non-bubbling adds.
  dispatcher.add(el, 8, 50, "resize", false);
  dispatcher.add(el, 8, 51, "visible", false);

  assertEquals(nativeAdds, 0, "no native listener for an observer-backed name");
  assertEquals(rootAdds, 0, "and none delegated at the root either");
  assertEquals(calls, [], "nothing fires without an observer");
  assertEquals(el.getAttribute("data-dioxus-id"), "8");

  // Teardown paths must tolerate the degraded registration.
  dispatcher.remove(el, 8, 50, "resize", false);
  dispatcher.purge(8, el);
  dispatcher.dispose();
  assertEquals(calls, []);
});

// Observer stubs: linkedom has none, so the lifecycle tests below supply a
// minimal recording pair for the duration of the test.
function stubObservers() {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const log: string[] = [];
  const instances: { disconnected: boolean }[] = [];
  class Stub {
    disconnected = false;
    #kind: string;
    constructor(kind: string) {
      this.#kind = kind;
      instances.push(this);
    }
    observe(el: Element) {
      log.push(`${this.#kind}:observe:${el.getAttribute("data-dioxus-id")}`);
    }
    unobserve(el: Element) {
      log.push(`${this.#kind}:unobserve:${el.getAttribute("data-dioxus-id")}`);
    }
    disconnect() {
      this.disconnected = true;
      log.push(`${this.#kind}:disconnect`);
    }
  }
  g.ResizeObserver = class extends Stub {
    constructor() {
      super("resize");
    }
  };
  g.IntersectionObserver = class extends Stub {
    constructor() {
      super("visible");
    }
  };
  return {
    log,
    instances,
    restore() {
      delete g.ResizeObserver;
      delete g.IntersectionObserver;
    },
  };
}

Deno.test("resize/visible: one shared observer each, observed per element", () => {
  const { document, root } = makeRoot();
  const { sink } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);
  const { log, instances, restore } = stubObservers();
  try {
    const a = document.createElement("div");
    const b = document.createElement("div");
    root.appendChild(a);
    root.appendChild(b);

    dispatcher.add(a, 1, 50, "resize", false);
    dispatcher.add(b, 2, 50, "resize", false);
    dispatcher.add(a, 1, 51, "visible", false);

    assertEquals(log, ["resize:observe:1", "resize:observe:2", "visible:observe:1"]);
    assertEquals(instances.length, 2, "one ResizeObserver + one IntersectionObserver, shared");

    dispatcher.remove(a, 1, 50, "resize", false);
    assertEquals(log.at(-1), "resize:unobserve:1");
  } finally {
    restore();
  }
});

// The highest-risk path: ElementIds are reused slab indices and the guest
// never emits remove-event-listener for unmounted subtrees, so a missed
// unobserve leaves a live observation on a detached node.
Deno.test("resize/visible: purge unobserves every observed name for the id", () => {
  const { document, root } = makeRoot();
  const { sink, calls } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);
  const { log, restore } = stubObservers();
  try {
    const el = document.createElement("div");
    root.appendChild(el);
    dispatcher.add(el, 4, 50, "resize", false);
    dispatcher.add(el, 4, 51, "visible", false);
    log.length = 0;

    dispatcher.purge(4, el);
    assertEquals(log.sort(), ["resize:unobserve:4", "visible:unobserve:4"]);
    assertEquals(el.hasAttribute("data-dioxus-id"), false);

    // And the registration is gone, so even a late observation for a
    // reused id resolves to nothing.
    dispatcher.dispatchTo(el, "resize", { type: "resize" });
    assertEquals(calls, []);
  } finally {
    restore();
  }
});

Deno.test("resize/visible: dispose disconnects both observers", () => {
  const { document, root } = makeRoot();
  const { sink } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);
  const { log, instances, restore } = stubObservers();
  try {
    const el = document.createElement("div");
    root.appendChild(el);
    dispatcher.add(el, 1, 50, "resize", false);
    dispatcher.add(el, 1, 51, "visible", false);
    log.length = 0;

    dispatcher.dispose();
    assertEquals(log.sort(), ["resize:disconnect", "visible:disconnect"]);
    assertEquals(instances.every((i) => i.disconnected), true, "no observation survives dispose");
  } finally {
    restore();
  }
});

// The observer callback resolves through #registrations, so an observation
// is only ever delivered to a live registration.
Deno.test("resize: observer callback dispatches through the sink with the entry payload", () => {
  const { document, root } = makeRoot();
  const { sink, calls } = recordingSink();
  const dispatcher = new EventDispatcher(root, sink);

  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  let fire: ((entries: unknown[]) => void) | undefined;
  g.ResizeObserver = class {
    constructor(cb: (entries: unknown[]) => void) {
      fire = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  try {
    const el = document.createElement("div");
    root.appendChild(el);
    dispatcher.add(el, 6, 50, "resize", false);

    const entry = {
      target: el,
      borderBoxSize: boxSize(100, 50),
      contentBoxSize: boxSize(90, 40),
      contentRect: { x: 0, y: 0, width: 90, height: 40 },
    };
    fire!([entry]);

    assertEquals(calls.length, 1);
    assertEquals(calls[0].elementId, 6);
    assertEquals(calls[0].nameId, 50);
    assertEquals(calls[0].name, "resize");
    assertEquals(serializePayload("resize", calls[0].ev as never), {
      kind: "resize",
      value: { borderBox: { width: 100, height: 50 }, contentBox: { width: 90, height: 40 } },
    });

    // After purge the same observation resolves to nothing (no dispatch
    // into a dead/reused ElementId).
    dispatcher.purge(6, el);
    fire!([entry]);
    assertEquals(calls.length, 1);
  } finally {
    delete g.ResizeObserver;
  }
});
