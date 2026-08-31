// bench/bench_worker.ts — runs exactly ONE op, in its own Deno process, and
// prints its result to stdout as JSON. See bench/ops.ts's runOp doc for the
// bounded-retry loop this worker relies on (a defensive net, not because a
// specific failure mode is currently expected — see bench/ops.ts's
// MAX_ATTEMPTS_PER_OP doc for the historical issue it was added for). When
// even the retries are exhausted, this worker prints `medianMs: null` plus
// the error rather than crashing — one op failing should not abort the
// whole bench run; bench.ts renders that op as "N/A" and the failure is
// reported plainly, not hidden.
//
// Usage: deno run --allow-read=. --allow-env --allow-run bench/bench_worker.ts <opName> <stream>

import { defaultTranslator } from "@deltic/translator";
import { loadComponentBytes, ops, runOp } from "./ops.ts";
import type { TransportName } from "./ops.ts";

async function main() {
  const [opName, transportArg] = Deno.args;
  const op = ops.find((o) => o.name === opName);
  if (!op) {
    throw new Error(`unknown op "${opName}"; known ops: ${ops.map((o) => o.name).join(", ")}`);
  }
  if (transportArg !== "stream") {
    throw new Error(`transport must be "stream", got "${transportArg}"`);
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
