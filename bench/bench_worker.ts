// bench/bench_worker.ts — runs exactly ONE (op, transport) pair, in its own
// Deno process, and prints its result to stdout as JSON. See
// bench/ops.ts's runOp doc for the discovered host-runtime issue this
// process-per-pair split and the internal bounded-retry loop both exist
// to contain: the CALL transport's `run` task was observed to
// occasionally hit a `wasm trap: deadlock detected` after a small number
// of click/render round trips, in a way not fully eliminated by retries
// (a genuine timing-sensitive race in the host scheduler, not a bug in
// this harness). When even the retries are exhausted, this worker prints
// `medianMs: null` plus the error rather than crashing — one op/transport
// pair failing should not abort the whole bench run; bench.ts renders
// that pair as "N/A" and the failure is reported plainly, not hidden.
//
// Usage: deno run --allow-read=. --allow-env --allow-run bench/bench_worker.ts <opName> <stream|call>

import { defaultTranslator } from "@deltic/translator";
import { loadComponentBytes, ops, runOp } from "./ops.ts";
import type { TransportName } from "./ops.ts";

async function main() {
  const [opName, transportArg] = Deno.args;
  const op = ops.find((o) => o.name === opName);
  if (!op) {
    throw new Error(`unknown op "${opName}"; known ops: ${ops.map((o) => o.name).join(", ")}`);
  }
  if (transportArg !== "stream" && transportArg !== "call") {
    throw new Error(`transport must be "stream" or "call", got "${transportArg}"`);
  }
  const transport: TransportName = transportArg;

  const translator = await defaultTranslator();
  const bytes = await loadComponentBytes(transport);
  try {
    const medianMs = await runOp(transport, bytes, translator, op);
    console.log(JSON.stringify({ op: opName, transport, medianMs }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`bench_worker: op=${opName} transport=${transport} failed after retries: ${message}`);
    console.log(JSON.stringify({ op: opName, transport, medianMs: null, error: message }));
  }
}

await main();
