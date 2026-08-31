// Host runtime wiring for polymorph:dioxus — instantiation, the stream
// mutation transport, and DOM event dispatch back into the guest.
//
// Governing docs: wit/world.wit (world `app`, interface `events`), and
// .deps/polyengine/contracts/embedder-api.md ("Module wiring and
// instantiation", "Resources", "Streams and futures" amendment A21, "Value
// mapping"). Cited inline as `contract:<section>`.

import { instantiate } from "@deltic/runtime/embedder";
import type { Translator } from "@deltic/runtime/shim";
import type { DirectSource, Stream } from "@deltic/protocol";

import { DomApplier } from "./applier.ts";
import { FrameDecoder } from "./decoder.ts";
import { EventDispatcher, serializePayload } from "./events.ts";
import type { NativeEventLike } from "./events.ts";

export interface MountOptions {
  componentBytes: Uint8Array;
  /** The @deltic/translator instance (or translator-shim bytes — see
   * embedder-api.md "Module wiring and instantiation" §"Untranslated
   * artifacts" A3). Typed `unknown` here per the dispatch's contract. */
  translator: unknown;
  root: Element;
  /** Asynchronous failure after a successful mount: the mutation stream's
   * parked direct-read session rejecting (guest trap — `PeerTrappedError` —
   * or teardown), or a `handle-event` call rejecting. A failure during mount
   * itself is NOT routed here: `await exports.run()` rejects and `mountApp`
   * throws it to the caller. */
  onError?: (err: unknown) => void;
}

export interface Mounted {
  dispose(): void;
  /** Exposed for tests: the DOM applier the mutation stream feeds. */
  applier: DomApplier;
  /** Exposed for tests: the event dispatcher wired as the applier's
   * ListenerDelegate. */
  dispatcher: EventDispatcher;
  /** Exposed for tests: the stream-transport frame decoder. Lets a
   * test confirm the zero-copy direct-read path actually engaged —
   * `pending()` returns 0 once every delivered byte has been decoded into
   * whole frames, with no heavier instrumentation needed. */
  frameDecoder: FrameDecoder;
  /** Dispatch a native-event-like value at `targetEl` for `name`, exactly
   * as a real DOM listener would (used by fullstack tests and by real
   * event listeners alike). */
  dispatch(targetEl: Element | null, name: string, ev: NativeEventLike): void;
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

/** Mount a polymorph:dioxus app component into `opts.root`.
 *
 * Builds a `DomApplier` over the root (with an `EventDispatcher` as its
 * `ListenerDelegate`), instantiates the component with the `events`
 * imports wired per contracts/embedder-api.md "Module wiring and
 * instantiation" (imports keyed by the verbatim interface id), awaits
 * `run()` for the mutation stream's read end, and parks a direct-read
 * session on it for the life of the instance. Returns a handle for
 * dispatching DOM events and (best-effort) tearing down.
 *
 * Because the read end now comes back as `run`'s return value rather than
 * through a host import, a mount-time guest trap rejects THIS await and is
 * thrown from `mountApp` — an improvement over the previous shape, where
 * `run`'s promise was held open and a mount failure could only surface
 * asynchronously through `onError`.
 */
export async function mountApp(opts: MountOptions): Promise<Mounted> {
  const dispatcher = new EventDispatcher(opts.root, (elementId, nameId, name, ev) => {
    dispatchEvent(elementId, nameId, name, ev);
  });
  const applier = new DomApplier(opts.root, dispatcher);
  const frameDecoder = new FrameDecoder(applier);

  let disposed = false;
  const onError = opts.onError ?? (() => {});

  // `handleEvent` is bound once instantiation gives us `exports`; event
  // dispatch attempted before `run()` has wired listeners is simply a
  // no-op (there is nothing registered to resolve a target against yet).
  // deno-lint-ignore no-explicit-any
  let handleEventExport: ((...a: any[]) => unknown) | undefined;

  // Reentrancy guard: while a `handle-event` export call is in flight, the
  // guest's own synchronous DOM mutations (issued mid-call, before the
  // call's promise settles — e.g. `replaceWith`ing a focused `<input>` out
  // of the DOM) can make the browser fire a SECOND, synchronous native
  // event (`focusout`/`blur`) before the first call returns. Entering the
  // same component instance a second time while the first entry is still
  // on the stack is forbidden by the component model (observed: "Trap:
  // cannot enter component instance 0 (reentrance forbidden)" — see
  // .deps/polyengine/docs/architecture.md's `enter-sync-call` gate,
  // cited by the trap message's own wording). This is a genuine host-side
  // scheduling gap, not a guest bug: TodoMVC's edit-flow
  // (`onkeydown` Enter -> `is_editing.set(false)` -> re-render replaces
  // `.edit` with `.view` -> browser fires `focusout` on the now-detached,
  // still-focused input -> its own `onfocusout` handler tries to dispatch
  // reentrantly) is exactly this pattern, and is unremarkable app code
  // (examples/todomvc/src/lib.rs's `TodoEntry`, ported verbatim from
  // dioxus's own example).
  //
  // Fix: serialize entries into the guest. A reentrant dispatch attempt is
  // queued (payload/DomEvent captured immediately, before queueing, since
  // the native event object may be stale by the time it is replayed) and
  // replayed once the in-flight call's promise settles, preserving
  // dispatch order without ever holding two live entries into the same
  // instance.
  let guestCallInFlight = false;
  const pendingDispatches: Array<() => void> = [];

  function dispatchEvent(elementId: number, nameId: number, name: string, ev: NativeEventLike): void {
    if (disposed || !handleEventExport) return;
    const payload = serializePayload(name, ev);
    const domEvent = new DomEvent(ev);
    const enter = () => {
      guestCallInFlight = true;
      // Export calls are uniformly Promise-shaped (embedder-api.md
      // "Functions and async"); we don't await it (fire-and-forget from
      // the DOM listener's perspective — the guest's own re-render flows
      // through the mutation channel independently), but a rejection must
      // not become an unhandled rejection.
      Promise.resolve(handleEventExport!(elementId, nameId, payload, domEvent))
        .catch(onError)
        .finally(() => {
          guestCallInFlight = false;
          const next = pendingDispatches.shift();
          if (next) next();
        });
    };
    if (guestCallInFlight) {
      pendingDispatches.push(enter);
    } else {
      enter();
    }
  }

  const imports = {
    // The world imports only `events`, whose sole host-implemented item is
    // the `dom-event` resource. Keyed by the verbatim interface id
    // (contract:"Module wiring and instantiation"); the resource class is
    // named by its bindgen-emitted UpperCamel name
    // (contract:"Resources").
    "polymorph:dioxus/events@0.1.0": { DomEvent },
  };

  const instance = await instantiate(
    { componentBytes: opts.componentBytes, translator: opts.translator as Uint8Array | Translator },
    imports,
  );

  handleEventExport = instance.exports.handleEvent as (...a: unknown[]) => unknown;

  // `run` starts the app and returns the mutation channel's read end; its
  // promise settles as soon as the guest hands the reader back (the app's
  // scheduler keeps running as a spawned guest task). A trap before the
  // return rejects here and propagates out of `mountApp`.
  const ops = await (instance.exports.run as () => Promise<Stream<Uint8Array>>)();

  // Park a direct-read session for the instance's lifetime. We always consume
  // the FULL view per rendezvous — whole frames decoded+applied, any partial
  // tail staged in the FrameDecoder — so `readDirect`'s "never acknowledge
  // zero bytes" hazard (embedder-api.md amendment A21) never arises:
  // `markRead` always receives `view.length`, never 0.
  const consume = (src: DirectSource): "more" | "done" => {
    const view = src.remaining();
    const n = frameDecoder.feed(view);
    if (n < view.length) {
      frameDecoder.stashRest(view, n);
    }
    // The callback runs DOM application only (decodeBatch via the
    // FrameDecoder) — it never calls back into guest code, honoring the A21
    // reentrancy rule ("calls that can run guest code ... are forbidden"
    // inside a direct-read callback).
    src.markRead(view.length);
    return "more";
  };
  // The session only settles on stream end/drop/fault, which for a healthy
  // long-lived app never happens in normal operation. Route a rejection (peer
  // trap, teardown) to onError rather than letting it become unhandled.
  ops.readDirect(consume).catch((err: unknown) => {
    if (!disposed) onError(err);
  });

  const mounted: Mounted = {
    applier,
    dispatcher,
    frameDecoder,
    dispatch(targetEl, name, ev) {
      dispatcher.dispatchTo(targetEl, name, ev);
    },
    dispose() {
      // Best-effort teardown: the embedder API (contracts/embedder-api.md
      // "Module wiring and instantiation") exposes no instance-level
      // dispose/drop — `EmbedderInstance` is `{ exports, handle, imports }`
      // with no teardown method, and per-`Stream`/`Future` disposal is the
      // only documented release path. We therefore just mark ourselves
      // disposed (suppressing further dispatch/onError activity); the
      // stream's direct-read session, if any, is released when the
      // component instance itself is garbage-collected or traps. If a
      // future embedder-api revision adds instance disposal, wire it here.
      disposed = true;
    },
  };
  return mounted;
}
