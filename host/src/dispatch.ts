// Serialization of host->guest `handle-event` entries.
//
// The host may only enter the guest component instance when no guest
// activation is live. There are THREE windows in which a naive, synchronous
// dispatch from a DOM listener would violate that, and all three are
// reachable from ordinary app code:
//
//   1. A `handle-event` call is in flight. The guest's own synchronous DOM
//      mutations (issued mid-call, before the call's promise settles — e.g.
//      `replaceWith`ing a focused `<input>` out of the DOM) make the browser
//      fire a SECOND, synchronous native event (`focusout`/`blur`) while the
//      first entry is still on the stack. Entering the instance again there
//      is forbidden by the component model (observed: "Trap: cannot enter
//      component instance 0 (reentrance forbidden)").
//
//   2. A scheduler-driven mutation flush. When the guest re-renders off its
//      own timer/async work — no `handle-event` in flight at all — the
//      mutation frames arrive through the stream's direct-read `consume`
//      callback, and DOM application happens synchronously INSIDE that
//      callback, i.e. inside the guest's stream-write rendezvous. A live
//      guest activation is on the stack: the instance's reentrance bracket
//      is turn-scoped, taken around every thread resumption and released
//      only when the thread parks (.deps/polyengine/runtime/src/task/
//      thread.ts `resumeWith`, and exec/boundary.ts's matching bracket). So
//      a native event fired by the mutation itself would enter the guest
//      from inside a live turn — the same trap, with nothing "in flight"
//      by the window-1 bookkeeping.
//
//   3. A host IMPORT invoked by the guest. `dom.set-focus` (wit/world.wit,
//      `interface dom`) runs host code while the guest that called it is
//      still on the stack, and `.focus()`/`.blur()` fire `focusout`/
//      `focusin` SYNCHRONOUSLY — delegated events this host would otherwise
//      dispatch straight back into that same live activation. Same class as
//      window 2 (host code running inside a guest turn), reached from the
//      other direction. The mechanism is unchanged: host.ts's `setFocus`
//      brackets its body with `beginApply`/`endApply`, so dispatches raised
//      by the focus change queue and drain once the guest's turn unwinds.
//
// Window 2 is also forbidden outright by contract, independently of the
// trap: .deps/polyengine/contracts/embedder-api.md amendment A21 ("Streams
// and futures", direct-read scoping) — "Inside the callback, calls that can
// run guest code or operate this stream are forbidden (reentrancy)". A21
// gives a second, memory-safety reason: the `DirectSource` view aliases
// guest linear memory, and views are re-derived only per `remaining()` call
// ("a `memory.grow` **between** rendezvous never yields a stale view" —
// within one rendezvous there is no re-derivation). Guest code run
// mid-callback could `memory.grow` and detach the buffer under the decoder.
//
// Why deferring to a microtask is sound: microtasks run only when the JS
// stack is empty, and a guest turn holds the stack until it parks or
// completes. Since the reentrance bracket is turn-scoped, an empty stack
// implies no live turn, hence an enterable instance. A drain deferred with
// `queueMicrotask` therefore always runs in a legal window — no polling, no
// timers, and it lands at the earliest legal moment.
//
// Caveat: `preventDefault` semantics are lost for DEFERRED dispatches. The
// browser has already decided whether to honor the default by the time the
// queued entry runs. This is inherent to any deferral (it was already true
// of the pre-existing in-flight queue), and the events that actually
// trigger deferral are focusout-class events with no meaningful default.
// The idle path stays synchronous precisely to keep `preventDefault`
// working for the common case, where the dispatch happens inside the
// native listener's own frame.

/**
 * Serializes guest entries so that at most one is live and none is attempted
 * inside a forbidden window (see the module comment: in-flight call,
 * mutation application inside the direct-read callback, or a host import
 * running inside the calling guest's turn).
 *
 * Pure logic — no DOM, no runtime imports — so the ordering rules can be
 * unit-tested directly. The host wraps mutation application AND the bodies
 * of guest-invoked imports in `beginApply`/`endApply`, and routes every DOM
 * event through `dispatch`.
 */
export class DispatchGate {
  /** A guest `handle-event` call is in flight (its promise is unsettled). */
  #busy = false;
  /** Inside a host-code window that runs within a live guest turn: the
   * direct-read `consume` callback (mutation application), or the body of
   * a host import the guest called. */
  #applying = false;
  #disposed = false;
  /** Captured guest-entry thunks, drained FIFO. */
  #pending: Array<() => unknown> = [];
  #onError: (err: unknown) => void;

  constructor(onError: (err: unknown) => void) {
    this.#onError = onError;
  }

  /** Enter the mutation-application window: dispatches now queue. */
  beginApply(): void {
    this.#applying = true;
  }

  /** Leave the mutation-application window and drain what it collected.
   *
   * The drain is deferred with `queueMicrotask` rather than run inline:
   * `endApply` is called from the `finally` inside the direct-read callback,
   * which is still on the guest's rendezvous stack — the instance is not
   * enterable until that turn unwinds. An empty JS stack is the observable
   * proxy for "no live guest turn" (module comment). The same holds for a
   * host import's `finally`: it runs inside the caller's turn. */
  endApply(): void {
    this.#applying = false;
    if (this.#pending.length > 0) queueMicrotask(() => this.#drain());
  }

  /** Drop every queued entry and refuse further dispatches. */
  dispose(): void {
    this.#disposed = true;
    this.#pending.length = 0;
  }

  /** Route a guest entry. `call` must have captured everything it needs
   * (payload, event wrapper) BEFORE being handed here: a queued entry runs
   * later, when the native event object may already be stale. */
  dispatch(call: () => unknown): void {
    if (this.#disposed) return;
    if (this.#busy || this.#applying) {
      this.#pending.push(() => this.#enter(call));
      return;
    }
    // Idle: enter synchronously, so a `preventDefault()` made by the guest
    // still lands inside the native listener's frame.
    this.#enter(call);
  }

  #enter(call: () => unknown): void {
    // Queued thunks are cleared by `dispose`, so this is belt-and-braces —
    // but it documents the invariant: nothing enters the guest after
    // disposal.
    if (this.#disposed) return;
    this.#busy = true;
    let p: Promise<unknown>;
    try {
      // Export calls are uniformly Promise-shaped (embedder-api.md
      // "Functions and async"), but a SYNCHRONOUS throw is still possible
      // (argument lowering failure, already-trapped instance). Previously
      // that wedged the queue forever, since the in-flight flag was set and
      // no `finally` ever ran. Reset, route the error, keep draining.
      p = Promise.resolve(call());
    } catch (err) {
      this.#busy = false;
      this.#onError(err);
      queueMicrotask(() => this.#drain());
      return;
    }
    // Fire-and-forget from the listener's perspective — the guest's own
    // re-render flows through the mutation channel independently — but a
    // rejection must not become an unhandled rejection.
    p.catch(this.#onError).finally(() => {
      this.#busy = false;
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#disposed) {
      this.#pending.length = 0;
      return;
    }
    // Still in a forbidden window: whichever window closes last continues
    // the chain (the in-flight call's `finally`, or the next `endApply`).
    if (this.#busy || this.#applying) return;
    const next = this.#pending.shift();
    // Exactly one entry: `#enter` sets `#busy`, and its settle chain drains
    // the remainder in FIFO order.
    if (next) next();
  }
}
