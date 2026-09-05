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

import { ComponentException } from "@deltic/protocol";

import type { ListenerDelegate } from "./applier.ts";

/** Duck type for a native `File` — linkedom (the host unit-test DOM) has no
 * `File`/`Blob`, so tests fake this shape. `stream`/`arrayBuffer` are both
 * optional: `HostFile.read()` prefers `stream()` and falls back to
 * `arrayBuffer()` (see its doc comment for which shape the runtime
 * actually accepted end-to-end). */
export interface FileLike {
  name: string;
  size: number;
  lastModified: number;
  type: string;
  stream?(): ReadableStream<Uint8Array>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

/** Host-implemented `events.file` resource (contracts/embedder-api.md
 * "Resources": "the host provides a plain class implementing the
 * bindgen-emitted interface"). One instance per selected/dropped file;
 * constructed at payload-capture time (`formData`/the drag family below),
 * before the event is queued. */
export class HostFile {
  #file: FileLike;

  constructor(file: FileLike) {
    this.#file = file;
  }

  name(): string {
    return this.#file.name;
  }

  /** wit `size: func() -> u64` — lowers as `bigint` (contract "Value
   * mapping", `u64` row). */
  size(): bigint {
    return BigInt(this.#file.size);
  }

  /** wit `last-modified: func() -> u64` (`File.lastModified`, ms since the
   * Unix epoch) — same bigint requirement as `size`. */
  lastModified(): bigint {
    return BigInt(this.#file.lastModified);
  }

  /** `none` when the browser reports "" (wit doc: "`none` when it reports
   * ""). */
  contentType(): string | undefined {
    return this.#file.type === "" ? undefined : this.#file.type;
  }

  /** wit `read: func() -> stream<u8>`. Contract "Lowering accepts the
   * natural JS producers": a `ReadableStream` is one of the accepted
   * shapes, so `File.stream()` is passed straight through when available;
   * an `AsyncIterable` built from `arrayBuffer()` is the fallback for a
   * `FileLike` that only implements that (verified end-to-end against the
   * runtime — see the track report for which shape actually worked). */
  read(): ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> {
    if (typeof this.#file.stream === "function") return this.#file.stream();
    const arrayBuffer = this.#file.arrayBuffer?.bind(this.#file);
    if (!arrayBuffer) {
      // Neither producer available: an empty read rather than a throw —
      // consistent with every other family's defensive-degrade convention
      // in this file.
      return (async function* () {})();
    }
    return (async function* () {
      const buf = await arrayBuffer();
      yield new Uint8Array(buf);
    })();
  }
}

/** Duck type for a native `DataTransfer` — linkedom has no drag/drop
 * support at all, so tests fake this shape. Mirrors dioxus-web's own
 * `NativeDataTransfer` (dioxus-html-0.7.10 src/data_transfer.rs) closely
 * enough that a real `DataTransfer` satisfies it as-is. */
export interface DataTransferLike {
  getData(format: string): string;
  setData(format: string, data: string): void;
  clearData(format?: string): void;
  effectAllowed: string;
  dropEffect: string;
  files?: ArrayLike<FileLike>;
}

/** Host-implemented `events.data-transfer` resource. One instance per drag
 * event that has a `dataTransfer` (wit `drag-data.transfer`: `option<own<
 * data-transfer>>`, `none` for a synthetic event with none). */
export class HostDataTransfer {
  #dt: DataTransferLike;

  constructor(dt: DataTransferLike) {
    this.#dt = dt;
  }

  /** wit doc: "`none` for an absent format (or protected mode)". The DOM's
   * `getData` returns `""` for BOTH an absent format and an empty stored
   * value — dioxus-web's own `get_data` returns `Some("")` in both cases
   * (dioxus-html-0.7.10 src/data_transfer.rs:28 has no absent-vs-empty
   * distinction either), so this mirrors that rather than inventing one:
   * only a thrown DOM access (protected-mode-style refusal) becomes
   * `undefined`. */
  getData(format: string): string | undefined {
    try {
      return this.#dt.getData(format);
    } catch {
      return undefined;
    }
  }

  /** wit `result<_, string>` — err becomes a branded throw (contract
   * "Error model": "Host import with `result<T, E>`: … `throw`s `new
   * ComponentException(payload)` for err"). */
  setData(format: string, data: string): void {
    try {
      this.#dt.setData(format, data);
    } catch (e) {
      throw new ComponentException(String(e));
    }
  }

  clearData(format?: string): void {
    try {
      this.#dt.clearData(format);
    } catch (e) {
      throw new ComponentException(String(e));
    }
  }

  effectAllowed(): string {
    return this.#dt.effectAllowed;
  }

  setEffectAllowed(effect: string): void {
    this.#dt.effectAllowed = effect;
  }

  dropEffect(): string {
    return this.#dt.dropEffect;
  }

  setDropEffect(effect: string): void {
    this.#dt.dropEffect = effect;
  }

  files(): HostFile[] {
    return Array.from(this.#dt.files ?? [], (f) => new HostFile(f));
  }
}

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
  // drag (DragEvent.dataTransfer — absent for a synthetic event)
  dataTransfer?: DataTransferLike;
  // scroll (read off currentTarget/target normally; see #scrollData)
  // composition (CompositionEvent.data)
  data?: string;
  // animation / transition — `pseudoElement` and `elapsedTime` are common to
  // both; the name field differs (AnimationEvent.animationName vs
  // TransitionEvent.propertyName).
  animationName?: string;
  propertyName?: string;
  pseudoElement?: string;
  elapsedTime?: number;
  // touch (TouchEvent.touches/changedTouches/targetTouches are TouchList,
  // an array-like — see #touchList)
  touches?: ArrayLike<TouchPointLike>;
  changedTouches?: ArrayLike<TouchPointLike>;
  targetTouches?: ArrayLike<TouchPointLike>;
  // resize (ResizeObserverEntry fields, carried verbatim onto the
  // event-like the observer feeds the sink — same treatment as the touch
  // lists above: the entry's own field names, duck-typed).
  borderBoxSize?: ArrayLike<ResizeObserverSizeLike>;
  contentBoxSize?: ArrayLike<ResizeObserverSizeLike>;
  contentRect?: RectLike;
  // visible (IntersectionObserverEntry fields)
  boundingClientRect?: RectLike;
  intersectionRatio?: number;
  intersectionRect?: RectLike;
  isIntersecting?: boolean;
  rootBounds?: RectLike | null;
  /** DOMHighResTimeStamp, relative to the page's time origin. */
  time?: number;
}

/** Duck-typed `ResizeObserverSize` — WRITING-MODE RELATIVE dimensions. */
interface ResizeObserverSizeLike {
  blockSize?: number;
  inlineSize?: number;
}

/** Duck-typed `DOMRectReadOnly` (the wit `rect` fields we consume). */
interface RectLike {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** Duck-typed `Touch` (per-point fields of a TouchList entry). */
interface TouchPointLike {
  identifier?: number;
  clientX?: number;
  clientY?: number;
  pageX?: number;
  pageY?: number;
  screenX?: number;
  screenY?: number;
  radiusX?: number;
  radiusY?: number;
  rotationAngle?: number;
  force?: number;
}

// -- event name -> payload family --------------------------------------------

// dioxus-html-0.7.10 generated.rs Mouse(MouseData) events= list
// (generated.rs:216-257) plus its `#[raw = [doubleclick]]` alias
// (generated.rs:256): the raw name `doubleclick` (distinct from the
// `ondoubleclick => dblclick` events-list mapping already covered by
// `dblclick` below) also routes to the mouse family.
const MOUSE_EVENTS = new Set([
  "click",
  "dblclick",
  "doubleclick",
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
// dioxus-html-0.7.10 generated.rs Form(FormData) events= list
// (generated.rs:61-106) includes `onreset => reset` and
// `oninvalid => invalid` alongside input/change/submit.
const FORM_EVENTS = new Set(["input", "change", "submit", "reset", "invalid"]);
// dioxus-html-0.7.10 generated.rs Scroll(ScrollData) events= list includes
// `onscrollend => scrollend` alongside scroll.
const SCROLL_EVENTS = new Set(["scroll", "scrollend"]);

// dioxus-html-0.7.10 generated.rs Image(ImageData) events= list
// (generated.rs:108-113): `onerror => error, onload => load`. Bare names,
// no prefix relation to any Media name (Media's names are all distinct
// strings — `error`/`load` are not substrings of any Media name and vice
// versa) and not otherwise claimed by MOUSE_EVENTS/isPointerEvent/
// KEYBOARD_EVENTS/FORM_EVENTS/SCROLL_EVENTS/DRAG_EVENTS above. See
// collision analysis in the final report.
const IMAGE_EVENTS = new Set(["error", "load"]);

// dioxus-html-0.7.10 generated.rs Composition(CompositionData) events= list
// (generated.rs:31-37).
const COMPOSITION_EVENTS = new Set([
  "compositionstart",
  "compositionend",
  "compositionupdate",
]);

// dioxus-html-0.7.10 generated.rs Animation(AnimationData) events= list
// (generated.rs:9-15).
const ANIMATION_EVENTS = new Set([
  "animationstart",
  "animationend",
  "animationiteration",
]);

// dioxus-html-0.7.10 generated.rs Transition(TransitionData) events= list
// (generated.rs:313-317).
const TRANSITION_EVENTS = new Set(["transitionend"]);

// dioxus-html-0.7.10 generated.rs Touch(TouchData) events= list
// (generated.rs:304-311).
const TOUCH_EVENTS = new Set([
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
]);

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

// dioxus-html-0.7.10 generated.rs Drag(DragData) events= list (the
// `#[convert = convert_drag_data]` block at generated.rs:39-50, immediately
// above `Focus(FocusData)`). DragData implements HasMouseData (dioxus-html
// src/events/drag.rs) plus HasDragData (data_transfer), so these route to
// the dedicated `drag` payload (wit/world.wit `drag-data { mouse,
// transfer }`) — wit/world.wit:160-167 and src/events.rs's `Drag`
// adapter are the guest-side half of this; DRAG_EVENTS previously routed to
// `mouse` before `drag-data`/`data-transfer` existed (see wit/world.wit:161
// doc comment). None of these names collide with `isPointerEvent`'s
// `pointer`-prefix test or with MOUSE_EVENTS/EXTRA_POINTER_EVENTS above (in
// particular, `drop` does not start with "drag" and isn't a pointer/mouse
// event name already claimed elsewhere).
const DRAG_EVENTS = new Set([
  "drag",
  "dragend",
  "dragenter",
  "dragexit",
  "dragleave",
  "dragover",
  "dragstart",
  "drop",
]);

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

function dragData(ev: NativeEventLike) {
  return {
    mouse: mouseData(ev),
    // wit `option<own<data-transfer>>` -> `HostDataTransfer | undefined`;
    // `none` when the event has no `dataTransfer` (a synthetic event).
    // Instance created here, at capture time, mirroring `formData`'s files.
    transfer: ev.dataTransfer ? new HostDataTransfer(ev.dataTransfer) : undefined,
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
    | (EventTarget & {
      value?: string;
      checked?: boolean;
      type?: string;
      files?: ArrayLike<FileLike>;
    })
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
  // wit form-data.files: list<own<file>>, the control's selected files
  // (`<input type=file>`), empty otherwise. Instances are created HERE, at
  // capture time — before the event is queued (dispatch gate) — same
  // rationale as the drag family's `HostDataTransfer` below.
  const files = Array.from(target?.files ?? [], (f) => new HostFile(f));
  return { value, checked, values, files };
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

/** Image family: `load-error` is derived from the event NAME (`error` vs
 * `load`), not from any field on ImageData — dioxus-html-0.7.10 has no
 * accessor that reads it off the DOM event itself. Precedent for a
 * name-dependent builder: `formData(name, ev)` above. */
function imageData(name: string): { loadError: boolean } {
  return { loadError: name === "error" };
}

function compositionData(ev: NativeEventLike) {
  return { data: str(ev.data) };
}

function animationData(ev: NativeEventLike) {
  return {
    animationName: str(ev.animationName),
    pseudoElement: str(ev.pseudoElement),
    elapsedTime: num(ev.elapsedTime),
  };
}

function transitionData(ev: NativeEventLike) {
  return {
    propertyName: str(ev.propertyName),
    pseudoElement: str(ev.pseudoElement),
    elapsedTime: num(ev.elapsedTime),
  };
}

/** `TouchEvent.touches`/`.changedTouches`/`.targetTouches` are `TouchList`,
 * an array-LIKE (indexed + `.length`, no array methods) — convert to a
 * plain array of wit touch-point records, defensively degrading through
 * num()/str()/bool() exactly like every other family so a synthesized
 * partial (or absent) list never throws. */
function touchList(list: ArrayLike<TouchPointLike> | undefined) {
  if (!list) return [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i] ?? {};
    out.push({
      identifier: num(t.identifier),
      clientX: num(t.clientX),
      clientY: num(t.clientY),
      pageX: num(t.pageX),
      pageY: num(t.pageY),
      screenX: num(t.screenX),
      screenY: num(t.screenY),
      radiusX: num(t.radiusX),
      radiusY: num(t.radiusY),
      rotationAngle: num(t.rotationAngle),
      force: num(t.force),
    });
  }
  return out;
}

function touchData(ev: NativeEventLike) {
  return {
    touches: touchList(ev.touches),
    changedTouches: touchList(ev.changedTouches),
    targetTouches: touchList(ev.targetTouches),
    mods: mods(ev),
  };
}

/** wit events.size { width, height } from a writing-mode-relative
 * `ResizeObserverSize`. `inlineSize`/`blockSize` are along the writing
 * direction, so they map to width/height only in a horizontal writing mode
 * and SWAP otherwise (ref:serialize.ts:113-119). */
function sizeFromBox(box: ResizeObserverSizeLike | undefined, inlineIsWidth: boolean) {
  const inline = num(box?.inlineSize);
  const block = num(box?.blockSize);
  return inlineIsWidth
    ? { width: inline, height: block }
    : { width: block, height: inline };
}

function sizeFromRect(r: RectLike | undefined) {
  return { width: num(r?.width), height: num(r?.height) };
}

/** wit events.rect { x, y, width, height } from a DOMRect-like. */
function rectData(r: RectLike | undefined) {
  return { x: num(r?.x), y: num(r?.y), width: num(r?.width), height: num(r?.height) };
}

function resizeData(ev: NativeEventLike) {
  // ref:serialize.ts:122-133: the writing mode of the OBSERVED element
  // decides whether inlineSize is the width. Default `true`
  // (`horizontal-tb`) when we cannot ask — upstream defaults the same way
  // for a non-HTMLElement target. `getComputedStyle` is guarded because
  // linkedom (host unit tests) does not provide it.
  let inlineIsWidth = true;
  const gcs = (globalThis as { getComputedStyle?: (e: Element) => { writingMode?: string } })
    .getComputedStyle;
  const target = ev.target as Element | null | undefined;
  if (typeof gcs === "function" && target) {
    const wm = gcs(target)?.writingMode;
    if (typeof wm === "string" && wm !== "" && wm !== "horizontal-tb") inlineIsWidth = false;
  }
  // ref:serialize.ts:135-147: fall back to `contentRect` when either
  // box-size array is absent (the arrays are the newer API).
  const border = ev.borderBoxSize?.[0];
  const content = ev.contentBoxSize?.[0];
  return {
    borderBox: ev.borderBoxSize ? sizeFromBox(border, inlineIsWidth) : sizeFromRect(ev.contentRect),
    contentBox: ev.contentBoxSize
      ? sizeFromBox(content, inlineIsWidth)
      : sizeFromRect(ev.contentRect),
  };
}

function visibleData(ev: NativeEventLike) {
  // DELIBERATE DEVIATION FROM ref:serialize.ts:163, which sends
  // `Math.floor(Date.now() + detail.time)`. The guest reads this field as
  // `UNIX_EPOCH + Duration::from_millis(time_ms)` (dioxus-html-0.7.10
  // src/events/visible.rs:203), i.e. ms since the Unix epoch;
  // `entry.time` is a DOMHighResTimeStamp measured from the page's TIME
  // ORIGIN, so the epoch-relative value is `performance.timeOrigin +
  // entry.time`. Upstream's `Date.now() +` overshoots by the page's
  // uptime. Do not "correct" this back to Date.now().
  const origin =
    typeof performance !== "undefined" && typeof performance.timeOrigin === "number"
      ? performance.timeOrigin
      : 0;
  // Floored because wit `time-ms` is u64 (ref:serialize.ts:162), and lowered
  // as a BigInt: the component-model binding for a 64-bit integer rejects a
  // JS number outright ("u64 expects a bigint") rather than coercing. This is
  // the only 64-bit field crossing this boundary, so it is the only place the
  // distinction bites — and it bites at dispatch time, inside `handle-event`,
  // where it surfaces as an onError rather than a serializer failure. The
  // unit test below pins the BigInt-ness for that reason: comparing plain
  // numbers here would pass while the real boundary throws.
  const timeMs = BigInt(Math.max(0, Math.floor(origin + num(ev.time))));
  return {
    boundingClientRect: rectData(ev.boundingClientRect),
    intersectionRatio: num(ev.intersectionRatio),
    intersectionRect: rectData(ev.intersectionRect),
    isIntersecting: bool(ev.isIntersecting),
    // `option<rect>` -> `rect | undefined`; `rootBounds` is null for an
    // implicit cross-origin viewport root.
    rootBounds: ev.rootBounds ? rectData(ev.rootBounds) : undefined,
    timeMs,
  };
}

/** Serialize a native event into the wit `events.payload` value shape
 * (contracts/embedder-api.md "Value mapping": variant -> `{ kind, value }`).
 * Family chosen by event name, mirroring dioxus-html's name->data-type
 * mapping (per the dispatch's family list). */
export function serializePayload(name: string, ev: NativeEventLike): unknown {
  if (isPointerEvent(name)) return { kind: "pointer", value: pointerData(ev) };
  if (MOUSE_EVENTS.has(name)) return { kind: "mouse", value: mouseData(ev) };
  if (DRAG_EVENTS.has(name)) return { kind: "drag", value: dragData(ev) };
  if (KEYBOARD_EVENTS.has(name)) return { kind: "keyboard", value: keyboardData(ev) };
  if (name === "wheel") return { kind: "wheel", value: wheelData(ev) };
  if (FORM_EVENTS.has(name)) return { kind: "form", value: formData(name, ev) };
  if (SCROLL_EVENTS.has(name)) return { kind: "scroll", value: scrollData(ev) };
  if (IMAGE_EVENTS.has(name)) return { kind: "image", value: imageData(name) };
  if (COMPOSITION_EVENTS.has(name)) return { kind: "composition", value: compositionData(ev) };
  if (ANIMATION_EVENTS.has(name)) return { kind: "animation", value: animationData(ev) };
  if (TRANSITION_EVENTS.has(name)) return { kind: "transition", value: transitionData(ev) };
  if (TOUCH_EVENTS.has(name)) return { kind: "touch", value: touchData(ev) };
  // Synthesized by the dispatcher's observers, not by the DOM.
  if (name === "resize") return { kind: "resize", value: resizeData(ev) };
  if (name === "visible") return { kind: "visible", value: visibleData(ev) };
  return { kind: "empty" };
}

// -- delegation ---------------------------------------------------------------

/** Attribute dioxus-web uses to mark elements resolvable from a dispatched
 * native event back to their guest ElementId (ref:core.ts:48,124). */
const DIOXUS_ID_ATTR = "data-dioxus-id";

/** `resize`/`visible` are not DOM events: dioxus-web synthesizes them from
 * a ResizeObserver / IntersectionObserver (ref:core.ts:109-113). Both are
 * non-bubbling (dioxus-core-types-0.7.10/src/bubbles.rs:87,102), so they
 * already arrive on the per-element registration path, which maps 1:1 onto
 * observe-per-element. */
type ObserverName = "resize" | "visible";
function isObserverName(name: string): name is ObserverName {
  return name === "resize" || name === "visible";
}

interface Registration {
  bubbles: boolean;
  /** The interned string id this listener was registered with
   * (applier.ts's StrRef) — wit/world.wit: "Event names cross back on
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
  // elementId -> { the element, event name -> per-element listener }
  // (non-bubbling). The element is stored alongside so `purge`/`dispose`
  // can detach listeners without the applier handing us the node.
  #local = new Map<number, { el: Element; listeners: Map<string, (e: Event) => void> }>();
  // elementId -> event name -> bubbles, for target-resolution's
  // "has a registration for that event name" check.
  #registrations = new Map<number, Map<string, Registration>>();
  // elementId -> { the element, the observer-backed names it is observed
  // for }. Parallel to `#local` (which holds native listeners) and read by
  // `remove`/`purge`/`dispose` to unobserve. Kept separate because these
  // names have no native listener to remove and their teardown goes
  // through the observer, not the node.
  #observed = new Map<number, { el: Element; names: Set<ObserverName> }>();
  // Lazily created, dispatcher-owned, shared across every observed element
  // (ref:core.ts:62-71,90-99). Upstream passes NO options to either
  // constructor; neither do we.
  #resizeObserver: ResizeObserver | undefined;
  #intersectionObserver: IntersectionObserver | undefined;

  constructor(root: Element, sink: DispatchSink) {
    this.#root = root;
    this.#sink = sink;
  }

  add(el: Element, elementId: number, nameId: number, name: string, bubbles: boolean): void {
    // `mounted` is SYNTHETIC (wit/world.wit, `handle-event`): no such DOM
    // event exists, so attaching a native listener for it — which is what
    // this method used to do — produces a listener that can never fire and
    // an `onmounted` handler that never runs. The host fires it itself,
    // exactly once per registration, through the normal sink.
    //
    // Not recorded in `#registrations`: that map exists solely for
    // `dispatchTo`'s "does this element have a live registration for this
    // native event name?" check, and no native event will ever carry the
    // name `mounted`. Registering it would only create a phantom target
    // (and keep `data-dioxus-id` alive on an element with no real
    // listeners). The consequence for `purge`/`dispose` is that there is
    // simply nothing to clean up: neither `#global` nor `#local` nor
    // `#registrations` ever holds a `mounted` entry, so both already
    // no-op for it, and a guest-emitted remove-event-listener for
    // `mounted` likewise finds nothing and is harmless.
    //
    // Timing: `add()` is called during batch application, i.e. inside the
    // DispatchGate's apply window (host.ts's mutation read loop brackets
    // each chunk's `applyOperations` call with beginApply/endApply). The
    // gate therefore QUEUES this
    // dispatch and drains it in a microtask after `endApply` — which is
    // exactly the contract's requirement that `mounted` fire after the
    // batch that created the element has been fully applied, with the node
    // in the document. No extra deferral is needed here or wanted.
    if (name === "mounted") {
      // No native event object exists. `serializePayload("mounted", stub)`
      // falls through to `{ kind: "empty" }` (the payload the contract
      // specifies), and `preventDefault`/`stopPropagation` are optional on
      // NativeEventLike, so host.ts's DomEvent tolerates their absence.
      this.#sink(elementId, nameId, name, { type: "mounted" });
      return;
    }

    el.setAttribute(DIOXUS_ID_ATTR, String(elementId));

    let byName = this.#registrations.get(elementId);
    if (!byName) {
      byName = new Map();
      this.#registrations.set(elementId, byName);
    }
    byName.set(name, { bubbles, nameId });

    if (isObserverName(name)) {
      // No native `resize`/`visible` event exists, so — exactly as the
      // `mounted` comment above describes — attaching a native listener
      // would produce one that can never fire. Observe instead. Unlike
      // `mounted` these DO fire repeatedly, so the `#registrations` entry
      // set above is a real one and the removal paths must tear it down.
      this.#observe(el, elementId, name);
      return;
    }

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
      let entry = this.#local.get(elementId);
      if (!entry) {
        entry = { el, listeners: new Map() };
        this.#local.set(elementId, entry);
      } else {
        // Defensive: an id reassigned without an intervening purge would
        // otherwise leave the stale element cached here.
        entry.el = el;
      }
      const listener = (e: Event) => this.#handle(name, e);
      entry.listeners.set(name, listener);
      el.addEventListener(name, listener);
    }
  }

  /** Start observing `el` for an observer-backed name, lazily creating the
   * dispatcher's shared observer (ref:core.ts:62-71,90-99).
   *
   * DEGRADED PATH (deliberate): linkedom — the DOM used by every host unit
   * test — provides neither constructor. When the observer is unavailable
   * we still record the registration (done by the caller) but observe
   * nothing, so `add()` is a no-op rather than a throw. Nothing can then
   * fire, which is the correct behaviour in a DOM that has no layout. */
  #observe(el: Element, elementId: number, name: ObserverName): void {
    let entry = this.#observed.get(elementId);
    if (!entry) {
      entry = { el, names: new Set() };
      this.#observed.set(elementId, entry);
    } else {
      // Same defensive refresh as `#local`: an id reassigned without an
      // intervening purge must not keep observing the stale element.
      if (entry.el !== el) {
        for (const stale of entry.names) this.#unobserveNode(entry.el, stale);
        entry.el = el;
      }
    }
    const observer = name === "resize" ? this.#resize() : this.#intersection();
    if (!observer) return; // degraded path; see doc comment
    entry.names.add(name);
    observer.observe(el);
  }

  #resize(): ResizeObserver | undefined {
    if (this.#resizeObserver) return this.#resizeObserver;
    const Ctor = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (typeof Ctor !== "function") return undefined;
    this.#resizeObserver = new Ctor((entries) => {
      for (const entry of entries) {
        // Build the payload-bearing event-like straight from the observer
        // entry and hand it to the sink. Deliberately NOT upstream's
        // CustomEvent round-trip (ref:core.ts:51-60): that exists only
        // because upstream's handler is keyed on native events; this
        // dispatcher has a direct sink (see synthetic `mounted`).
        this.#dispatchObserved("resize", entry.target, {
          type: "resize",
          target: entry.target,
          borderBoxSize: entry.borderBoxSize,
          contentBoxSize: entry.contentBoxSize,
          contentRect: entry.contentRect,
        });
      }
    });
    return this.#resizeObserver;
  }

  #intersection(): IntersectionObserver | undefined {
    if (this.#intersectionObserver) return this.#intersectionObserver;
    const Ctor = (globalThis as { IntersectionObserver?: typeof IntersectionObserver })
      .IntersectionObserver;
    if (typeof Ctor !== "function") return undefined;
    this.#intersectionObserver = new Ctor((entries) => {
      for (const entry of entries) {
        this.#dispatchObserved("visible", entry.target, {
          type: "visible",
          target: entry.target,
          boundingClientRect: entry.boundingClientRect,
          intersectionRatio: entry.intersectionRatio,
          intersectionRect: entry.intersectionRect,
          isIntersecting: entry.isIntersecting,
          rootBounds: entry.rootBounds,
          time: entry.time,
        });
      }
    });
    return this.#intersectionObserver;
  }

  /** Resolve an observation back to its live registration and dispatch.
   * Resolution goes through `#registrations` (never a cached id), so an
   * observation that somehow outlived its registration is dropped rather
   * than delivered to a reused ElementId. */
  #dispatchObserved(name: ObserverName, target: Element, ev: NativeEventLike): void {
    const idAttr = target.getAttribute(DIOXUS_ID_ATTR);
    if (idAttr === null) return;
    const elementId = Number(idAttr);
    const reg = this.#registrations.get(elementId)?.get(name);
    if (!reg) return;
    this.#sink(elementId, reg.nameId, name, ev);
  }

  #unobserveNode(el: Element, name: ObserverName): void {
    const observer = name === "resize" ? this.#resizeObserver : this.#intersectionObserver;
    observer?.unobserve(el);
  }

  /** Stop observing one (element, observer-name) pair and forget it. */
  #unobserve(el: Element, elementId: number, name: ObserverName): void {
    const entry = this.#observed.get(elementId);
    if (!entry || !entry.names.has(name)) return;
    this.#unobserveNode(el, name);
    entry.names.delete(name);
    if (entry.names.size === 0) this.#observed.delete(elementId);
  }

  /** Stop every observation recorded for `elementId`. Shared by `purge`
   * and `dispose`; unobserves the element THIS dispatcher observed (the
   * cached node), not whatever node the caller happens to hold. */
  #unobserveAll(elementId: number): void {
    const entry = this.#observed.get(elementId);
    if (!entry) return;
    for (const name of entry.names) this.#unobserveNode(entry.el, name);
    this.#observed.delete(elementId);
  }

  /** Release one bubbling registration's share of the refcounted root
   * listener for `name`, removing the root listener at zero. Shared by
   * `remove` (guest-driven) and `purge` (unmount/id-reuse driven). */
  #releaseGlobal(name: string): void {
    const entry = this.#global.get(name);
    if (!entry) return;
    entry.active--;
    if (entry.active <= 0) {
      this.#root.removeEventListener(name, entry.listener);
      this.#global.delete(name);
    }
  }

  remove(el: Element, elementId: number, nameId: number, name: string, bubbles: boolean): void {
    void nameId; // symmetry with add(); removal keys off (elementId, name)
    const byName = this.#registrations.get(elementId);
    byName?.delete(name);
    if (byName && byName.size === 0) {
      this.#registrations.delete(elementId);
    }

    if (isObserverName(name)) {
      this.#unobserve(el, elementId, name);
    } else if (bubbles) {
      this.#releaseGlobal(name);
    } else {
      const entry = this.#local.get(elementId);
      const listener = entry?.listeners.get(name);
      if (listener) {
        el.removeEventListener(name, listener);
        entry!.listeners.delete(name);
        if (entry!.listeners.size === 0) this.#local.delete(elementId);
      }
    }

    if (!this.#registrations.has(elementId)) {
      el.removeAttribute(DIOXUS_ID_ATTR);
    }
  }

  /** Drop every registration for `elementId` — its element left the tree or
   * its id was reassigned (`el` is the OLD node).
   *
   * The guest never emits remove-event-listener ops for unmounted subtrees,
   * and ElementIds are slab indices that get REUSED, so registrations keyed
   * by id go stale and a reused id would otherwise inherit the dead
   * element's names. The applier calls this on both signals (see
   * applier.ts `#setNode`/`remove`).
   *
   * Cheap on the hot path: an id with no registrations costs one Map.get. */
  purge(elementId: number, el: Node): void {
    const byName = this.#registrations.get(elementId);
    if (!byName) return;

    for (const [name, reg] of byName) {
      if (reg.bubbles) this.#releaseGlobal(name);
    }

    const entry = this.#local.get(elementId);
    if (entry) {
      for (const [name, listener] of entry.listeners) {
        entry.el.removeEventListener(name, listener);
      }
      this.#local.delete(elementId);
    }

    // Observations are NOT listeners: nothing detaches them when the node
    // leaves the tree, so a missed unobserve here keeps a live observation
    // on a detached node firing into a reused ElementId.
    this.#unobserveAll(elementId);

    this.#registrations.delete(elementId);
    // The old node may be a Text/Comment (the node table holds any Node),
    // which has no removeAttribute — optional-call rather than a tag check.
    (el as Element).removeAttribute?.(DIOXUS_ID_ATTR);
  }

  /** Detach the runtime from the DOM: remove every delegated root listener
   * and every per-element listener, and forget all bookkeeping. Rendered
   * DOM (including `data-dioxus-id` attributes) is left in place — dispose
   * stops dispatch, it does not unrender. */
  dispose(): void {
    for (const [name, entry] of this.#global) {
      this.#root.removeEventListener(name, entry.listener);
    }
    this.#global.clear();
    for (const entry of this.#local.values()) {
      for (const [name, listener] of entry.listeners) {
        entry.el.removeEventListener(name, listener);
      }
    }
    this.#local.clear();
    // `disconnect()` stops every observation this dispatcher ever started,
    // in one call — no per-element bookkeeping to get wrong. The observers
    // are dropped too, so a disposed dispatcher cannot resurrect one.
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.#intersectionObserver?.disconnect();
    this.#intersectionObserver = undefined;
    this.#observed.clear();
    this.#registrations.clear();
  }

  /** Resolve the target elementId for a dispatched native event: walk
   * `event.target` upward to the first element carrying a `data-dioxus-id`
   * attribute AND a live registration for `name` (dispatch prompt's
   * resolution rule), then invoke the sink. The walk STOPS at `#root`:
   * registrations belong to this dispatcher's mount root, and ElementIds
   * are per-instance, so an ancestor above the root carrying a
   * `data-dioxus-id` (a second mounted app, or a stray attribute in the
   * surrounding page) would resolve to an unrelated id — cross-instance
   * mis-dispatch. The root itself is still eligible (it is node id 0).
   * Testable directly without real DOM event plumbing. */
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
      if (el === this.#root) return; // mount-root boundary; never walk above
      el = el.parentElement;
    }
  }

  #handle(name: string, e: Event): void {
    const target = (e.target ?? null) as Element | null;
    this.dispatchTo(target, name, e as unknown as NativeEventLike);
  }
}
