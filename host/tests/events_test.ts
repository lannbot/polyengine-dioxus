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
  assertEquals(serializePayload("resize", { type: "resize" }), { kind: "empty" });
  assertEquals(serializePayload("visible", { type: "visible" }), { kind: "empty" });
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
