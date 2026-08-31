// bench/ops.ts — shared operation definitions and mount/dispatch/poll
// helpers for bench-rows, used by both bench_worker.ts (runs one
// op x transport pair in its own Deno process) and bench.ts (the parent
// that spawns workers and aggregates).
//
// Governing mount/dispatch pattern: host/src/host.ts + host/tests/
// counter_test.ts. Methodology and per-rep state discipline:
// bench/README.md.
//
// CORRECTNESS DISCIPLINE: every timed rep must do the operation's real
// work. Two guards enforce this instead of just hoping the polling
// predicate is honest:
//
//   1. Every completion predicate checks a *sentinel value changing from
//      its pre-op snapshot*, not just a row count reaching some number —
//      a row count alone can already be at the target value before the
//      op runs (e.g. a second `create-10k` on an already-10k table changes
//      every row's identity but not the count), which silently turns a
//      timed rep into a no-op measurement.
//   2. `timedClickAsserted` calls the same predicate *before* dispatch and
//      throws loudly if it's already true — a rep whose postcondition was
//      satisfied before the operation ran is a fatal bench bug, not a
//      data point (dispatch: "detect that case explicitly").

import { parseHTML } from "linkedom";
import { mountApp } from "../host/src/host.ts";
import type { Mounted } from "../host/src/host.ts";

export const RUNS = 5;
// Below this, for an op touching >=1000 rows, the number is not credible
// (dispatch: "an unexplainable number is a bug lead, not a result").
export const SANITY_FLOOR_MS = 0.5;

export type TransportName = "stream" | "call";
export const TRANSPORTS: TransportName[] = ["stream", "call"];

export function componentPath(t: TransportName): string {
  return new URL(`./build/bench-rows-${t}.component.wasm`, import.meta.url).pathname;
}

export async function loadComponentBytes(t: TransportName): Promise<Uint8Array> {
  const path = componentPath(t);
  try {
    return await Deno.readFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(`component not found at ${path}. Run bench/run.sh (it builds both variants first).`);
    }
    throw e;
  }
}

function makeRoot() {
  const { document } = parseHTML("<!doctype html><html><body><div id=root></div></body></html>");
  return document.getElementById("root")!;
}

// A genuine completion normally lands within single-digit poll ticks (see
// `untimedClick`'s doc comment); this cap is generous headroom for that,
// not a tuned timeout for slow-but-real work. Kept deliberately much
// smaller than "however long a real hang might need" so that `runOp`'s
// bounded-retry loop (a fresh mount on failure) fails fast per attempt
// instead of paying a multi-second wait per attempt.
const DEFAULT_WAIT_MAX_ITERS = 3_000;

async function waitFor(cond: () => boolean, what: string, maxIters = DEFAULT_WAIT_MAX_ITERS): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    if (cond()) return;
    // Same macrotask-poll pattern as host/tests/counter_test.ts and
    // host/tests/fullstack_test.ts: a post-event render can land via
    // either the run task's own wakeup or handle-event's own
    // render-and-flush, so a single microtask drain isn't reliably enough.
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`waitFor timed out: ${what}`);
}

function byId(root: Element, id: string): Element {
  const el = root.querySelector(`#${id}`);
  if (!el) throw new Error(`no element with id=${id} in ${root.innerHTML.slice(0, 500)}`);
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
}

function click(): TrackedEvent {
  return {
    type: "click",
    clientX: 0,
    clientY: 0,
    button: 0,
    buttons: 0,
    preventDefault: () => {},
    stopPropagation: () => {},
  };
}

function rowCount(root: Element): number {
  return Number(byId(root, "row-count").textContent);
}

function updateRunCount(root: Element): number {
  return Number(byId(root, "update-run-count").textContent);
}

function rowsBody(root: Element): Element {
  return byId(root, "rows");
}

function firstRowLabel(root: Element): string | undefined {
  return rowsBody(root).querySelector("tr:first-child td.label")?.textContent ?? undefined;
}

function lastRowLabel(root: Element): string | undefined {
  return rowsBody(root).querySelector("tr:last-child td.label")?.textContent ?? undefined;
}

function firstRowDataId(root: Element): string | undefined {
  return rowsBody(root).children[0]?.getAttribute("data-id") ?? undefined;
}

function posDataId(root: Element, pos: number): string | undefined {
  return rowsBody(root).children[pos]?.getAttribute("data-id") ?? undefined;
}

/**
 * Untimed click-and-wait, used for setup steps only.
 *
 * Historical note: an earlier revision of this bench found the CALL
 * transport's `run` task intermittently hitting
 * `wasm trap: deadlock detected: event loop cannot make further progress`
 * after a small number of click/render round trips in one mount — this
 * bench was the first thing to drive repeated interactions through that
 * transport. Root-caused and fixed at the driver level, NOT here or in
 * polyengine (`src/driver.rs`'s `run()`; amendment A15 host retention —
 * see its module doc for the full explanation: the stream transport's
 * parked `readDirect` session is host-retained state that makes a
 * quiescent park legal, the call transport retains nothing host-side
 * once flush returns, so the same park was correctly indistinguishable
 * from deadlock and traps). This function stays written with minimal
 * microtask depth between dispatch and poll (tail-returning `waitFor`'s
 * promise rather than `await`ing it in an `async function`) since that
 * was measured to shift when the (now-fixed) trap fired, which is a
 * plausible upstream-report lead for polyengine's own quiescence
 * detector — see `bench/README.md`'s footnote — even though it's no
 * longer load-bearing for this bench's correctness.
 */
function untimedClick(mounted: Mounted, root: Element, buttonId: string, cond: () => boolean, what: string): Promise<void> {
  const btn = byId(root, buttonId);
  mounted.dispatch(btn, "click", click());
  return waitFor(cond, what);
}


/**
 * Dispatch `buttonId`'s click and time until `predicate` (a *sentinel*
 * condition — see module doc) is satisfied. Throws immediately, before
 * dispatching, if `predicate` is already true: that means this rep's
 * completion condition would be trivially satisfied without the operation
 * doing anything, which is exactly the measurement bug this harness was
 * rewritten to catch.
 *
 * Also deliberately minimal-microtask-depth between dispatch and the
 * first poll — see `untimedClick`'s doc comment for why.
 */
function timedClickAsserted(
  mounted: Mounted,
  root: Element,
  buttonId: string,
  predicate: () => boolean,
  what: string,
): Promise<number> {
  if (predicate()) {
    throw new Error(
      `FATAL bench bug: postcondition for "${what}" was already true before dispatching the click — ` +
        `this rep would measure a no-op, not real work. Check the setup step and the sentinel predicate.`,
    );
  }
  const btn = byId(root, buttonId);
  const t0 = performance.now();
  mounted.dispatch(btn, "click", click());
  return waitFor(predicate, what).then(() => performance.now() - t0);
}

export function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function freshMount(
  t: TransportName,
  componentBytes: Uint8Array,
  translator: unknown,
): Promise<{ root: Element; mounted: Mounted; errors: unknown[] }> {
  const root = makeRoot();
  const errors: unknown[] = [];
  const mounted = await mountApp({ componentBytes, translator, root, onError: (err) => errors.push(err) });
  await waitFor(() => root.querySelector("#row-count") !== null, `${t}: initial mount`);
  if (errors.length > 0) {
    throw new Error(`${t}: onError fired during mount: ${Deno.inspect(errors)}`);
  }
  return { root, mounted, errors };
}

export interface OpDef {
  name: string;
  rowsInvolved: number; // for the sanity-floor check
  /** Untimed: bring the table to the precondition state for this op. */
  setup: (root: Element, mounted: Mounted) => Promise<void>;
  /** Timed: perform + wait for the real, sentinel-verified completion. */
  timedClick: (root: Element, mounted: Mounted) => Promise<number>;
}

export const ops: OpDef[] = [
  {
    name: "create-1k",
    rowsInvolved: 1000,
    // Clear first (untimed): every rep must do a genuine 0 -> 1000 build,
    // never a 1000 -> 1000 replace-in-place that a count-only predicate
    // could mistake for already-done.
    setup: async (root, mounted) => {
      await untimedClick(mounted, root, "clear", () => rowCount(root) === 0, "create-1k setup (clear)");
    },
    timedClick: (root, mounted) =>
      timedClickAsserted(
        mounted,
        root,
        "create-1k",
        () => rowCount(root) === 1000 && firstRowLabel(root) !== undefined,
        "create-1k",
      ),
  },
  {
    name: "create-10k",
    rowsInvolved: 10000,
    setup: async (root, mounted) => {
      await untimedClick(mounted, root, "clear", () => rowCount(root) === 0, "create-10k setup (clear)");
    },
    timedClick: (root, mounted) =>
      timedClickAsserted(
        mounted,
        root,
        "create-10k",
        () => rowCount(root) === 10000 && firstRowLabel(root) !== undefined,
        "create-10k",
      ),
  },
  {
    name: "append-1k",
    rowsInvolved: 2000,
    // Fresh 1,000-row table every rep (clear then create-1k, both untimed).
    setup: async (root, mounted) => {
      await untimedClick(mounted, root, "clear", () => rowCount(root) === 0, "append-1k setup (clear)");
      await untimedClick(mounted, root, "create-1k", () => rowCount(root) === 1000, "append-1k setup (create)");
    },
    timedClick: (root, mounted) => {
      const preLast = lastRowLabel(root);
      return timedClickAsserted(
        mounted,
        root,
        "append-1k",
        () => rowCount(root) === 2000 && lastRowLabel(root) !== preLast,
        "append-1k",
      );
    },
  },
  {
    // Documented choice (dispatch: "pick one, document"): a 1,000-row
    // baseline, matching js-framework-benchmark's own convention for this
    // operation.
    name: "update-every-10th",
    rowsInvolved: 1000,
    setup: async (root, mounted) => {
      await untimedClick(mounted, root, "clear", () => rowCount(root) === 0, "update setup (clear)");
      await untimedClick(mounted, root, "create-1k", () => rowCount(root) === 1000, "update setup (create)");
    },
    timedClick: (root, mounted) => {
      const preRuns = updateRunCount(root);
      const preFirst = firstRowLabel(root);
      return timedClickAsserted(
        mounted,
        root,
        "update-every-10th",
        () => updateRunCount(root) === preRuns + 1 && firstRowLabel(root) !== preFirst,
        "update-every-10th",
      );
    },
  },
  {
    name: "swap-rows",
    rowsInvolved: 1000,
    setup: async (root, mounted) => {
      await untimedClick(mounted, root, "clear", () => rowCount(root) === 0, "swap setup (clear)");
      await untimedClick(mounted, root, "create-1k", () => rowCount(root) === 1000, "swap setup (create)");
    },
    timedClick: (root, mounted) => {
      // js-framework-benchmark's own swap-rows shape: swap DOM positions 1
      // and 998. The sentinel is position 1's data-id changing away from
      // its pre-swap value.
      const pre1 = posDataId(root, 1);
      return timedClickAsserted(
        mounted,
        root,
        "swap-rows",
        () => posDataId(root, 1) !== pre1 && rowCount(root) === 1000,
        "swap-rows",
      );
    },
  },
  {
    name: "remove-row",
    rowsInvolved: 1000,
    setup: async (root, mounted) => {
      await untimedClick(mounted, root, "clear", () => rowCount(root) === 0, "remove setup (clear)");
      await untimedClick(mounted, root, "create-1k", () => rowCount(root) === 1000, "remove setup (create)");
    },
    timedClick: (root, mounted) => {
      const preFirst = firstRowDataId(root);
      if (!preFirst) throw new Error("remove-row: no rows present before dispatch");
      const removeBtn = byId(root, `remove-${preFirst}`);
      const predicate = () => rowCount(root) === 999 && firstRowDataId(root) !== preFirst;
      if (predicate()) {
        throw new Error(
          `FATAL bench bug: postcondition for "remove-row" was already true before dispatching the click`,
        );
      }
      const t0 = performance.now();
      mounted.dispatch(removeBtn, "click", click());
      return waitFor(predicate, "remove-row").then(() => performance.now() - t0);
    },
  },
  {
    // Dispatch: "clear: set up 10k rows untimed, time the clear."
    name: "clear",
    rowsInvolved: 10000,
    setup: async (root, mounted) => {
      await untimedClick(mounted, root, "clear", () => rowCount(root) === 0, "clear setup (clear)");
      await untimedClick(mounted, root, "create-10k", () => rowCount(root) === 10000, "clear setup (create-10k)");
    },
    timedClick: (root, mounted) => {
      const pre = rowCount(root);
      if (pre !== 10000) {
        throw new Error(`FATAL bench bug: "clear" setup did not leave 10000 rows (got ${pre})`);
      }
      return timedClickAsserted(mounted, root, "clear", () => rowCount(root) === 0, "clear");
    },
  },
];

/**
 * Run one op's warmup + N=5 timed reps against a *fresh* mount, and return
 * the median. Each op/transport pair is run in its own Deno process (see
 * bench_worker.ts / bench.ts) — cheap process isolation with no known
 * cost now, kept as a structural safety margin.
 *
 * Retries the whole attempt (fresh mount) up to `MAX_ATTEMPTS_PER_OP`
 * times as a defensive net, not because a specific failure mode is
 * expected: an earlier revision of this bench was the first thing to
 * drive repeated interactions through the CALL transport and hit a real
 * `run`-task deadlock trap doing so — root-caused and fixed at the
 * driver level (`src/driver.rs`'s `run()`, amendment A15 host retention;
 * see its module doc for the full explanation) rather than here. Kept as
 * a low-cost fallback in case of unrelated future flakiness, not because
 * this bug is expected to recur.
 */
const MAX_ATTEMPTS_PER_OP = 3;

export async function runOp(
  t: TransportName,
  componentBytes: Uint8Array,
  translator: unknown,
  op: OpDef,
): Promise<number> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_OP; attempt++) {
    try {
      return await runOpOnce(t, componentBytes, translator, op);
    } catch (e) {
      lastErr = e;
      // A "FATAL bench bug" is a real defect in this harness (bad
      // predicate, bad setup) — retrying a fresh mount won't fix that,
      // so surface it immediately rather than masking it behind retries.
      if (e instanceof Error && e.message.startsWith("FATAL bench bug")) throw e;
      console.error(
        `bench/ops.ts: "${op.name}" (${t}) attempt ${attempt}/${MAX_ATTEMPTS_PER_OP} failed ` +
          `(${e instanceof Error ? e.message : String(e)}); retrying with a fresh mount if attempts remain.`,
      );
    }
  }
  throw new Error(
    `"${op.name}" (${t}) failed all ${MAX_ATTEMPTS_PER_OP} attempts. Last error: ` +
      `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

async function runOpOnce(
  t: TransportName,
  componentBytes: Uint8Array,
  translator: unknown,
  op: OpDef,
): Promise<number> {
  const { root, mounted } = await freshMount(t, componentBytes, translator);
  // Warmup: exercises JIT/allocator warm paths and any one-time template
  // registration (dioxus registers a template on first encounter — see
  // src/writer.rs's module doc — so the very first create/update op pays a
  // one-time cost the benchmark shouldn't attribute to steady-state
  // throughput). Untimed, but goes through the same setup+timedClick path
  // as a real rep (including the fatal-bug assertion) so a broken op is
  // caught here rather than silently in the timed loop.
  await op.setup(root, mounted);
  await op.timedClick(root, mounted);

  const timings: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    await op.setup(root, mounted);
    timings.push(await op.timedClick(root, mounted));
  }
  mounted.dispose();

  const m = median(timings);
  if (op.rowsInvolved >= 1000 && m < SANITY_FLOOR_MS) {
    throw new Error(
      `FATAL bench bug: "${op.name}" (${t} transport) touches ${op.rowsInvolved} rows but median is ` +
        `${m.toFixed(3)}ms, under the ${SANITY_FLOOR_MS}ms sanity floor for that row count. This is not a ` +
        `credible number for real DOM work at that scale — investigate before reporting (per-rep timings: ` +
        `${timings.map((x) => x.toFixed(3)).join(", ")}ms).`,
    );
  }
  return m;
}
