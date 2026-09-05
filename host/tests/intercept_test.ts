// Unit coverage for `wrap` (host/src/intercept.ts) — the interceptor
// mechanism shared by every host import fragment. No DOM, no component.

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { wrap } from "../src/intercept.ts";

interface Ops {
  add(a: number, b: number): number;
  greet(name: string): string;
  // deno-lint-ignore no-explicit-any
  [key: string]: (...args: any[]) => any;
}

function impls(): Ops {
  return {
    add: (a, b) => a + b,
    greet: (name) => `hi ${name}`,
  };
}

Deno.test("wrap: with no interceptors, returns the same table (identity)", () => {
  const table = impls();
  assertEquals(wrap(table, undefined), table);
});

Deno.test("wrap: an op without an interceptor passes through untouched (same function identity)", () => {
  const table = impls();
  const wrapped = wrap(table, { add: (next, a, b) => next(a, b) });
  assertEquals(wrapped.greet, table.greet);
});

Deno.test("wrap: the interceptor receives `next` plus the call's arguments", () => {
  const calls: unknown[] = [];
  const table = impls();
  const wrapped = wrap(table, {
    add(next, a, b) {
      calls.push([a, b]);
      return next(a, b);
    },
  });
  assertEquals(wrapped.add(2, 3), 5);
  assertEquals(calls, [[2, 3]]);
});

Deno.test("wrap: an interceptor can rewrite arguments before calling next", () => {
  const table = impls();
  const wrapped = wrap(table, {
    greet: (next, name) => next(name.toUpperCase()),
  });
  assertEquals(wrapped.greet("ada"), "hi ADA");
});

Deno.test("wrap: an interceptor can skip `next` entirely and answer its own value", () => {
  const table = impls();
  const wrapped = wrap(table, {
    add: () => -1,
  });
  assertEquals(wrapped.add(2, 3), -1);
});

Deno.test("wrap: an interceptor can answer a denial value without calling next", () => {
  const table = impls();
  const wrapped = wrap(table, {
    greet: () => "denied",
  });
  assertEquals(wrapped.greet("ada"), "denied");
});

Deno.test("wrap: an interceptor keyed to an unknown operation throws", () => {
  const table = impls();
  // deno-lint-ignore no-explicit-any
  const bogus = { nope: () => {} } as any;
  assertThrows(() => wrap(table, bogus), Error, "no such operation");
});
