// Full-stack host-runtime test for the `eval` fixture
// (fixtures/eval-probe/src/lib.rs — the authority for markup and behavior),
// exercising `MountOptions.eval` end to end: fire-and-forget eval, a
// recv/send round trip, join, and both error paths (a throwing script and
// a script that fails to compile). Requires `just fixtures` to have built
// fixtures/build/eval-probe.component.wasm first.

import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { parseHTML } from "linkedom";
import { defaultTranslator } from "@deltic/translator";
import { mountApp } from "../src/host.ts";

const FIXTURE_PATH = "../../fixtures/build/eval-probe.component.wasm";

async function waitFor(cond: () => boolean, what: string, maxIters = 2000): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    if (cond()) return;
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
  const url = new URL(FIXTURE_PATH, import.meta.url);
  try {
    return await Deno.readFile(url);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(
        `component not found at ${url}. Run \`just fixtures\` first ` +
          `(builds fixtures/build/eval-probe.component.wasm).`,
      );
    }
    throw e;
  }
}

function click(target: Element): { type: string; preventDefault(): void; stopPropagation(): void } {
  void target;
  return {
    type: "click",
    preventDefault() {},
    stopPropagation() {},
  };
}

Deno.test("eval fixture: fire-and-forget eval, a recv/send/join round trip, and both error paths", async () => {
  const root = makeRoot();
  const componentBytes = await loadComponentBytes();
  const translator = await defaultTranslator();
  const errors: unknown[] = [];

  try {
    const mounted = await mountApp({
      source: { componentBytes, translator },
      root,
      eval: true,
      onError: (err) => errors.push(err),
    });

    const recv = () => root.querySelector(".recv")!;
    const join = () => root.querySelector(".join")!;

    await waitFor(() => join()?.textContent === "done-41", "initial join");
    assertEquals(recv().textContent, '{"echo":{"n":41},"n":42}');
    assertEquals((globalThis as Record<string, unknown>).__evalProbe, "fired");

    const bad = root.querySelector(".bad")!;
    mounted.dispatch(bad, "click", click(bad));
    await waitFor(() => join()?.textContent === "err:communication", "bad click");

    const invalid = root.querySelector(".invalid")!;
    mounted.dispatch(invalid, "click", click(invalid));
    await waitFor(() => join()?.textContent === "err:invalid-js", "invalid click");

    assertEquals(errors, []);
    mounted.dispose();
  } finally {
    delete (globalThis as Record<string, unknown>).__evalProbe;
  }
});

Deno.test("eval fixture: mounting without `eval: true` fails (host did not opt in)", async () => {
  const root = makeRoot();
  const componentBytes = await loadComponentBytes();
  const translator = await defaultTranslator();

  // wit/world.wit's eval interface doc: "A component that imports it
  // against a host that did not opt in fails to instantiate. Failure is
  // the safe direction, and it is loud." No `eval` key in `imports` means
  // `instantiate` can't satisfy the guest's `import eval` at link time.
  // Observed: the runtime's `PlanError`, naming the unprovided import.
  const err = await assertRejects(() =>
    mountApp({
      source: { componentBytes, translator },
      root,
      onError: () => {},
    })
  );
  assertStringIncludes((err as Error).message, "polymorph:dioxus/eval@0.6.0");
});
