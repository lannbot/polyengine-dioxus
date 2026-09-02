// Full-stack host-runtime test for the REAL Dioxus counter example
// (examples/counter/src/lib.rs, launch! uses the stream transport, the only
// transport). This
// exercises the whole pipeline: driver.rs (run/handle-event tasks),
// writer.rs (mutation batching), events.rs (payload conversion), and the
// host-side applier/dispatcher/decoder — none of which had ever executed
// end to end before this test existed.
//
// Requires `just example counter` to have built
// examples/build/counter.component.wasm first.
//
// Assertions are pinned to the actual markup in
// examples/counter/src/lib.rs — the authority for element ids, structure,
// and text content asserted below.

import { assertEquals } from "jsr:@std/assert@1";
import { parseHTML } from "linkedom";
import { defaultTranslator } from "@deltic/translator";
import { mountApp } from "../src/host.ts";

const COMPONENT_PATH = "../../examples/build/counter.component.wasm";

async function waitFor(cond: () => boolean, what: string, maxIters = 2000): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    if (cond()) return;
    // Bounded microtask/timeout polling: the run task's post-event render
    // can land via either the run loop's own wakeup or handle-event's own
    // render-and-flush, so a single microtask drain isn't enough — poll a
    // macrotask turn like fullstack_test.ts does.
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`waitFor timed out: ${what}`);
}

function makeRoot() {
  const { document } = parseHTML("<!doctype html><html><body><div id=root></div></body></html>");
  const root = document.getElementById("root")!;
  return root;
}

async function loadComponentBytes(): Promise<Uint8Array> {
  const url = new URL(COMPONENT_PATH, import.meta.url);
  try {
    return await Deno.readFile(url);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(
        `component not found at ${url}. Run \`just example counter\` first ` +
          `(builds examples/build/counter.component.wasm).`,
      );
    }
    throw e;
  }
}

function byId(root: Element, id: string): Element {
  const el = root.querySelector(`#${id}`);
  if (!el) throw new Error(`no element with id=${id} in ${root.innerHTML}`);
  return el;
}

interface TrackedEvent {
  type: string;
  clientX: number;
  clientY: number;
  button: number;
  buttons: number;
  preventDefault(): void;
  stopPropagation(): void;
  readonly prevented: number;
  readonly stopped: number;
}

function click(target: Element): TrackedEvent {
  void target;
  let prevented = 0;
  let stopped = 0;
  return {
    type: "click",
    clientX: 0,
    clientY: 0,
    button: 0,
    buttons: 0,
    preventDefault: () => prevented++,
    stopPropagation: () => stopped++,
    get prevented() {
      return prevented;
    },
    get stopped() {
      return stopped;
    },
  };
}

Deno.test("counter example: mount, click, type, list, form submit", async () => {
  const root = makeRoot();
  const componentBytes = await loadComponentBytes();
  const translator = await defaultTranslator();

  const errors: unknown[] = [];
  // Untranslated form of `InstantiateSource` (embedder-api.md A3): this is
  // a Deno test, not a deploy, so translating in-process keeps it
  // independent of `just example`'s envelope step — and exercises the arm
  // of `InstantiateSource` the harness/Pages build (A4 envelope) doesn't.
  const mounted = await mountApp({
    source: { componentBytes, translator },
    root,
    onError: (err) => errors.push(err),
  });

  // 1) Initial mount: count is 0, parity is "even", echo is empty, list has
  // the two seeded items ("alpha", "beta"), submitted count is 0.
  await waitFor(() => root.querySelector("#count") !== null, "initial mount");
  assertEquals(byId(root, "count").textContent, "0");
  assertEquals(byId(root, "parity").getAttribute("class"), "even");
  assertEquals(byId(root, "parity").textContent, "count is 0");
  assertEquals(byId(root, "echo").textContent, "");
  const items = () => Array.from(root.querySelectorAll("#items li")).map((li) => li.textContent);
  assertEquals(items(), ["alpha", "beta"]);
  assertEquals(byId(root, "submitted").textContent, "submitted 0 time(s)");
  assertEquals(errors, []);

  // 2) +/- buttons.
  const inc = byId(root, "inc");
  const dec = byId(root, "dec");

  mounted.dispatch(inc, "click", click(inc));
  await waitFor(() => byId(root, "count").textContent === "1", "count after first inc");
  assertEquals(byId(root, "parity").getAttribute("class"), "odd", "parity flips to odd on set-attribute");
  assertEquals(byId(root, "parity").textContent, "count is 1");

  mounted.dispatch(inc, "click", click(inc));
  await waitFor(() => byId(root, "count").textContent === "2", "count after second inc");
  assertEquals(byId(root, "parity").getAttribute("class"), "even");

  mounted.dispatch(dec, "click", click(dec));
  await waitFor(() => byId(root, "count").textContent === "1", "count after dec");
  assertEquals(byId(root, "parity").getAttribute("class"), "odd");

  // 3) Type in the input: echoed paragraph updates.
  const draft = byId(root, "draft");
  mounted.dispatch(draft, "input", { type: "input", value: "hello" });
  await waitFor(() => byId(root, "echo").textContent === "hello", "echo updates on input");
  assertEquals((draft as unknown as { value?: string }).value ?? draft.getAttribute("value"), "hello");

  // 4) List add/remove: assert order.
  const add = byId(root, "add");
  const remove = byId(root, "remove");

  mounted.dispatch(add, "click", click(add));
  await waitFor(() => items().length === 3, "list grows after add");
  assertEquals(items(), ["alpha", "beta", "item-0"]);

  mounted.dispatch(add, "click", click(add));
  await waitFor(() => items().length === 4, "list grows again after add");
  assertEquals(items(), ["alpha", "beta", "item-0", "item-1"]);

  mounted.dispatch(remove, "click", click(remove));
  await waitFor(() => items().length === 3, "list shrinks after remove");
  assertEquals(items(), ["alpha", "beta", "item-0"]);

  // 5) Form submit: preventDefault must have been called by the app's
  // `e.prevent_default()` in onsubmit, and the submitted counter increments.
  const form = byId(root, "form");
  const submitEvent = click(form);
  // Reuse the click() helper's preventDefault/stopPropagation tracking, but
  // dispatch as a submit event.
  mounted.dispatch(form, "submit", { ...submitEvent, type: "submit" });
  await waitFor(() => byId(root, "submitted").textContent === "submitted 1 time(s)", "submit handled");
  assertEquals(submitEvent.prevented, 1, "prevent-default called by onsubmit handler");

  // 6) No stray errors throughout.
  assertEquals(errors, [], "no onError callback ever fired");

  mounted.dispose();

  // 7) After dispose the runtime is detached: a further dispatch changes
  // nothing and surfaces no error. Dropping the mutation stream's read end
  // RESOLVES the parked direct-read session (embedder-api.md A21's
  // reader-drop rule) rather than rejecting it, so `onError` stays silent;
  // the guest sees reader-gone on its next write and goes dark.
  const before = root.innerHTML;
  const postDispose = click(inc);
  mounted.dispatch(inc, "click", postDispose);
  // Settle the same way the file's waitFor does — a macrotask turn is
  // enough for a queued dispatch or a stream rejection to land.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(root.innerHTML, before, "no DOM change after dispose");
  assertEquals(errors, [], "dispose surfaces no error");

  // 8) dispose is idempotent.
  mounted.dispose();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(errors, []);
});
