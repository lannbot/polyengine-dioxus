// A one-element-at-a-time outgoing channel, exposed only as `AsyncIterable`
// — one of the "natural JS producers" a component-model `stream<T>` return
// accepts (.deps/polyengine/contracts/embedder-api.md "Lowering accepts the
// natural JS producers"), so the runtime's own lowering does the pumping
// and callers need no component-model stream handle at all for their
// OUTGOING direction. `push` satisfies the oldest parked reader or queues;
// `close` ends iteration for good.
//
// Shared by eval.ts (the script's `dioxus.send` channel) and history.ts
// (the `changes` stream) — extracted rather than duplicated.
export class OutChannel<T> {
  #queued: T[] = [];
  #waiting: Array<(r: IteratorResult<T>) => void> = [];
  #closed = false;

  push(v: T): void {
    const w = this.#waiting.shift();
    if (w) w({ value: v, done: false });
    else this.#queued.push(v);
  }

  close(): void {
    this.#closed = true;
    for (const w of this.#waiting.splice(0)) {
      w({ value: undefined, done: true } as IteratorResult<T>);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.#queued.length > 0) {
          return Promise.resolve({ value: this.#queued.shift()!, done: false });
        }
        if (this.#closed) {
          return Promise.resolve({ value: undefined, done: true } as IteratorResult<T>);
        }
        return new Promise((resolve) => this.#waiting.push(resolve));
      },
    };
  }
}

/** An already-closed channel: iterating it ends immediately. Used for
 * `eval`'s denied path and `history.changes`'s second-call closed stream. */
export function closedChannel<T>(): AsyncIterable<T> {
  const c = new OutChannel<T>();
  c.close();
  return c;
}
