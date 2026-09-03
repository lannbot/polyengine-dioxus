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

  // 4c) Dispatch a touchstart carrying a populated TouchList-shaped
  // payload. This is the one new payload with a `list<record>`, so it is
  // the mapping the host's hand-written kebab->camelCase convention
  // (host/src/events.ts module doc) is most likely to get wrong — and a
  // misnamed field lowers silently as a default rather than throwing.
  // The fixture's touch summary (module doc "Event summary format")
  // witnesses all three list lengths, every field of `touches[0]`, and the
  // modifiers mask, so a defaulted field shows up as a 0 here.
  const touchPoint = (identifier: number, base: number) => ({
    identifier,
    clientX: base + 0.5,
    clientY: base + 1.5,
    pageX: base + 2.5,
    pageY: base + 3.5,
    screenX: base + 4.5,
    screenY: base + 5.5,
    radiusX: 3.5,
    radiusY: 4.5,
    rotationAngle: 45,
    force: 0.75,
  });
  // Three distinct lengths, so no two of the three lists can be confused
  // for each other: three fingers down, two on the target, one changed.
  const touchStartEvent = {
    type: "touchstart",
    touches: [touchPoint(11, 12), touchPoint(22, 30), touchPoint(33, 50)],
    changedTouches: [touchPoint(33, 50)],
    targetTouches: [touchPoint(11, 12), touchPoint(22, 30)],
    altKey: true,
    shiftKey: true,
  };
  const EXPECTED_TOUCH_SUMMARY =
    "touchstart:touch:3/1/2;11,12.5,13.5,14.5,15.5,16.5,17.5,3.5,4.5,45,0.75;a--s";
  mounted.dispatch(section, "touchstart", touchStartEvent);
  await waitFor(() => root.innerHTML.includes(EXPECTED_TOUCH_SUMMARY), "touchstart summary");
  assertEquals(root.innerHTML.includes(EXPECTED_TOUCH_SUMMARY), true);
  assertEquals(mounted.frameDecoder.pending(), 0);

  assertEquals(errors, [], "no onError callback ever fired");

  mounted.dispose();
});
