// Full-stack host-runtime test: mounts the surface-probe fixture through the
// real translator+runtime instantiation path, and exercises the round trip
// described in fixtures/surface-probe/src/lib.rs's module doc (op sequence +
// event summary format — the authority for the exact assertions below).
//
// Requires `just fixtures` to have built
// fixtures/build/surface-probe.component.wasm first.

import { assertEquals } from "jsr:@std/assert@1";
import { parseHTML } from "linkedom";
import { defaultTranslator } from "@deltic/translator";
import { mountApp } from "../src/host.ts";

const FIXTURE_PATH = "../../fixtures/build/surface-probe.component.wasm";

const EXPECTED_INITIAL_HTML =
  // linkedom's attribute serialization order doesn't preserve insertion
  // order exactly (data-dioxus-id, set last via EventDispatcher.add, comes
  // first here) — asserted as observed rather than fought.
  '<section data-dioxus-id="1" title="probe-section" class="probe">hdrready<!--placeholder--></section>' +
  '<input data-dioxus-id="5">';

async function waitFor(cond: () => boolean, what: string, maxIters = 2000): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    if (cond()) return;
    // Drain a macrotask turn — bounded polling for the guest's async
    // batches to land, per the dispatch's "poll microtasks (bounded)"
    // instruction.
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`waitFor timed out: ${what}`);
}

function makeRoot() {
  const { document } = parseHTML("<!doctype html><html><body><div id=root></div></body></html>");
  const root = document.getElementById("root")!;
  return root;
}

async function loadComponentBytes(path: string): Promise<Uint8Array> {
  const url = new URL(path, import.meta.url);
  try {
    return await Deno.readFile(url);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(
        `fixture component not found at ${url}. Run \`just fixtures\` first ` +
          `(builds fixtures/build/surface-probe.component.wasm).`,
      );
    }
    throw e;
  }
}

Deno.test("fullstack (stream transport): mount, event round trip, ordering", async () => {
  const root = makeRoot();
  const componentBytes = await loadComponentBytes(FIXTURE_PATH);
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

  // 1) Initial mount: poll until the "ready" text has landed, then assert
  // the full expected structure (template clone + attrs + replaced
  // placeholder — see fixture module doc's "DOM built" section).
  await waitFor(() => root.innerHTML.includes("ready"), "initial mount");
  assertEquals(root.innerHTML, EXPECTED_INITIAL_HTML);
  assertEquals(errors, []);

  // 5) The direct-read path decoded the whole delivered view into complete
  // frames — nothing staged.
  assertEquals(mounted.frameDecoder.pending(), 0);

  const section = root.firstElementChild!;
  assertEquals(section.tagName, "SECTION");
  const input = root.lastElementChild!;
  assertEquals(input.tagName, "INPUT");

  // 2/3) Dispatch a click with buttons=7 (the fixture's prevent/stop
  // trigger) and clientX=42: assert the set-text summary AND that
  // preventDefault/stopPropagation were called on the native event.
  let prevented = 0;
  let stopped = 0;
  const clickEvent = {
    type: "click",
    buttons: 7,
    clientX: 42,
    preventDefault: () => prevented++,
    stopPropagation: () => stopped++,
  };
  mounted.dispatch(section, "click", clickEvent);
  await waitFor(() => root.innerHTML.includes("click:mouse:7,42"), "click summary");
  assertEquals(root.innerHTML.includes("click:mouse:7,42"), true);
  assertEquals(prevented, 1, "prevent-default called (buttons === 7)");
  assertEquals(stopped, 1, "stop-propagation called (buttons === 7)");
  assertEquals(mounted.frameDecoder.pending(), 0);

  // 4a) Dispatch input with a value: assert echo.
  const inputEvent = { type: "input", value: "hi there" };
  mounted.dispatch(input, "input", inputEvent);
  await waitFor(() => root.innerHTML.includes("input:form:hi there"), "input summary");

  // 4b) Two events back-to-back: assert both applied IN ORDER (the
  // second dispatched event's summary is the one left standing — both
  // write the same shared "ready" text node, so ordering is observable
  // as "last write wins", never a corrupted interleave).
  const keydownEvent = { type: "keydown", key: "Enter" };
  const clickEvent2 = { ...clickEvent, buttons: 1 }; // != 7: no prevent/stop this time
  mounted.dispatch(section, "keydown", keydownEvent);
  mounted.dispatch(section, "click", clickEvent2);
  await waitFor(() => root.innerHTML.includes("click:mouse:1,42"), "second click summary");
  assertEquals(
    root.innerHTML.includes("keydown:keyboard:Enter"),
    false,
    "the later click's summary replaced the keydown's — no corrupted interleave",
  );

  assertEquals(errors, [], "no onError callback ever fired");

  mounted.dispose();
});
