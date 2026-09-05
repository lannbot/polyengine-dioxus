// Host runtime wiring for polymorph:dioxus — instantiation, the stream
// mutation channel, and DOM event dispatch back into the guest.
//
// Governing docs: wit/world.wit (world `app`, interface `events`), and
// .deps/polyengine/contracts/embedder-api.md ("Module wiring and
// instantiation", "Resources", "Streams and futures", "Value mapping").
// Cited inline as `contract:<section>`.

import { instantiate } from "@deltic/runtime/embedder";
import { wasi } from "@polyengine/wasi";
import type { InstantiateSource } from "@deltic/runtime/embedder";
import type { Stream } from "@deltic/protocol";

import { DomApplier } from "./applier.ts";
import { DispatchGate } from "./dispatch.ts";
import { createEvalImports } from "./eval.ts";
import type { EvalImports } from "./eval.ts";
import { EventDispatcher, HostDataTransfer, HostFile, serializePayload } from "./events.ts";
import type { NativeEventLike } from "./events.ts";
import { createHeadImports } from "./head.ts";
import type { HeadImports } from "./head.ts";
import { createHistoryImports, fragmentHistory, memoryHistory } from "./history.ts";
import type { HistoryImports, HistoryProvider } from "./history.ts";
import { type Interceptors, wrap } from "./intercept.ts";
import { applyOperations } from "./operations.ts";
import type { Operation } from "./operations.ts";

/** The host side of `polymorph:dioxus/dom`'s import table, as built by
 * `createDomImports` — the type `MountOptions.intercept.dom` interceptors
 * are checked against. Declared explicitly (rather than
 * `ReturnType<typeof createDomImports>`) because `createDomImports` itself
 * takes an `Interceptors<DomImports>` argument — a `ReturnType` alias would
 * circularly reference itself through that parameter. */
export interface DomImports {
  getScrollOffset(target: number): Point | undefined;
  getScrollSize(target: number): Size | undefined;
  getClientRect(target: number): Rect | undefined;
  scrollTo(target: number, options: ScrollToOptions_): boolean;
  scroll(target: number, offset: Point, behavior: ScrollBehavior_): boolean;
  setFocus(target: number, focus: boolean): boolean;
  // deno-lint-ignore no-explicit-any
  [key: string]: (...args: any[]) => any;
}
export type { EvalImports, HeadImports, HistoryImports };

export interface MountOptions {
  /** Component artifacts in either form `instantiate` accepts: a
   * build-time translation ENVELOPE reconstituted via
   * `artifactsFromEnvelope` (what the harness/Pages build ships — the
   * blessed deploy artifact per embedder-api.md amendment A4, so no
   * translator is deployed), or `{ componentBytes, translator }` for
   * callers that translate at runtime (amendment A3). Passed through
   * verbatim to `instantiate`. */
  source: InstantiateSource;
  root: Element;
  /** Request `render-mode.hydrate` instead of the default `render-mode.
   * fresh` (wit/world.wit world `app`'s `render-mode` variant). Setting
   * this is an assertion by the caller that `root` already holds this
   * exact component's markup, prerendered at its initial state by
   * `dioxus-ssr`'s `pre_render` — hydration is positional, not compared
   * against the vdom, so a mismatch (wrong component, wrong initial
   * state, edited markup) is a build-skew bug, and the host reports it as
   * a thrown Error (`DomApplier.hydrate`) rather than silently repairing
   * or falling back to a fresh render. Defaults to `false` (fresh). */
  hydrate?: boolean;
  /** Asynchronous failure after a successful mount: the mutation stream's
   * read loop rejecting (guest trap — `PeerTrappedError` — or teardown), or
   * a `handle-event` call rejecting. A failure during mount itself is NOT
   * routed here: `await exports.run(mode)` rejects and `mountApp` throws it to
   * the caller. */
  onError?: (err: unknown) => void;
  /** Supply `polymorph:dioxus/eval@0.6.0` (wit/world.wit `interface eval`)
   * so guest `document::eval` calls run arbitrary JS in this page.
   * Defaults to `false`. OPT-IN ON BOTH SIDES (the interface doc is
   * normative): a component whose renderer was built without the `eval`
   * Cargo feature never imports the interface at all, so this flag is
   * moot for it either way; a component that DOES import it fails to
   * instantiate against a host that leaves this `false` — failure is the
   * safe direction. polyvisor sets this only for its own visor, never for
   * an untrusted app: a browser cannot sandbox arbitrary JS, so this is a
   * trusted-computing-base decision, not a per-mount convenience. */
  eval?: boolean;
  /** How `polymorph:dioxus/history` (wit/world.wit `interface history`)
   * meets the real browser: `"memory"` (default) keeps an in-memory stack
   * with no URL involvement (`history.ts`'s `memoryHistory`); `"fragment"`
   * encodes the route into `location.hash` (`fragmentHistory`) — the shape
   * for a host that does not own the path, such as polyvisor's apps.
   * Requires `globalThis.window` when `"fragment"`. */
  history?: "memory" | "fragment";
  /** Per-operation policy hooks over the host-implemented import tables
   * (host/src/intercept.ts is normative: what an interceptor may do, the
   * denial spellings, why THROWING from one is a host bug, and why
   * `intercept.eval` without `eval: true` is a configuration error rather
   * than a way to grant eval — enforced below, at mount, before
   * instantiation). Absent means every fragment's default behavior,
   * unmodified — the pre-interceptor behavior of every existing caller. */
  intercept?: {
    dom?: Interceptors<DomImports>;
    eval?: Interceptors<EvalImports>;
    head?: Interceptors<HeadImports>;
    history?: Interceptors<HistoryImports>;
  };
}

export interface Mounted {
  /** Tear down the runtime: stops event dispatch (queued and future),
   * detaches every DOM listener this mount attached, and drops the
   * mutation stream's read end (the guest then observes reader-gone and
   * stops producing). Rendered DOM is left in place. Idempotent. */
  dispose(): void;
  /** Exposed for tests: the DOM applier the mutation stream feeds. */
  applier: DomApplier;
  /** Exposed for tests: the event dispatcher wired as the applier's
   * ListenerDelegate. */
  dispatcher: EventDispatcher;
  /** Dispatch a native-event-like value at `targetEl` for `name`, exactly
   * as a real DOM listener would (used by fullstack tests and by real
   * event listeners alike). */
  dispatch(targetEl: Element | null, name: string, ev: NativeEventLike): void;
  /** The `HistoryProvider` backing `polymorph:dioxus/history` for this
   * mount (`memoryHistory`/`fragmentHistory`, host/src/history.ts).
   * Exposed for tests and embedders driving history from the host side
   * (`mounted.history.back()`, an external-navigation notification). */
  history: HistoryProvider;
}


/**
 * A host-implemented resource class for `events.dom-event`
 * (contracts/embedder-api.md "Resources": "the host provides a plain class
 * implementing the bindgen-emitted interface"). Constructed per dispatched
 * event and passed as the `ev: borrow<dom-event>` argument to
 * `handle-event`; the guest must not retain it past that call (CABI-
 * enforced borrow scoping, not this class's job).
 *
 * `preventDefault`/`stopPropagation` call through to the native Event
 * unconditionally — even after the dispatch that lent this instance has
 * completed. wit/world.wit's dom-event doc says calling either "after the
 * originating dispatch has completed is a harmless no-op": the DOM itself
 * makes a post-dispatch `preventDefault()` a no-op (dispatch has already
 * decided whether to honor it) and a post-dispatch `stopPropagation()` has
 * nothing left to stop, so this is free — no completion-tracking needed.
 */
class DomEvent {
  #native: NativeEventLike;

  constructor(native: NativeEventLike) {
    this.#native = native;
  }

  preventDefault(): void {
    this.#native.preventDefault?.();
  }

  stopPropagation(): void {
    this.#native.stopPropagation?.();
  }
}

// -- the `dom` interface ------------------------------------------------------

/** WIT `dom.point` — record, camelCase fields (contract:"Value mapping"). */
interface Point {
  x: number;
  y: number;
}
/** WIT `dom.size`. */
interface Size {
  width: number;
  height: number;
}
/** WIT `dom.rect`. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** WIT `dom.scroll-behavior` / `dom.scroll-alignment` — enums lift as the
 * bare case name string (contract:"Value mapping", `enum` row: "string
 * literal union of kebab-case case names"). Both enums' cases are single
 * words that coincide with the DOM's own `ScrollBehavior` /
 * `ScrollLogicalPosition` strings, so they pass straight through. */
type ScrollBehavior_ = "instant" | "smooth";
type ScrollAlignment = "start" | "center" | "end" | "nearest";
/** WIT `dom.scroll-to-options`. `vertical`/`horizontal` are the DOM's
 * `block`/`inline` (wit/world.wit says so). */
interface ScrollToOptions_ {
  behavior: ScrollBehavior_;
  vertical: ScrollAlignment;
  horizontal: ScrollAlignment;
}

/** The members of a live DOM element this interface reaches for. All
 * optional: the applier's node table holds any `Node` (Text/Comment have
 * none of these), and linkedom — a real target, since the Deno host tests
 * run against it — implements only some of them on Element (it has
 * `focus`/`blur`/`getBoundingClientRect`, but no `scrollTo`/
 * `scrollIntoView`, and no `scrollLeft`/`scrollWidth` accessors). */
type DomTarget = Node & {
  scrollLeft?: number;
  scrollTop?: number;
  scrollWidth?: number;
  scrollHeight?: number;
  getBoundingClientRect?: () => { x: number; y: number; width: number; height: number };
  scrollIntoView?: (opts: unknown) => void;
  scrollTo?: (opts: unknown) => void;
  focus?: () => void;
  blur?: () => void;
};

function isNum(v: number | undefined): v is number {
  return typeof v === "number";
}

/**
 * Build the host side of `polymorph:dioxus/dom` over an applier's node
 * table and a dispatch gate.
 *
 * Split out of `mountApp` so it can be unit-tested against a bare
 * `DomApplier` + linkedom document, with no component in the loop
 * (host/tests/host_dom_test.ts).
 *
 * ## Shared shape
 *
 * Every function starts the same way: resolve the ElementId through the
 * applier's node table, and give up if there is no LIVE node for it. Two
 * ways to miss, both legal and expected rather than exceptional —
 * wit/world.wit's convention is that queries answer `none` and commands
 * answer `false`, never a trap:
 *
 *  - no entry for the id at all. ElementIds are reused slab indices, so a
 *    `MountedData` handle the app stashed can outlive its element.
 *  - the node exists but is detached (`isConnected === false`).
 *    `DomApplier.remove` unlinks a node from the document without clearing
 *    its slot in the node table (the slot is cleared when dioxus reuses
 *    the id), so without this check a removed-but-unreused id would still
 *    resolve and the operation would silently "succeed" on a node that is
 *    nowhere — looser than "no live node holds that id". Caveat: a DOM
 *    implementation may not expose `isConnected` at all; absent means
 *    "cannot determine", and we allow rather than fail closed, since
 *    failing closed there would make every operation a no-op on such an
 *    implementation. (linkedom does implement it, so the Deno tests
 *    exercise the real path.)
 *  - the node does not support the operation — a Text/Comment reached via
 *    a `dangerous_inner_html`/placeholder id, or a DOM implementation
 *    without the member. Treated as the SAME miss as an unknown id: from
 *    the guest's side "this handle cannot be scrolled" and "this handle no
 *    longer names anything" are the same failed request, and inventing a
 *    distinct outcome would need contract surface that does not exist.
 *
 * ## Reentrancy bracketing
 *
 * `command` takes the gate's apply window; `query` deliberately does not.
 * The bracket exists because host code invoked BY the guest runs with a
 * guest activation live on the stack (dispatch.ts module comment, window
 * 3), so any native event fired from here would be dispatched straight
 * back into it. The mutating operations all fire such events
 * synchronously: `focus`/`blur` fire `focusout`/`focusin` (wit/world.wit
 * says so normatively), and `scrollIntoView`/`scrollTo` fire `scroll` (and
 * later `scrollend`) — `scroll` is in dioxus-html's event table and this
 * host delegates it, so it is a live hazard, not a theoretical one.
 * The queries read layout and scroll offsets and fire nothing at all; a
 * bracket around them would be pure noise (and would suggest to a reader
 * that reading `scrollTop` can re-enter the guest, which it cannot).
 */
export function createDomImports(
  applier: DomApplier,
  gate: DispatchGate,
  interceptors?: Interceptors<DomImports>,
) {
  /** Resolve an ElementId to a live node, or `undefined` (see the
   * two-ways-to-miss list above). */
  function live(target: number): DomTarget | undefined {
    const node = applier.nodeFor(target) as DomTarget | undefined;
    if (node === undefined) return undefined;
    // Absent `isConnected` = cannot determine = allow.
    if (node.isConnected === false) return undefined;
    return node;
  }

  /** A read-only operation: no gate bracket (see above). `read` returns
   * `undefined` when the node does not support it, which is the same
   * `none` an unknown id produces. WIT `option<T>` lifts as `T |
   * undefined` (contract:"Value mapping", `option<T>` row; the boxed
   * `{ kind: "some" | "none" }` form applies only to an option nested
   * DIRECTLY inside another option — "Option rule" — which none of these
   * returns is). */
  function query<T>(target: number, read: (el: DomTarget) => T | undefined): T | undefined {
    const el = live(target);
    return el === undefined ? undefined : read(el);
  }

  /** A mutating operation's UNBRACKETED body (intercept.ts: "the gate
   * bracket is outside the interceptor" — this fragment's bracket goes
   * around the wrapped table below, not in here). `act` returns false
   * when the node does not support it. */
  function act(target: number, run: (el: DomTarget) => boolean): boolean {
    const el = live(target);
    return el === undefined ? false : run(el);
  }

  const impls = {
    getScrollOffset(target: number): Point | undefined {
      return query(target, (el) =>
        isNum(el.scrollLeft) && isNum(el.scrollTop)
          ? { x: el.scrollLeft, y: el.scrollTop }
          : undefined);
    },

    getScrollSize(target: number): Size | undefined {
      return query(target, (el) =>
        isNum(el.scrollWidth) && isNum(el.scrollHeight)
          ? { width: el.scrollWidth, height: el.scrollHeight }
          : undefined);
    },

    getClientRect(target: number): Rect | undefined {
      return query(target, (el) => {
        if (typeof el.getBoundingClientRect !== "function") return undefined;
        // DOMRect carries more than `rect` does (top/right/bottom/left are
        // derivable); take exactly the four fields the record declares —
        // a record lowers by field name, so extras would be ignored, but
        // being explicit keeps the mapping readable.
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
    },

    scrollTo(target: number, options: ScrollToOptions_): boolean {
      return act(target, (el) => {
        if (typeof el.scrollIntoView !== "function") return false;
        // wit: `vertical`/`horizontal` ARE the DOM's `block`/`inline`.
        el.scrollIntoView({
          behavior: options.behavior,
          block: options.vertical,
          inline: options.horizontal,
        });
        return true;
      });
    },

    scroll(target: number, offset: Point, behavior: ScrollBehavior_): boolean {
      return act(target, (el) => {
        if (typeof el.scrollTo !== "function") return false;
        el.scrollTo({ left: offset.x, top: offset.y, behavior });
        return true;
      });
    },

    setFocus(target: number, focus: boolean): boolean {
      return act(target, (el) => {
        const fn = focus ? el.focus : el.blur;
        if (typeof fn !== "function") return false;
        fn.call(el);
        return true;
      });
    },
  };

  const wrapped = wrap(impls, interceptors);

  /** Bracket a mutating op: native events it fires synchronously are
   * queued by the gate and drained once the calling guest's turn unwinds
   * instead of re-entering the instance.
   *
   * The bracket is not re-entrant (`#applying` is a flag, not a counter),
   * which is sound: the guest cannot call one of these imports while its
   * own mutation batch is being applied — during application it is parked
   * in the stream-write rendezvous, not executing. */
  function bracketed<A extends unknown[]>(fn: (...args: A) => boolean): (...args: A) => boolean {
    return (...args: A) => {
      gate.beginApply();
      try {
        return fn(...args);
      } finally {
        gate.endApply();
      }
    };
  }

  return {
    getScrollOffset: wrapped.getScrollOffset,
    getScrollSize: wrapped.getScrollSize,
    getClientRect: wrapped.getClientRect,
    scrollTo: bracketed(wrapped.scrollTo),
    scroll: bracketed(wrapped.scroll),
    setFocus: bracketed(wrapped.setFocus),
  };
}

/** Mount a polymorph:dioxus app component into `opts.root`.
 *
 * Builds a `DomApplier` over the root (with an `EventDispatcher` as its
 * `ListenerDelegate`), instantiates the component with the `events`/`dom`
 * imports wired per contracts/embedder-api.md "Module wiring and
 * instantiation" (imports keyed by the verbatim interface id), awaits
 * `run()` for the mutation stream's read end, and starts a read loop over
 * it for the life of the instance. Returns a handle for dispatching DOM
 * events and (best-effort) tearing down.
 *
 * Because the read end now comes back as `run`'s return value rather than
 * through a host import, a mount-time guest trap rejects THIS await and is
 * thrown from `mountApp` — an improvement over the previous shape, where
 * `run`'s promise was held open and a mount failure could only surface
 * asynchronously through `onError`.
 */
export async function mountApp(opts: MountOptions): Promise<Mounted> {
  // INTERCEPTORS DO NOT GRANT (intercept.ts header): `intercept.eval` on a
  // mount that did not also set `eval: true` is a configuration error, not
  // a way in. Thrown synchronously, before any instantiation is attempted.
  if (opts.intercept?.eval && !opts.eval) {
    throw new Error(
      "mountApp: intercept.eval given without eval: true — interceptors do not grant capabilities",
    );
  }

  const dispatcher = new EventDispatcher(opts.root, (elementId, nameId, name, ev) => {
    dispatchEvent(elementId, nameId, name, ev);
  });
  const applier = new DomApplier(opts.root, dispatcher);

  let disposed = false;
  const onError = opts.onError ?? (() => {});

  // `handleEvent` is bound once instantiation gives us `exports`; event
  // dispatch attempted before `run()` has wired listeners is simply a
  // no-op (there is nothing registered to resolve a target against yet).
  // deno-lint-ignore no-explicit-any
  let handleEventExport: ((...a: any[]) => unknown) | undefined;

  // Reentrancy guard. Entering the component instance while a guest
  // activation is already live is forbidden by the component model
  // (observed: "Trap: cannot enter component instance 0 (reentrance
  // forbidden)" — see .deps/polyengine/docs/architecture.md's
  // `enter-sync-call` gate, cited by the trap message's own wording). Two
  // distinct host-side windows reach that from ordinary app code:
  //
  // (1) While a `handle-event` export call is in flight. The guest's own
  //     synchronous DOM mutations (issued mid-call, before the call's
  //     promise settles — e.g. `replaceWith`ing a focused `<input>` out of
  //     the DOM) can make the browser fire a SECOND, synchronous native
  //     event (`focusout`/`blur`) before the first call returns. This is a
  //     genuine host-side scheduling gap, not a guest bug: TodoMVC's
  //     edit-flow (`onkeydown` Enter -> `is_editing.set(false)` ->
  //     re-render replaces `.edit` with `.view` -> browser fires `focusout`
  //     on the now-detached, still-focused input -> its own `onfocusout`
  //     handler tries to dispatch reentrantly) is exactly this pattern, and
  //     is unremarkable app code (examples/todomvc/src/lib.rs's
  //     `TodoEntry`, ported verbatim from dioxus's own example).
  //
  // (2) While mutations are being APPLIED, with no `handle-event` in flight
  //     at all. A scheduler-driven flush (guest timer/async re-render)
  //     delivers a batch through the mutation read loop below, and DOM
  //     application (`applyOperations`) runs synchronously inside that
  //     loop's `await ... read()` resumption — i.e. inside the guest's
  //     stream-write rendezvous, with a live guest turn on the stack (the
  //     reentrance bracket is turn-scoped: taken around every thread
  //     resumption, released when the thread parks —
  //     .deps/polyengine/runtime/src/task/thread.ts). A native event fired
  //     by the mutation itself would enter the guest straight out of the
  //     rendezvous — forbidden outright, trap or not.
  //
  // Fix: serialize entries into the guest through `DispatchGate` (see
  // ./dispatch.ts for the full rationale, including why a microtask-
  // deferred drain is always in a legal window, and the lost-preventDefault
  // caveat for deferred dispatches). A dispatch attempted in either window
  // is queued (payload/DomEvent captured immediately, before queueing,
  // since the native event object may be stale by the time it is replayed)
  // and replayed once the window closes, preserving dispatch order without
  // ever holding two live entries into the same instance.
  const gate = new DispatchGate(onError);

  function dispatchEvent(elementId: number, nameId: number, name: string, ev: NativeEventLike): void {
    if (disposed || !handleEventExport) return;
    // Captured BEFORE queueing — the native event may be stale at replay.
    const payload = serializePayload(name, ev);
    const domEvent = new DomEvent(ev);
    gate.dispatch(() => handleEventExport!(elementId, nameId, payload, domEvent));
  }

  const doc = opts.root.ownerDocument;
  const historyProvider: HistoryProvider = opts.history === "fragment"
    ? fragmentHistory(
      globalThis.window ??
        (() => {
          throw new Error("mountApp: history: \"fragment\" requires globalThis.window");
        })(),
    )
    : memoryHistory();

  const imports = {
    // WASI p2 providers. Guest components are built for wasm32-wasip2,
    // which links wasi-libc and therefore imports wasi:cli/io/clocks/random
    // whether or not the app calls them (std's startup touches
    // environment/stdio). polyengine ships the implementations; `wasi()`
    // returns them keyed by interface id, ready to spread.
    ...wasi(),
    // Keyed by the verbatim interface id (contract:"Module wiring and
    // instantiation"), so the version tracks the WIT package version —
    // now 0.6.0. `events`' host-implemented items are the `dom-event`,
    // `file`, and `data-transfer` resources, named by their bindgen-emitted
    // UpperCamel names (contract:"Resources"; wit resource name `file` ->
    // `File`, `data-transfer` -> `DataTransfer`); `dom`'s items are
    // functions, named by their bindgen-emitted lowerCamel names.
    "polymorph:dioxus/events@0.6.0": { DomEvent, File: HostFile, DataTransfer: HostDataTransfer },
    "polymorph:dioxus/dom@0.6.0": createDomImports(applier, gate, opts.intercept?.dom),
    // Unconditional imports (wit `world app`): every component gets these,
    // eval feature or not.
    "polymorph:dioxus/head@0.6.0": createHeadImports(
      doc,
      gate,
      { allowScript: !!opts.eval },
      opts.intercept?.head,
    ),
    "polymorph:dioxus/history@0.6.0": createHistoryImports(historyProvider, opts.intercept?.history),
    // Present only when the caller opted in (`MountOptions.eval` doc
    // above). Absent otherwise — the world's `import eval` still exists
    // in every `app`-world component, but wit-component only encodes the
    // interfaces the guest's core module actually imports, so a
    // non-`eval`-feature build never asks for this key and its absence
    // here is never noticed.
    ...(opts.eval
      ? { "polymorph:dioxus/eval@0.6.0": createEvalImports(gate, opts.intercept?.eval) }
      : {}),
  };

  const instance = await instantiate(opts.source, imports);

  handleEventExport = instance.exports.handleEvent as (...a: unknown[]) => unknown;

  // `run` starts the app and returns the mutation stream's read end; the
  // promise settles as soon as the guest hands the reader back (the app's
  // scheduler keeps running as a spawned guest task). A trap before the
  // return rejects here and propagates out of `mountApp`.
  //
  // `render-mode` is a payload-less variant, so it lowers as `{ kind:
  // "fresh" }` / `{ kind: "hydrate" }` — same shape as the existing
  // `{ kind: "none" }` / `{ kind: "dynamic" }` arms in operations.ts
  // (contract:"Value mapping").
  const mode = { kind: opts.hydrate ? "hydrate" : "fresh" };
  const ops = await (instance.exports.run as (m: unknown) => Promise<Stream<Operation>>)(mode);

  // The guest scheduler's persistent park between renders needs SOME
  // host-side reason the store's deadlock verdict stays suppressed.
  // wit/world.wit's `run` doc, citing .deps/polyengine/contracts/
  // embedder-api.md §"Streams and futures", issue #162
  // ("Deadlock-verdict suppression tracks host retention"): suppression
  // holds "while the host retains a way to act on a stream/future — a
  // retained end, a parked host operation, or an unfinished producer pump".
  // That rule is disjunctive, and what applies here is the first disjunct,
  // not the second: `mountApp` holds the lifted readable end (`ops`) for
  // the instance's whole lifetime — never lowered back into the guest —
  // which is retention-by-itself, independent of whether a `read()` happens
  // to be in flight at any given instant. (Runtime-side, this is
  // `HostActivity` arming on the retained end and disarming only on a
  // lower-back-to-guest — .deps/polyengine/runtime/src/exec/
  // host_streams.ts.) So there being a brief gap with no read outstanding
  // (the await resumption between one `read()`'s chunk landing and
  // `applyOperations` finishing, before the next `read()` is issued) is not
  // itself a hazard: retention already covers it.
  //
  // The next read is still issued immediately after applying a chunk, with
  // no unnecessary work in between — good practice for latency, not a
  // correctness requirement.
  //
  // MAX_READ must be large enough that a whole batch (up to ~40k operations
  // for the 10k-row bench case) arrives in one chunk.
  const MAX_READ = 1 << 22;
  (async () => {
    while (!disposed) {
      const chunk = await ops.read(MAX_READ);
      if (chunk.length === 0) break; // end of stream
      gate.beginApply();
      try {
        applyOperations(chunk, applier);
      } finally {
        gate.endApply();
      }
    }
  })().catch((err: unknown) => {
    if (!disposed) onError(err);
  });

  const mounted: Mounted = {
    applier,
    dispatcher,
    history: historyProvider,
    dispatch(targetEl, name, ev) {
      dispatcher.dispatchTo(targetEl, name, ev);
    },
    dispose() {
      // Per-STREAM disposal is the documented release path: `Stream<T>`
      // exposes `drop()` (.deps/polyengine/protocol/src/handles.ts:68-82,
      // "`[Symbol.dispose]` alias"), and dropping the read end resolves the
      // read loop's next `read()` with `done` (a resolution, not a
      // rejection — `onError` stays silent, and the `!disposed` guard on
      // the catch is belt-and-braces), and the guest observes reader-gone
      // on its next write (its driver detects leftover bytes from
      // `write_all`, sets its `dead` flag, and discards further batches
      // with bounded memory — src/driver.rs), so it goes dark.
      //
      // Instance-level disposal still does not exist in the embedder API
      // (`EmbedderInstance` is `{ exports, handle, imports }`), so the
      // component instance itself is released only by GC. Rendered DOM is
      // left in place: dispose detaches the runtime, it does not unrender.
      if (disposed) return;
      disposed = true;
      gate.dispose();
      dispatcher.dispose();
      ops.drop();
    },
  };
  return mounted;
}
