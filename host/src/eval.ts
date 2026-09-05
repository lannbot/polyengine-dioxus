// Host side of `polymorph:dioxus/eval` (wit/world.wit, `interface eval`) —
// arbitrary JS evaluation backing dioxus's `document::eval`. OPT-IN: see
// the wit doc comment and `MountOptions.eval` (host.ts) for why this is
// wired only when asked.
//
// Governing docs: wit/world.wit `interface eval` (normative for behavior —
// the async-function-body shape, the JSON both ways, `undefined` -> "null",
// the synchronous-prefix bracket, the error cases, "the host MUST write the
// future"), and .deps/polyengine/contracts/embedder-api.md:
// - "Lowering accepts the natural JS producers" — `stream<T>` accepts a
//   plain `AsyncIterable<T>` of elements; `future<T>` accepts a `Promise<T>`.
//   A tuple lowers as a real JS array of those.
// - "An import whose WIT result type is `future<T>` returns the future
//   source" — a returned Promise is lowered AS the future, not awaited as
//   the call's own completion. This import is `func` (sync), not `async`,
//   so nothing here may return a Promise for the call itself; the promise
//   for the completion result rides inside the returned tuple instead.
// - "Value mapping": `result<T, E>` AS A VALUE (here, nested inside the
//   future) is `{ kind: "ok", value } | { kind: "err", value }` — never a
//   throw, never a rejected promise (a rejected future source is a
//   host-failure-channel fault, not a guest-visible err).
//
// The redesign this file implements retired a subtask-based `Evaluation`
// resource (polyengine#280): a subtask's settlement lands in the microtask
// checkpoint after its export's initial activation returns, which a
// `handle-event` handler awaiting an eval hit every call. Streams and
// futures settle through a different runtime path unaffected by that gap,
// so the `macrotask()` workaround the old resource-based version needed is
// gone along with the resource.

import type { Stream } from "@deltic/protocol";
import type { DispatchGate } from "./dispatch.ts";

/** wit `eval.error` variant payload shapes (contract:"Value mapping",
 * `variant` row: `{ kind, value }`). */
type EvalError =
  | { kind: "invalid-js"; value: string }
  | { kind: "communication"; value: string };

/** wit `result<string, error>` as a VALUE (contract:"Value mapping") —
 * never thrown, never a rejected promise. */
type EvalResult = { kind: "ok"; value: string } | { kind: "err"; value: EvalError };

/**
 * A one-element-at-a-time outgoing channel, exposed only as `AsyncIterable`
 * — one of the "natural JS producers" a `stream<T>` return accepts
 * (contract cited above), so the runtime's own lowering does the pumping
 * and this file needs no component-model stream handle at all for its
 * OUTGOING direction. `push` satisfies the oldest parked reader or queues;
 * `close` ends iteration for good.
 */
class OutChannel {
  #queued: string[] = [];
  #waiting: Array<(r: IteratorResult<string>) => void> = [];
  #closed = false;

  push(v: string): void {
    const w = this.#waiting.shift();
    if (w) w({ value: v, done: false });
    else this.#queued.push(v);
  }

  close(): void {
    this.#closed = true;
    for (const w of this.#waiting.splice(0)) {
      w({ value: undefined, done: true } as IteratorResult<string>);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: (): Promise<IteratorResult<string>> => {
        if (this.#queued.length > 0) {
          return Promise.resolve({ value: this.#queued.shift()!, done: false });
        }
        if (this.#closed) {
          return Promise.resolve({ value: undefined, done: true } as IteratorResult<string>);
        }
        return new Promise((resolve) => this.#waiting.push(resolve));
      },
    };
  }
}

/** `JSON.stringify` returns `undefined` for values it can't represent as a
 * top-level JSON text (a bare `undefined`/function/symbol), which the wit
 * spells as "null" the same as an actual `undefined` return; anything
 * `JSON.stringify` outright THROWS on (a `BigInt`, a cycle) is the wit's
 * "a value could not be represented as JSON", handled by the caller. */
function stringifyOrNull(v: unknown): string {
  return JSON.stringify(v) ?? "null";
}

/**
 * Build the host side of `polymorph:dioxus/eval` — a single sync `eval`
 * function closing over the dispatch gate.
 *
 * Split out as a factory (matching `createDomImports`, host.ts) so `eval`
 * can be unit-tested against a bare `DispatchGate`, with no component in
 * the loop (host/tests/eval_test.ts).
 */
export function createEvalImports(gate: DispatchGate) {
  function evaluate(
    js: string,
    send: Stream<string>,
  ): [AsyncIterable<string>, Promise<EvalResult>] {
    const out = new OutChannel();

    let body: (dioxus: unknown) => Promise<unknown>;
    try {
      // wit: "the script is the BODY of an async function taking one
      // parameter, `dioxus`" (dioxus-desktop's own shape, src/query.rs).
      const AsyncFunction = async function () {}.constructor as new (
        ...args: string[]
      ) => (dioxus: unknown) => Promise<unknown>;
      body = new AsyncFunction("dioxus", js);
    } catch (e) {
      // A SyntaxError constructing the function. wit: the future resolves
      // `err invalid-js` immediately; the returned stream is empty/closed
      // and nothing runs.
      out.close();
      return [out, Promise.resolve({ kind: "err", value: { kind: "invalid-js", value: String(e) } })];
    }

    const dioxusObj = {
      send: (v: unknown) => out.push(stringifyOrNull(v)),
      recv: async () => {
        const chunk = await send.read(1);
        if (chunk.length === 0) return undefined; // guest's writer dropped
        return JSON.parse(chunk[0]);
      },
      // dioxus-web's PROMISE_WRAPPER calls `dioxus.close()` itself, but
      // only from ITS wrapper script, never from user code — this host
      // runs the app's script body directly (no such wrapper), so `close`
      // has no caller and is omitted.
    };

    // wit: "the synchronous prefix ... runs INSIDE this call, on the
    // calling guest's stack — so it is bracketed by the host's dispatch
    // gate like `dom.set-focus` is" (dispatch.ts window 3): this call
    // synchronously runs everything up to the script's first `await`, and
    // that prefix can mutate the DOM / fire delegated events.
    gate.beginApply();
    let p: Promise<unknown>;
    try {
      p = body(dioxusObj);
    } finally {
      gate.endApply();
    }

    // The host MUST write the future (wit doc), even for a script that
    // never completes before the mount tears down — but this promise
    // always eventually settles as long as the script's own promise does
    // (or the process ends first); a script that truly never returns is a
    // hung promise the host cannot do better than.
    //
    // `JSON.stringify` itself can throw (a BigInt, a cycle): the wit's "a
    // value could not be represented as JSON" lands in the same
    // `communication` arm as a throwing script — never a rejected future
    // source, which the contract treats as a host fault.
    //
    // The stream is closed BEFORE the future resolves so the guest can
    // never observe the completion while a value it was sent is still in
    // flight: everything `dioxus.send` pushed is already queued in `out`
    // by the time the script's promise settles, so closing here orders
    // "last value, then end-of-stream, then completion" for the reader.
    const outcome: Promise<EvalResult> = p.then((v) => stringifyOrNull(v)).then(
      (value): EvalResult => {
        out.close();
        return { kind: "ok", value };
      },
      (e): EvalResult => {
        out.close();
        return { kind: "err", value: { kind: "communication", value: "Error running JS: " + e } };
      },
    );

    return [out, outcome];
  }

  return { eval: evaluate };
}
