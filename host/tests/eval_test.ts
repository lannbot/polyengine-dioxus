// Unit coverage for the host side of `polymorph:dioxus/eval`
// (wit/world.wit `interface eval`), driven directly against
// `createEvalImports` + a bare `DispatchGate` — no component, no
// instantiation (mirrors host_dom_test.ts's approach for `dom`).
//
// The `send` parameter's real-world shape is a lifted `Stream<string>`
// (contracts/embedder-api.md: "Lifted stream<T>/future<T> values arrive as
// Stream<T>/Future<T>"), already bound by the lift step. There is no
// component boundary here to do that binding, and the runtime's own
// `Stream.create()` parks forever on an operation until one binds it
// (streams.ts: "a stream created and written but never passed anywhere
// simply never completes") — so a bare fake implementing only the one
// method `evaluate` actually calls (`read`) stands in for it.
import { assertEquals } from "jsr:@std/assert@1";
import type { Stream } from "@deltic/protocol";
import { DispatchGate } from "../src/dispatch.ts";
import { createEvalImports } from "../src/eval.ts";

function setup() {
  const errors: unknown[] = [];
  const gate = new DispatchGate((e) => errors.push(e));
  const { eval: evaluate } = createEvalImports(gate);
  return { gate, evaluate, errors };
}

/** A minimal `Stream<string>` fake backed by a plain queue: enough for
 * `evaluate`'s one call, `read(max)`. Not a real component-model handle. */
function fakeStream(initial: string[] = []): {
  stream: Stream<string>;
  push(v: string): void;
} {
  const queue = [...initial];
  const stream = {
    read: (max: number) => Promise.resolve(queue.splice(0, max)),
  } as unknown as Stream<string>;
  return { stream, push: (v: string) => queue.push(v) };
}

async function collect(s: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const v of s) out.push(v);
  return out;
}

Deno.test("eval: a returning script's future resolves ok with its JSON-stringified value", async () => {
  const { evaluate } = setup();
  const [stream, future] = evaluate("return 1 + 1", fakeStream().stream);
  assertEquals(await future, { kind: "ok", value: "2" });
  assertEquals(await collect(stream), []);
});

Deno.test("eval: a script with no return resolves ok 'null' (wit: undefined -> \"null\")", async () => {
  const { evaluate } = setup();
  const [, future] = evaluate("// no return", fakeStream().stream);
  assertEquals(await future, { kind: "ok", value: "null" });
});

Deno.test("eval: a script that fails to compile resolves err invalid-js immediately, stream closed", async () => {
  const { evaluate } = setup();
  const [stream, future] = evaluate("this is not valid js at all (((", fakeStream().stream);
  const r = await future;
  assertEquals(r.kind, "err");
  assertEquals((r as { kind: "err"; value: { kind: string } }).value.kind, "invalid-js");
  assertEquals(await collect(stream), []);
});

Deno.test("eval: a script that throws resolves err communication", async () => {
  const { evaluate } = setup();
  const [, future] = evaluate("throw new Error('boom');", fakeStream().stream);
  const r = await future;
  assertEquals(r.kind, "err");
  assertEquals((r as { kind: "err"; value: { kind: string } }).value.kind, "communication");
});

Deno.test("eval: a BigInt return value (unJSONable) resolves err communication", async () => {
  const { evaluate } = setup();
  const [, future] = evaluate("return 1n;", fakeStream().stream);
  const r = await future;
  assertEquals(r.kind, "err");
  assertEquals((r as { kind: "err"; value: { kind: string } }).value.kind, "communication");
});

Deno.test("eval: send/recv round trip through dioxus.recv/dioxus.send, then the stream closes", async () => {
  const { evaluate } = setup();
  const { stream: send, push } = fakeStream();
  push("21");
  const [stream, future] = evaluate(
    "const x = await dioxus.recv(); dioxus.send(x * 2); return 'ok';",
    send,
  );

  const it = stream[Symbol.asyncIterator]();
  const first = await it.next();
  assertEquals(first, { value: "42", done: false });

  assertEquals(await future, { kind: "ok", value: '"ok"' });

  // Completion closes the outgoing stream.
  const after = await it.next();
  assertEquals(after.done, true);
});

Deno.test("eval: the script's synchronous prefix runs before `evaluate` returns", () => {
  const { evaluate } = setup();
  try {
    // wit: "everything before the script's first `await` runs INSIDE this
    // call". Observable independent of any gate bracket: `__t` must
    // already be set the instant `evaluate` returns.
    evaluate("globalThis.__evalSyncPrefix = 1; return 2;", fakeStream().stream);
    assertEquals((globalThis as Record<string, unknown>).__evalSyncPrefix, 1);
  } finally {
    delete (globalThis as Record<string, unknown>).__evalSyncPrefix;
  }
});
