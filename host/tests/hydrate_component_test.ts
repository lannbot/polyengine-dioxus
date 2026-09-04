// End-to-end hydration: the REAL Dioxus counter example
// (examples/counter/src/lib.rs) adopting its own server-rendered markup.
//
// This is the only place the two halves of hydration meet. src/hydrate.rs's
// walk and host/src/applier.ts's DOM walk are each tested in isolation
// (tests/hydration_order.rs proves the walk emits one id per marker;
// host/tests/hydrate_test.ts proves the applier binds hand-written markers),
// but *correspondence* — that id n really is the node the server numbered n —
// has no meaning until a real component's ids meet a real component's HTML.
// Node identity is the proof: if hydration were quietly re-rendering, every
// assertion below about "the same object" would fail while the visible DOM
// looked perfect.
//
// Requires `just example counter` (the component) and `just ssg-example
// counter` (the prerendered HTML, which the SSG artifact and this test share
// as one golden file).
//
// Assertions are pinned to examples/counter/src/lib.rs — the authority for
// element ids, structure and text — exactly as counter_test.ts is.

import { assertEquals, assertNotStrictEquals, assertStrictEquals } from "jsr:@std/assert@1";
import { parseHTML } from "linkedom";
import { defaultTranslator } from "@deltic/translator";
import { mountApp } from "../src/host.ts";
import type { NativeEventLike } from "../src/events.ts";

const COMPONENT_PATH = "../../examples/build/counter.component.wasm";
const PRERENDERED_PATH = "../../examples/counter/golden.html";

async function waitFor(cond: () => boolean, what: string, maxIters = 2000): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`waitFor timed out: ${what}`);
}

async function readFixture(path: string, recipe: string): Promise<Uint8Array> {
  const url = new URL(path, import.meta.url);
  try {
    return await Deno.readFile(url);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(`fixture not found at ${url}. Run \`${recipe}\` first.`);
    }
    throw e;
  }
}

async function prerenderedHtml(): Promise<string> {
  const bytes = await readFixture(PRERENDERED_PATH, "just ssg-example counter");
  return new TextDecoder().decode(bytes);
}

/** A mount root already holding the server's markup, as a browser would. */
function serverRenderedRoot(html: string) {
  const { document } = parseHTML(
    `<!doctype html><html><body><div id=root>${html}</div></body></html>`,
  );
  return document.getElementById("root")!;
}

function byId(root: Element, id: string): Element {
  const el = root.querySelector(`#${id}`);
  if (!el) throw new Error(`no element with id=${id} in ${root.innerHTML}`);
  return el;
}

function click(): NativeEventLike & { readonly prevented: number } {
  let prevented = 0;
  return {
    type: "click",
    clientX: 0,
    clientY: 0,
    button: 0,
    buttons: 0,
    preventDefault: () => prevented++,
    stopPropagation: () => {},
    get prevented() {
      return prevented;
    },
  };
}

Deno.test("counter example hydrates its own prerendered markup: nodes are adopted, not rebuilt", async () => {
  const html = await prerenderedHtml();
  const root = serverRenderedRoot(html);
  const componentBytes = await readFixture(COMPONENT_PATH, "just example counter");
  const translator = await defaultTranslator();

  // Identities captured BEFORE the component ever runs. Everything this test
  // proves rests on these still being the live nodes afterwards.
  const before = {
    app: root.firstElementChild!,
    count: byId(root, "count"),
    parity: byId(root, "parity"),
    inc: byId(root, "inc"),
    draft: byId(root, "draft"),
    items: Array.from(root.querySelectorAll("#items li")),
  };
  assertEquals(before.count.textContent, "0", "server rendered the initial state");
  assertEquals(before.items.length, 2);

  const errors: unknown[] = [];
  const mounted = await mountApp({
    source: { componentBytes, translator },
    root,
    hydrate: true,
    onError: (err) => errors.push(err),
  });

  // 1) Hydration landed. There is no "mount finished" signal to wait on —
  // in hydrate mode the first batch creates nothing — so wait on the one
  // observable side effect of applying it: the marker comments are consumed.
  await waitFor(() => !root.innerHTML.includes("<!--node-id"), "hydration consumed the text markers");
  assertEquals(errors, [], "hydration reported no mismatch");

  // 2) The adopted nodes are the SAME objects the server's markup produced,
  // and nothing was built alongside them: binding ids while ALSO creating a
  // tree would leave the identities intact and the document doubled.
  assertEquals(root.childElementCount, 1, "hydration created no second tree");
  assertStrictEquals(root.firstElementChild, before.app);
  assertStrictEquals(byId(root, "count"), before.count);
  assertStrictEquals(byId(root, "parity"), before.parity);
  assertStrictEquals(byId(root, "draft"), before.draft);
  assertEquals(Array.from(root.querySelectorAll("#items li")), before.items);

  // 3) Listeners work, which is the half of hydration the id walk does not
  // cover: they arrive as ordinary new-event-listener ops (see
  // MutationWriter::suppress_nodes's divergence note), not from the
  // `,click:1` suffix the host deliberately ignores.
  mounted.dispatch(before.inc, "click", click());
  await waitFor(() => byId(root, "count").textContent === "1", "count increments after click");

  // 4) ...and the re-render MUTATED the adopted nodes rather than replacing
  // them. This is where a wrong id binding would finally show: a set-text
  // against a misbound id updates some other node, leaving #count at "0".
  assertStrictEquals(byId(root, "count"), before.count, "#count survived the re-render");
  assertStrictEquals(byId(root, "parity"), before.parity);
  assertEquals(byId(root, "parity").getAttribute("class"), "odd", "set-attribute hit the right element");
  assertEquals(byId(root, "parity").textContent, "count is 1");

  // 5) The empty dynamic text (`<!--node-id7--><!--#-->` in #echo — the case
  // with no text node to adopt, so the host creates one) accepts text.
  mounted.dispatch(before.draft, "input", { type: "input", value: "hello" });
  await waitFor(() => byId(root, "echo").textContent === "hello", "echo updates on input");

  // 6) Structural mutation against a hydrated subtree: the keyed list grows
  // and shrinks around the adopted <li>s.
  const items = () => Array.from(root.querySelectorAll("#items li")).map((li) => li.textContent);
  const add = byId(root, "add");
  mounted.dispatch(add, "click", click());
  await waitFor(() => items().length === 3, "list grows");
  assertEquals(items(), ["alpha", "beta", "item-0"]);
  assertStrictEquals(root.querySelectorAll("#items li")[0], before.items[0], "existing rows untouched");

  const remove = byId(root, "remove");
  mounted.dispatch(remove, "click", click());
  await waitFor(() => items().length === 2, "list shrinks");
  assertEquals(items(), ["alpha", "beta"]);

  // 7) prevent_default still reaches the guest through the hydrated form.
  const form = byId(root, "form");
  const submit = click();
  mounted.dispatch(form, "submit", { ...submit, type: "submit" });
  await waitFor(
    () => byId(root, "submitted").textContent === "submitted 1 time(s)",
    "submit handled",
  );
  assertEquals(submit.prevented, 1, "prevent-default called by onsubmit handler");

  assertEquals(errors, [], "no onError callback ever fired");
  mounted.dispose();
});

Deno.test("hydration mismatch is reported, not repaired", async () => {
  // Build skew, minimally expressed: one element marker removed from
  // otherwise-correct markup. The guest still emits an id for it, so the
  // host finds an index nothing matched. wit/world.wit's `hydrate` doc makes
  // this an error rather than a fallback — a silent fresh re-render would
  // hide the skew and double the document.
  const html = (await prerenderedHtml()).replace(' data-node-hydration="1,click:1"', "");
  const root = serverRenderedRoot(html);
  const componentBytes = await readFixture(COMPONENT_PATH, "just example counter");
  const translator = await defaultTranslator();

  const errors: unknown[] = [];
  const mounted = await mountApp({
    source: { componentBytes, translator },
    root,
    hydrate: true,
    onError: (err) => errors.push(err),
  });

  await waitFor(() => errors.length > 0, "mismatch surfaced through onError");
  assertEquals(errors.length, 1);
  const message = String(errors[0]);
  assertStrictEquals(
    message.includes("never matched"),
    true,
    `expected an unmatched-index error, got: ${message}`,
  );

  mounted.dispose();
});

Deno.test("fresh mode is unaffected: an empty root still builds new nodes", async () => {
  // The control for the identity assertions above. Same component, same
  // assertions in spirit, but mounted the ordinary way into an empty root:
  // the nodes it ends up with are necessarily new ones, so "same object"
  // above is a property of hydration and not of the test's plumbing.
  const html = await prerenderedHtml();
  const detached = serverRenderedRoot(html);
  const serverCount = byId(detached, "count");

  const root = serverRenderedRoot("");
  const componentBytes = await readFixture(COMPONENT_PATH, "just example counter");
  const translator = await defaultTranslator();

  const errors: unknown[] = [];
  const mounted = await mountApp({
    source: { componentBytes, translator },
    root,
    onError: (err) => errors.push(err),
  });

  await waitFor(() => root.querySelector("#count") !== null, "fresh mount built the tree");
  assertNotStrictEquals(byId(root, "count"), serverCount);
  assertEquals(byId(root, "count").textContent, "0");
  assertEquals(errors, []);

  mounted.dispose();
});
