// Host side of `polymorph:dioxus/eval` (wit/world.wit, `interface eval`) —
// arbitrary JS evaluation backing dioxus's `document::eval`. OPT-IN: see
// the wit doc comment and `MountOptions.eval` (host.ts) for why this is
// wired only when asked.
//
// Governing docs: wit/world.wit `interface eval` (normative for behavior —
// the async-function-body shape, the JSON both ways, `undefined` -> "null",
// the constructor's synchronous-prefix bracket, the error cases), and
// .deps/polyengine/contracts/embedder-api.md "Error model" (host import
// with `result<T, E>` throws `ComponentException`, never a bare value) and
// "Resources" (host-implemented resource = plain class; WIT constructor =
// JS constructor). Cited inline as `contract:<section>`.

import { ComponentException } from "@deltic/protocol";
import type { DispatchGate } from "./dispatch.ts";

/** wit `eval.error` variant payload shapes (contract:"Value mapping",
 * `variant` row: `{ kind, value }`, `value` absent for payloadless cases). */
type EvalError =
  | { kind: "invalid-js"; value: string }
  | { kind: "communication"; value: string }
  | { kind: "finished" };

const FINISHED: EvalError = { kind: "finished" };

/** Sentinel `recv()` result meaning "the script has completed and no more
 * values are coming" — used only to let `recv` race a queued value against
 * completion without leaking a permanently-parked waiter's identity. */
const DONE = Symbol("eval-channel-done");

// WORKAROUND for a polyengine runtime liveness gap (see
// .deps/polyengine/runtime/src/exec/boundary.ts, "The settlement pump:
// liveness between export calls"). `recv`/`join` are async host imports; if
// the guest calls one from an export's INITIAL activation (its very first
// callback, before any earlier park) and the returned promise settles in
// the microtask checkpoint right after that activation returns
// `task.return`, the export's driver has already exited (`EXIT-done`) with
// no settlement pump armed to drive the store, and the guest's callback is
// never resumed. Observed matrix: a script that settles synchronously, or
// after `await null`, reproduces the hang; a script that settles after a
// real macrotask (`setTimeout(r, 0)`) does not — by then the export call
// has been outstanding across a macrotask boundary, so the pump is armed
// and drives resumption when the promise settles. `use_future`'s eval calls
// happen to dodge this (they start inside a later callback, past the
// first stream-write park), but `handle-event`'s own initial activation
// does not, so a `document::eval(...).join()` awaited straight from a
// dioxus event handler hits it directly. Forcing every settlement here to
// cross at least one real macrotask sidesteps the gap unconditionally, at
// the cost of one macrotask of latency per `recv`/`join` resolution. This
// comes out once polyengine's driver arms the pump for calls settling in
// this window, tracked upstream — not a permanent fixture of this API.
const macrotask = () => new Promise<void>((r) => setTimeout(r, 0));

/** A single-type mailbox: `push` either satisfies the oldest pending
 * waiter or queues the value; `next` returns a queued value immediately or
 * parks a waiter. Never both queues non-empty at once. `finish` resolves
 * every currently-parked waiter (and all future `next()` calls, since
 * nothing more will ever be pushed) with `DONE`. */
class Channel<T> {
  #queued: T[] = [];
  #waiting: Array<(v: T | typeof DONE) => void> = [];
  #finished = false;

  push(v: T): void {
    const w = this.#waiting.shift();
    if (w) w(v);
    else this.#queued.push(v);
  }

  next(): Promise<T | typeof DONE> {
    if (this.#queued.length > 0) return Promise.resolve(this.#queued.shift()!);
    if (this.#finished) return Promise.resolve(DONE);
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  finish(): void {
    this.#finished = true;
    for (const w of this.#waiting.splice(0)) w(DONE);
  }
}

/**
 * Build the host side of `polymorph:dioxus/eval` — a single `Evaluation`
 * resource class closing over the dispatch gate.
 *
 * Split out as a factory (matching `createDomImports`, host.ts) so
 * `Evaluation` can be unit-tested against a bare `DispatchGate`, with no
 * component in the loop (host/tests/eval_test.ts).
 */
export function createEvalImports(gate: DispatchGate) {
  class Evaluation {
    /** Values the script sends via `dioxus.send`, waiting for the guest's
     * `recv`. Finished once the script's promise settles: nothing more
     * will ever be pushed. */
    #jsToRust = new Channel<string>();
    /** Values the guest sends via `Evaluation.send`, waiting for the
     * script's `await dioxus.recv()`. */
    #rustToJs = new Channel<unknown>();
    /** Settled once the script's promise settles — never a live rejected
     * promise, so nothing here becomes an unhandled rejection. */
    #outcome: Promise<{ ok: string } | { err: EvalError }>;
    /** `join` a second time reports `finished` (wit doc: one of the two
     * ways to reach it); flips once the first `join` observes `#outcome`. */
    #joined = false;

    constructor(js: string) {
      let body: (dioxus: unknown) => Promise<unknown>;
      let ctorError: EvalError | undefined;
      try {
        // wit: "the script is the BODY of an async function taking one
        // parameter, `dioxus`" (dioxus-desktop's own shape, src/query.rs).
        const AsyncFunction = async function () {}.constructor as new (
          ...args: string[]
        ) => (dioxus: unknown) => Promise<unknown>;
        body = new AsyncFunction("dioxus", js);
      } catch (e) {
        // A SyntaxError constructing the function. wit: "a constructor
        // cannot fail" — remembered as the join outcome, not thrown here
        // (a throw from a host resource constructor is a trap, and the
        // WIT constructor has no result type).
        ctorError = { kind: "invalid-js", value: String(e) };
        body = () => Promise.resolve(undefined);
      }

      const dioxusObj = {
        send: (v: unknown) => this.#jsToRust.push(JSON.stringify(v) ?? "null"),
        recv: async () => {
          const v = await this.#rustToJs.next();
          return v === DONE ? undefined : v;
        },
        // dioxus-web's PROMISE_WRAPPER calls `dioxus.close()` itself, but
        // only from ITS wrapper script, never from user code — this host
        // runs the app's script body directly (no such wrapper), so
        // `close` has no caller and is omitted.
      };

      if (ctorError) {
        this.#outcome = Promise.resolve({ err: ctorError });
        this.#jsToRust.finish();
      } else {
        // wit: "the synchronous prefix ... runs INSIDE the constructor, on
        // the calling guest's stack — so it is bracketed by the host's
        // dispatch gate like `dom.set-focus` is" (dispatch.ts window 3):
        // this call synchronously runs everything up to the script's
        // first `await`, and that prefix can mutate the DOM / fire
        // delegated events.
        gate.beginApply();
        let p: Promise<unknown>;
        try {
          p = body(dioxusObj);
        } finally {
          gate.endApply();
        }
        // `JSON.stringify` itself can throw (a BigInt, a cycle): that is the
        // wit's "a value could not be represented as JSON", so it lands in
        // the same `communication` arm as a throwing script rather than
        // rejecting `#outcome` with an unbranded error (which the runtime
        // would turn into a trap — contract:"Error model").
        this.#outcome = p.then((v) => JSON.stringify(v) ?? "null").then(
          (ok) => ({ ok }),
          (e) => ({
            err: { kind: "communication", value: "Error running JS: " + e } as EvalError,
          }),
        );
        // Whichever way it settles, nothing more will ever cross via
        // `dioxus.send` — unblock any `recv` still parked.
        this.#outcome.then(() => this.#jsToRust.finish());
      }
    }

    send(json: string): void {
      this.#rustToJs.push(JSON.parse(json));
    }

    async recv(): Promise<string> {
      const v = await this.#jsToRust.next();
      await macrotask();
      if (v === DONE) throw new ComponentException(FINISHED);
      return v;
    }

    async join(): Promise<string> {
      if (this.#joined) throw new ComponentException(FINISHED);
      this.#joined = true;
      const r = await this.#outcome;
      await macrotask();
      if ("err" in r) throw new ComponentException(r.err);
      return r.ok;
    }
  }

  return { Evaluation };
}
