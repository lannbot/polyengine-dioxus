// DOM event delegation + payload serialization for polymorph:dioxus.
//
// Delegation model ported from dioxus-web's own interpreter (dioxus-core
// 0.7's web bindings — Apache-2.0/MIT dual licensed upstream:
// https://github.com/DioxusLabs/dioxus, `packages/web/src/js/core.ts`,
// vendored here for reference as /tmp/opencode/dioxus-ref/core.ts at
// authoring time). Cited inline as `ref:core.ts:<line>`.
//
// Payload shapes follow contracts/embedder-api.md "Value mapping": variant
// -> `{ kind }` / `{ kind, value }`; record fields kebab-case -> camelCase;
// flags -> object of booleans (absent = false is accepted on lower, so we
// omit false-valued flags — contract "flags" row, lower direction).

import type { ListenerDelegate } from "./applier.ts";

/** Minimal native-event surface we depend on; duck-typeable in tests. */
export interface NativeEventLike {
  type: string;
  target?: EventTarget | null;
  currentTarget?: EventTarget | null;
  preventDefault?(): void;
  stopPropagation?(): void;
  // mouse/pointer
  clientX?: number;
  clientY?: number;
  pageX?: number;
  pageY?: number;
  screenX?: number;
  screenY?: number;
  offsetX?: number;
  offsetY?: number;
  button?: number;
  buttons?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  // pointer-specific
  pointerId?: number;
  width?: number;
  height?: number;
  pressure?: number;
  tangentialPressure?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  pointerType?: string;
  isPrimary?: boolean;
  // keyboard
  key?: string;
  code?: string;
  location?: number;
  repeat?: boolean;
  isComposing?: boolean;
  // wheel
  deltaX?: number;
  deltaY?: number;
  deltaZ?: number;
  deltaMode?: number;
  // form
  value?: string;
  checked?: boolean;
  // scroll (read off currentTarget/target normally; see #scrollData)
}

// -- event name -> payload family --------------------------------------------

const MOUSE_EVENTS = new Set([
  "click",
  "dblclick",
  "contextmenu",
  "mousedown",
  "mouseup",
  "mousemove",
  "mouseenter",
  "mouseleave",
  "mouseover",
  "mouseout",
]);

const KEYBOARD_EVENTS = new Set(["keydown", "keyup", "keypress"]);
// dioxus-html-0.7.10 generated.rs Form(FormData) events= list includes
// `onreset => reset` alongside input/change/submit.
const FORM_EVENTS = new Set(["input", "change", "submit", "reset"]);
// dioxus-html-0.7.10 generated.rs Scroll(ScrollData) events= list includes
// `onscrollend => scrollend` alongside scroll.
const SCROLL_EVENTS = new Set(["scroll", "scrollend"]);

// dioxus-html-0.7.10 generated.rs Pointer(PointerData) events= list includes
// gotpointercapture, lostpointercapture, and (per this version) auxclick —
// CONTRACT: the dispatch that scoped this fix said auxclick maps to the
// mouse family, but the vendored authority
// (~/.cargo/registry/.../dioxus-html-0.7.10/src/events/generated.rs:271,
// inside the `Pointer(PointerData)` block, not `Mouse(MouseData)`) lists
// `onauxclick => auxclick` under Pointer. Following the authority file over
// the dispatch summary per the conservative-reading rule; flagged in the
// final report.
const EXTRA_POINTER_EVENTS = new Set([
  "gotpointercapture",
  "lostpointercapture",
  "auxclick",
]);

function isPointerEvent(name: string): boolean {
  return name.startsWith("pointer") || EXTRA_POINTER_EVENTS.has(name);
}

function num(v: number | undefined, fallback = 0): number {
  return typeof v === "number" ? v : fallback;
}
function str(v: string | undefined, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function bool(v: boolean | undefined): boolean {
  return v === true;
}

/** wit events.modifiers: flags { alt, ctrl, meta, shift }. Absent = false is
 * legal on lower (embedder-api.md Value mapping "flags" row), so we omit
 * false-valued keys. */
function mods(ev: NativeEventLike): Record<string, boolean> {
  const m: Record<string, boolean> = {};
  if (bool(ev.altKey)) m.alt = true;
  if (bool(ev.ctrlKey)) m.ctrl = true;
  if (bool(ev.metaKey)) m.meta = true;
  if (bool(ev.shiftKey)) m.shift = true;
  return m;
}

function mouseData(ev: NativeEventLike) {
  return {
    clientX: num(ev.clientX),
    clientY: num(ev.clientY),
    pageX: num(ev.pageX),
    pageY: num(ev.pageY),
    screenX: num(ev.screenX),
    screenY: num(ev.screenY),
    offsetX: num(ev.offsetX),
    offsetY: num(ev.offsetY),
    button: num(ev.button, -1),
    buttons: num(ev.buttons),
    mods: mods(ev),
  };
}

function pointerData(ev: NativeEventLike) {
  return {
    mouse: mouseData(ev),
    pointerId: num(ev.pointerId),
    width: num(ev.width),
    height: num(ev.height),
    pressure: num(ev.pressure),
    tangentialPressure: num(ev.tangentialPressure),
    tiltX: num(ev.tiltX),
    tiltY: num(ev.tiltY),
    twist: num(ev.twist),
    pointerType: str(ev.pointerType),
    isPrimary: bool(ev.isPrimary),
  };
}

function keyboardData(ev: NativeEventLike) {
  return {
    key: str(ev.key),
    code: str(ev.code),
    location: num(ev.location),
    repeat: bool(ev.repeat),
    isComposing: bool(ev.isComposing),
    mods: mods(ev),
  };
}

function wheelData(ev: NativeEventLike) {
  return {
    mouse: mouseData(ev),
    deltaX: num(ev.deltaX),
    deltaY: num(ev.deltaY),
    deltaZ: num(ev.deltaZ),
    deltaMode: num(ev.deltaMode),
  };
}

/** Collect FormData-shaped entries for a submit-like target. Faithful when
 * the target is a real `<form>` (or linkedom's faithful-enough analogue);
 * defensively degrades to an empty list otherwise (see events_test.ts for
 * noted fidelity gaps). */
function formValues(target: EventTarget | null | undefined): [string, string[]][] {
  const el = target as unknown as { tagName?: string; elements?: ArrayLike<unknown> } | null;
  if (!el || el.tagName !== "FORM" || !el.elements) return [];
  const byName = new Map<string, string[]>();
  for (const raw of Array.from(el.elements)) {
    const ctrl = raw as {
      name?: string;
      type?: string;
      value?: string;
      checked?: boolean;
      disabled?: boolean;
    };
    if (!ctrl.name || ctrl.disabled) continue;
    if ((ctrl.type === "checkbox" || ctrl.type === "radio") && !ctrl.checked) continue;
    const list = byName.get(ctrl.name) ?? [];
    list.push(ctrl.value ?? "");
    byName.set(ctrl.name, list);
  }
  return Array.from(byName.entries());
}

function formData(name: string, ev: NativeEventLike) {
  // CONTRACT (browser-compat fix, flagged in the E2E track report): prefer
  // `target` over `currentTarget`. Native DOM semantics: `target` is the
  // element the event actually originated on and stays fixed throughout
  // bubbling; `currentTarget` is whichever element the *currently
  // executing* listener happens to be attached to — for our delegated
  // model (EventDispatcher.add: bubbling listeners are attached to
  // `root`, not to the control itself — host/src/events.ts "add()"), that
  // means `currentTarget` is the delegation ROOT, not the input/select/
  // form control whose `.value`/`.checked` we need. Every existing test
  // (host/tests/counter_test.ts, events_test.ts) synthesizes bare
  // `{type, value}` events with neither field set, so it never exercised
  // this path — real Chromium's native bubbling delegation is what
  // exposed it (e2e/tests/counter.spec.ts's real-keyboard-typing
  // assertion silently got value="" via `currentTarget` = the root div,
  // which has no `.value`). `formValues` below already had the correct
  // target-first order; this brings the sibling `target` const in line
  // with it.
  const target = (ev.target ?? ev.currentTarget) as
    | (EventTarget & { value?: string; checked?: boolean; type?: string })
    | null
    | undefined;
  const checked = typeof (ev.checked ?? target?.checked) === "boolean"
    ? (ev.checked ?? target?.checked)
    : undefined;
  // A checkbox encodes its checked state AS the value, matching dioxus-web's
  // own serializer (ref:serialize.ts:185): dioxus 0.7's FormData::checked()
  // is derived guest-side from value.parse::<bool>() (dioxus-html/src/events/
  // form.rs:39) and has no hook for the typed `checked` field. Keyed on the
  // control TYPE, not on `checked`'s presence — every HTMLInputElement
  // exposes `.checked` (default false), and a text input's real value must
  // never be clobbered. The typed `checked` field stays as the truthful
  // snapshot for non-dioxus consumers of the payload.
  const value = target?.type === "checkbox"
    ? String(checked ?? false)
    : str(ev.value ?? target?.value);
  const values = name === "submit" ? formValues(ev.target ?? ev.currentTarget) : [];
  return { value, checked, values };
}

function scrollData(ev: NativeEventLike) {
  // Same target-vs-currentTarget fix as formData above: scroll doesn't
  // bubble (so today `add()` attaches its listener directly to the
  // element in question and `target`/`currentTarget` coincide in
  // practice) but preferring `target` keeps this consistent with
  // formData's now-corrected precedence rather than leaving a footgun
  // for any future non-bubbling-assumption change.
  const t = (ev.target ?? ev.currentTarget) as
    | {
      scrollTop?: number;
      scrollLeft?: number;
      scrollWidth?: number;
      scrollHeight?: number;
      clientWidth?: number;
      clientHeight?: number;
    }
    | null
    | undefined;
  return {
    scrollTop: num(t?.scrollTop),
    scrollLeft: num(t?.scrollLeft),
    scrollWidth: num(t?.scrollWidth),
    scrollHeight: num(t?.scrollHeight),
    clientWidth: num(t?.clientWidth),
    clientHeight: num(t?.clientHeight),
  };
}

/** Serialize a native event into the wit `events.payload` value shape
 * (contracts/embedder-api.md "Value mapping": variant -> `{ kind, value }`).
 * Family chosen by event name, mirroring dioxus-html's name->data-type
 * mapping (per the dispatch's family list). */
export function serializePayload(name: string, ev: NativeEventLike): unknown {
  if (isPointerEvent(name)) return { kind: "pointer", value: pointerData(ev) };
  if (MOUSE_EVENTS.has(name)) return { kind: "mouse", value: mouseData(ev) };
  if (KEYBOARD_EVENTS.has(name)) return { kind: "keyboard", value: keyboardData(ev) };
  if (name === "wheel") return { kind: "wheel", value: wheelData(ev) };
  if (FORM_EVENTS.has(name)) return { kind: "form", value: formData(name, ev) };
  if (SCROLL_EVENTS.has(name)) return { kind: "scroll", value: scrollData(ev) };
  return { kind: "empty" };
}

// -- delegation ---------------------------------------------------------------

/** Attribute dioxus-web uses to mark elements resolvable from a dispatched
 * native event back to their guest ElementId (ref:core.ts:48,124). */
const DIOXUS_ID_ATTR = "data-dioxus-id";

interface Registration {
  bubbles: boolean;
  /** The interned string id this listener was registered with
   * (decoder.ts's StrRef) — wit/world.wit: "Event names cross back on
   * handle-event as the same interned u16", so dispatch hands this same
   * id back rather than re-deriving it from the applier's string table
   * (applier.ts is consumed unchanged; this keeps the mapping local). */
  nameId: number;
}

/**
 * Invoked once target resolution succeeds; wired to host.ts's dispatch
 * path (which in turn calls the guest's `handle-event` export). Carries
 * both the interned `nameId` (the wire id `handle-event` expects) and the
 * plain `name` (for payload-family selection).
 */
export type DispatchSink = (
  elementId: number,
  nameId: number,
  name: string,
  ev: NativeEventLike,
) => void;

/**
 * Delegation + registration bookkeeping (ref:core.ts `createListener`/
 * `removeListener`/`removeNonBubblingListener`, ported to TS `Element`
 * rather than `HTMLElement` so linkedom and SVG both work).
 *
 * Bubbling events: one root listener per event name, refcounted across
 * every element that registers for it (ref:core.ts:116-122).
 * Non-bubbling events: one listener per (element, name) pair
 * (ref:core.ts:123-129).
 */
export class EventDispatcher implements ListenerDelegate {
  #root: Element;
  #sink: DispatchSink;
  // event name -> { active count, shared listener } (bubbling)
  #global = new Map<string, { active: number; listener: (e: Event) => void }>();
  // elementId -> event name -> per-element listener (non-bubbling)
  #local = new Map<number, Map<string, (e: Event) => void>>();
  // elementId -> event name -> bubbles, for target-resolution's
  // "has a registration for that event name" check.
  #registrations = new Map<number, Map<string, Registration>>();

  constructor(root: Element, sink: DispatchSink) {
    this.#root = root;
    this.#sink = sink;
  }

  add(el: Element, elementId: number, nameId: number, name: string, bubbles: boolean): void {
    el.setAttribute(DIOXUS_ID_ATTR, String(elementId));

    let byName = this.#registrations.get(elementId);
    if (!byName) {
      byName = new Map();
      this.#registrations.set(elementId, byName);
    }
    byName.set(name, { bubbles, nameId });

    if (bubbles) {
      let entry = this.#global.get(name);
      if (!entry) {
        const listener = (e: Event) => this.#handle(name, e);
        entry = { active: 1, listener };
        this.#global.set(name, entry);
        this.#root.addEventListener(name, listener);
      } else {
        entry.active++;
      }
    } else {
      let byNameLocal = this.#local.get(elementId);
      if (!byNameLocal) {
        byNameLocal = new Map();
        this.#local.set(elementId, byNameLocal);
      }
      const listener = (e: Event) => this.#handle(name, e);
      byNameLocal.set(name, listener);
      el.addEventListener(name, listener);
    }
  }

  remove(el: Element, elementId: number, nameId: number, name: string, bubbles: boolean): void {
    void nameId; // symmetry with add(); removal keys off (elementId, name)
    const byName = this.#registrations.get(elementId);
    byName?.delete(name);
    if (byName && byName.size === 0) {
      this.#registrations.delete(elementId);
    }

    if (bubbles) {
      const entry = this.#global.get(name);
      if (entry) {
        entry.active--;
        if (entry.active <= 0) {
          this.#root.removeEventListener(name, entry.listener);
          this.#global.delete(name);
        }
      }
    } else {
      const byNameLocal = this.#local.get(elementId);
      const listener = byNameLocal?.get(name);
      if (listener) {
        el.removeEventListener(name, listener);
        byNameLocal!.delete(name);
        if (byNameLocal!.size === 0) this.#local.delete(elementId);
      }
    }

    if (!this.#registrations.has(elementId)) {
      el.removeAttribute(DIOXUS_ID_ATTR);
    }
  }

  /** Resolve the target elementId for a dispatched native event: walk
   * `event.target` upward to the first element carrying a `data-dioxus-id`
   * attribute AND a live registration for `name` (dispatch prompt's
   * resolution rule), then invoke the sink. Testable directly without real
   * DOM event plumbing. */
  dispatchTo(targetEl: Element | null, name: string, nativeEventLike: NativeEventLike): void {
    let el: Element | null = targetEl;
    while (el) {
      const idAttr = el.getAttribute(DIOXUS_ID_ATTR);
      if (idAttr !== null) {
        const elementId = Number(idAttr);
        const reg = this.#registrations.get(elementId)?.get(name);
        if (reg) {
          this.#sink(elementId, reg.nameId, name, nativeEventLike);
          return;
        }
      }
      el = el.parentElement;
    }
  }

  #handle(name: string, e: Event): void {
    const target = (e.target ?? null) as Element | null;
    this.dispatchTo(target, name, e as unknown as NativeEventLike);
  }
}
