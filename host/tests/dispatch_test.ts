import { assertEquals } from "jsr:@std/assert@1";
import { DispatchGate } from "../src/dispatch.ts";

/** Let the microtask queue (and a macrotask turn) fully settle. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** A gate plus the errors it routed. */
function makeGate() {
  const errors: unknown[] = [];
  const gate = new DispatchGate((err) => errors.push(err));
  return { gate, errors };
}

/** A deferred whose resolve/reject the test drives. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Pre-attached handler keeps a rejection from being "unhandled" between
  // reject() and the gate's own catch in the reject-path test.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

Deno.test("idle dispatch enters synchronously", () => {
  const { gate } = makeGate();
  let ran = false;
  gate.dispatch(() => {
    ran = true;
  });
  assertEquals(ran, true);
});

Deno.test("dispatch during the apply window is deferred to a microtask", async () => {
  const { gate } = makeGate();
  const order: string[] = [];

  gate.beginApply();
  gate.dispatch(() => order.push("call"));
  assertEquals(order, []); // not synchronous
  gate.endApply();
  assertEquals(order, []); // not inline in endApply either

  await settle();
  assertEquals(order, ["call"]);
});

Deno.test("dispatches while busy queue and replay in FIFO order", async () => {
  const { gate } = makeGate();
  const order: string[] = [];
  const first = deferred();

  gate.dispatch(() => {
    order.push("a");
    return first.promise;
  });
  assertEquals(order, ["a"]);

  gate.dispatch(() => order.push("b"));
  gate.dispatch(() => order.push("c"));
  gate.dispatch(() => order.push("d"));
  assertEquals(order, ["a"]); // all three held behind the in-flight call

  first.resolve();
  await settle();
  assertEquals(order, ["a", "b", "c", "d"]);
});

Deno.test("a synchronous throw routes to onError without wedging the gate", async () => {
  const { gate, errors } = makeGate();
  const order: string[] = [];
  const boom = new Error("lowering failed");

  gate.beginApply();
  gate.dispatch(() => {
    order.push("thrower");
    throw boom;
  });
  gate.dispatch(() => order.push("after"));
  gate.endApply();

  await settle();
  assertEquals(order, ["thrower", "after"]);
  assertEquals(errors, [boom]);
});

Deno.test("a rejected promise routes to onError and the chain continues", async () => {
  const { gate, errors } = makeGate();
  const order: string[] = [];
  const first = deferred();

  gate.dispatch(() => {
    order.push("rejector");
    return first.promise;
  });
  gate.dispatch(() => order.push("after"));

  first.reject("nope");
  await settle();
  assertEquals(order, ["rejector", "after"]);
  assertEquals(errors, ["nope"]);
});

Deno.test("dispose drops queued entries and makes dispatch a no-op", async () => {
  const { gate } = makeGate();
  const order: string[] = [];

  gate.beginApply();
  gate.dispatch(() => order.push("queued"));
  gate.endApply();
  gate.dispose();

  gate.dispatch(() => order.push("post-dispose"));

  await settle();
  assertEquals(order, []);
});

Deno.test("an entry queued while both busy and applying waits for both windows", async () => {
  const { gate } = makeGate();
  const order: string[] = [];
  const first = deferred();

  gate.dispatch(() => {
    order.push("inflight");
    return first.promise;
  });
  assertEquals(order, ["inflight"]);

  gate.beginApply();
  gate.dispatch(() => order.push("queued"));

  // In-flight call settles, but the apply window is still open.
  first.resolve();
  await settle();
  assertEquals(order, ["inflight"]);

  gate.endApply();
  await settle();
  assertEquals(order, ["inflight", "queued"]);
});

Deno.test("apply window closing while a call is in flight does not double-enter", async () => {
  const { gate } = makeGate();
  const order: string[] = [];
  const first = deferred();

  gate.dispatch(() => {
    order.push("inflight");
    return first.promise;
  });
  gate.beginApply();
  gate.dispatch(() => order.push("queued"));
  gate.endApply();

  // endApply's drain must see #busy and back off.
  await settle();
  assertEquals(order, ["inflight"]);

  first.resolve();
  await settle();
  assertEquals(order, ["inflight", "queued"]);
});

Deno.test("a reentrant dispatch from inside a running call is deferred", async () => {
  const { gate } = makeGate();
  const order: string[] = [];
  const first = deferred();

  gate.dispatch(() => {
    order.push("outer");
    // Exactly the native-event-fired-by-a-mutation case: the listener
    // dispatches while this very call is on the stack.
    gate.dispatch(() => order.push("reentrant"));
    assertEquals(order, ["outer"]);
    return first.promise;
  });

  assertEquals(order, ["outer"]);
  first.resolve();
  await settle();
  assertEquals(order, ["outer", "reentrant"]);
});
