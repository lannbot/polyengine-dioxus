// Full-stack host-runtime test for the platform-probe fixture
// (fixtures/platform-probe/src/lib.rs — the authority for markup and
// behavior), exercising `polymorph:dioxus/eval`, `head`, and `history` end
// to end, plus `MountOptions.intercept` over each. Requires `just fixtures`
// to have built fixtures/build/platform-probe.component.wasm first.

import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { parseHTML } from "linkedom";
import { defaultTranslator } from "@deltic/translator";
import { evalDenied } from "../src/eval.ts";
import { mountApp } from "../src/host.ts";
import type { MountOptions } from "../src/host.ts";

const FIXTURE_PATH = "../../fixtures/build/platform-probe.component.wasm";

async function waitFor(cond: () => boolean, what: string, maxIters = 2000): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`waitFor timed out: ${what}`);
}

function makeRoot() {
  const { document } = parseHTML("<!doctype html><html><head></head><body><div id=root></div></body></html>");
  const root = document.getElementById("root")!;
  return { document, root };
}

async function loadComponentBytes(): Promise<Uint8Array> {
  const url = new URL(FIXTURE_PATH, import.meta.url);
  try {
    return await Deno.readFile(url);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(
        `component not found at ${url}. Run \`just fixtures\` first ` +
          `(builds fixtures/build/platform-probe.component.wasm).`,
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

async function mount(
  root: Element,
  opts: Partial<MountOptions> = {},
): Promise<Awaited<ReturnType<typeof mountApp>>> {
  const componentBytes = await loadComponentBytes();
  const translator = await defaultTranslator();
  return await mountApp({
    source: { componentBytes, translator },
    root,
    eval: true,
    onError: () => {},
    ...opts,
  });
}

Deno.test("platform-probe: eval fire-and-forget, recv/send/join round trip, both error paths", async () => {
  const { root } = makeRoot();
  const errors: unknown[] = [];

  try {
    const mounted = await mount(root, { onError: (err) => errors.push(err) });

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

Deno.test("platform-probe: mounting without `eval: true` fails (host did not opt in)", async () => {
  const { root } = makeRoot();
  const componentBytes = await loadComponentBytes();
  const translator = await defaultTranslator();

  // wit/world.wit's eval interface doc: "A component that imports it
  // against a host that did not opt in fails to instantiate. Failure is
  // the safe direction, and it is loud." No `eval` key in `imports` means
  // `instantiate` can't satisfy the guest's `import eval` at link time.
  const err = await assertRejects(() =>
    mountApp({
      source: { componentBytes, translator },
      root,
      onError: () => {},
    })
  );
  assertStringIncludes((err as Error).message, "polymorph:dioxus/eval@0.6.0");
});

Deno.test("platform-probe: intercept.eval without eval: true rejects synchronously before instantiation", async () => {
  const { root } = makeRoot();
  const componentBytes = await loadComponentBytes();
  const translator = await defaultTranslator();

  await assertRejects(
    () =>
      mountApp({
        source: { componentBytes, translator },
        root,
        onError: () => {},
        intercept: { eval: {} },
      }),
    Error,
    "eval",
  );
});

Deno.test("platform-probe: head — title, meta, style land in <head>; script allowed when eval granted", async () => {
  const { document, root } = makeRoot();
  try {
    const mounted = await mount(root);
    await waitFor(() => document.title === "probe-title", "title set");

    const meta = document.head.querySelector("meta[name=probe]")!;
    assertEquals(meta.getAttribute("content"), "meta-value");

    const style = document.head.querySelector("style")!;
    assertStringIncludes(style.textContent ?? "", "probe-style");

    // allowScript = !!opts.eval, and this mount granted eval.
    assertEquals(document.head.querySelector("script") !== null, true);

    mounted.dispose();
  } finally {
    delete (globalThis as Record<string, unknown>).__evalProbe;
  }
});

Deno.test("platform-probe: head — an interceptor can refuse the script element even with eval granted", async () => {
  const { document, root } = makeRoot();
  try {
    const mounted = await mount(root, {
      intercept: {
        head: {
          createElement: (next, tag, attrs, contents) => tag === "script" ? false : next(tag, attrs, contents),
        },
      },
    });
    await waitFor(() => document.title === "probe-title", "title set");
    assertEquals(document.head.querySelector("script"), null);
    // Other head writes still land.
    assertEquals(document.head.querySelector("meta[name=probe]") !== null, true);

    mounted.dispose();
  } finally {
    delete (globalThis as Record<string, unknown>).__evalProbe;
  }
});

Deno.test("platform-probe: router — nav pushes a route, back returns, a host-driven forward() re-renders it", async () => {
  const { root } = makeRoot();
  try {
    const mounted = await mount(root);
    const route = () => root.querySelector(".route")!;

    await waitFor(() => route()?.textContent === "home", "initial route");

    const nav = () => root.querySelector(".nav")!;
    mounted.dispatch(nav(), "click", click(nav()));
    await waitFor(() => route()?.textContent === "other", "nav click");
    assertEquals(mounted.history.current(), "/other");

    const back = () => root.querySelector(".back")!;
    mounted.dispatch(back(), "click", click(back()));
    await waitFor(() => route()?.textContent === "home", "back click");

    // Host-driven, guest didn't ask: exercises the `changes` stream.
    mounted.history.forward();
    await waitFor(() => route()?.textContent === "other", "host-driven forward");

    mounted.dispose();
  } finally {
    delete (globalThis as Record<string, unknown>).__evalProbe;
  }
});

Deno.test("platform-probe: an eval interceptor can deny a specific script, mapped to EvalError::Unsupported", async () => {
  const { root } = makeRoot();
  try {
    const mounted = await mount(root, {
      intercept: {
        eval: {
          eval: (next, js, send) => js.includes("boom") ? evalDenied() : next(js, send),
        },
      },
    });

    const join = () => root.querySelector(".join")!;
    await waitFor(() => join()?.textContent === "done-41", "initial join (not denied)");

    const bad = root.querySelector(".bad")!;
    mounted.dispatch(bad, "click", click(bad));
    // `.bad`'s handler only special-cases EvalError::Communication; a
    // denied eval maps to Unsupported, so its `other` arm formats it.
    await waitFor(() => (join()?.textContent ?? "").startsWith("unexpected:Err(Unsupported"), "bad click denied");

    mounted.dispose();
  } finally {
    delete (globalThis as Record<string, unknown>).__evalProbe;
  }
});
