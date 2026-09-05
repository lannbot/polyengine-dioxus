// Unit coverage for the host side of `polymorph:dioxus/eval`
// (wit/world.wit `interface eval`), driven directly against
// `createEvalImports` + a bare `DispatchGate` — no component, no
// instantiation (mirrors host_dom_test.ts's approach for `dom`).

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { ComponentException } from "@deltic/protocol";
import { DispatchGate } from "../src/dispatch.ts";
import { createEvalImports } from "../src/eval.ts";

function setup() {
  const errors: unknown[] = [];
  const gate = new DispatchGate((e) => errors.push(e));
  const { Evaluation } = createEvalImports(gate);
  return { gate, Evaluation, errors };
}

Deno.test("eval: a returning script joins with its JSON-stringified value", async () => {
  const { Evaluation } = setup();
  const e = new Evaluation("return 1 + 1");
  assertEquals(await e.join(), "2");
});

Deno.test("eval: a script with no return joins 'null' (wit: undefined -> \"null\")", async () => {
  const { Evaluation } = setup();
  const e = new Evaluation("// no return");
  assertEquals(await e.join(), "null");
});

Deno.test("eval: a script that fails to compile joins rejected with kind invalid-js", async () => {
  const { Evaluation } = setup();
  const e = new Evaluation("this is not valid js at all (((");
  const err = await assertRejects(() => e.join(), ComponentException);
  assertEquals((err.payload as { kind: string }).kind, "invalid-js");
});

Deno.test("eval: a script that throws joins rejected with kind communication", async () => {
  const { Evaluation } = setup();
  const e = new Evaluation("throw new Error('boom');");
  const err = await assertRejects(() => e.join(), ComponentException);
  assertEquals((err.payload as { kind: string }).kind, "communication");
});

Deno.test("eval: send/recv round trip through dioxus.recv/dioxus.send", async () => {
  const { Evaluation } = setup();
  const e = new Evaluation("const x = await dioxus.recv(); dioxus.send(x * 2); return 'ok';");
  e.send("21");
  assertEquals(await e.recv(), "42");
  assertEquals(await e.join(), "\"ok\"");
});

Deno.test("eval: recv after completion with an empty queue reports finished", async () => {
  const { Evaluation } = setup();
  const e = new Evaluation("return 1;");
  await e.join();
  const err = await assertRejects(() => e.recv(), ComponentException);
  assertEquals((err.payload as { kind: string }).kind, "finished");
});

Deno.test("eval: a second join reports finished", async () => {
  const { Evaluation } = setup();
  const e = new Evaluation("return 1;");
  assertEquals(await e.join(), "1");
  const err = await assertRejects(() => e.join(), ComponentException);
  assertEquals((err.payload as { kind: string }).kind, "finished");
});

Deno.test("eval: recv still parked when the script completes also reports finished", async () => {
  const { Evaluation } = setup();
  // Never sends; `recv()`'s await is still pending when the script's
  // `return` settles the outcome.
  const e = new Evaluation("return 1;");
  const err = await assertRejects(() => e.recv(), ComponentException);
  assertEquals((err.payload as { kind: string }).kind, "finished");
  assertEquals(await e.join(), "1");
});

Deno.test("eval: the constructor's synchronous prefix runs before `new` returns", () => {
  const { Evaluation } = setup();
  try {
    // wit: "everything before the script's first `await` runs INSIDE the
    // constructor". Observable independent of any gate bracket: `__t` must
    // already be set the instant `new Evaluation` returns.
    new Evaluation("globalThis.__evalSyncPrefix = 1; return 2;");
    assertEquals((globalThis as Record<string, unknown>).__evalSyncPrefix, 1);
  } finally {
    delete (globalThis as Record<string, unknown>).__evalSyncPrefix;
  }
});

Deno.test("eval: a return value JSON cannot represent joins rejected with kind communication", async () => {
  const { Evaluation } = setup();
  const e = new Evaluation("return 1n;");
  const err = await assertRejects(() => e.join(), ComponentException);
  assertEquals((err.payload as { kind: string }).kind, "communication");
});
