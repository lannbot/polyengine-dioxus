// bench/bench.ts — the row-operation benchmark's orchestrator: for each
// operation, spawns bench/bench_worker.ts in its own Deno process, collects
// its median ms, and renders/writes the results table.
//
// A worker may report a null median (host-runtime trap exhausted its
// retries — see bench/ops.ts's runOp doc); that renders as "N/A" in the
// table rather than aborting the whole run or fabricating a number.
//
// This bench A/Bs the two mutation channels (`run`'s hand-rolled byte
// format vs `run-typed`'s explicit WIT schema, wit/world.wit) against each
// other, over the same component build — restoring the two-column shape
// documented in bench/README.md's "Transport A/B" section (the earlier A/B
// there compared the byte channel against the since-retired "call"
// transport; this one compares it against the typed channel instead).

import { ops, TRANSPORTS } from "./ops.ts";
import type { TransportName } from "./ops.ts";

interface OpResult {
  op: string;
  medianMs: Record<TransportName, number | null>;
  error: Record<TransportName, string | undefined>;
}

async function runWorker(opName: string, transport: TransportName): Promise<{ medianMs: number | null; error?: string }> {
  const workerPath = new URL("./bench_worker.ts", import.meta.url).pathname;
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read=.", "--allow-env", "--allow-run", workerPath, opName, transport],
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  const stdoutText = new TextDecoder().decode(stdout);
  if (code !== 0) {
    const stderrText = new TextDecoder().decode(stderr);
    throw new Error(`bench_worker failed for op=${opName} transport=${transport} (exit ${code}):\n${stderrText}`);
  }
  // The worker's only stdout line is its JSON result; be tolerant of any
  // stray output by taking the last non-empty line.
  const lines = stdoutText.trim().split("\n").filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  const parsed = JSON.parse(last) as { op: string; transport: string; medianMs: number | null; error?: string };
  return { medianMs: parsed.medianMs, error: parsed.error };
}

async function benchAll(): Promise<OpResult[]> {
  const results: OpResult[] = [];
  for (const [i, op] of ops.entries()) {
    const medianMs = {} as Record<TransportName, number | null>;
    const error = {} as Record<TransportName, string | undefined>;
    // Alternate which transport runs first per op (rather than always
    // "bytes" then "typed") so any drift over the run (thermal, background
    // GC, whatever) does not land preferentially on one channel. Each op
    // still runs in its own process per transport, so there is no shared
    // state to worry about — this only removes a fixed ordering bias.
    const order = i % 2 === 0 ? TRANSPORTS : [...TRANSPORTS].reverse();
    for (const transport of order) {
      const r = await runWorker(op.name, transport);
      medianMs[transport] = r.medianMs;
      error[transport] = r.error;
    }
    results.push({ op: op.name, medianMs, error });
  }
  return results;
}

function fmtMs(ms: number | null): string {
  return ms === null ? "N/A" : ms.toFixed(2);
}

function fmtRatio(bytesMs: number | null, typedMs: number | null): string {
  if (bytesMs === null || typedMs === null || bytesMs === 0) return "N/A";
  return `${(typedMs / bytesMs).toFixed(2)}x`;
}

function renderTable(results: OpResult[]): string {
  const header = "| op | bytes (ms, median of 5) | typed (ms, median of 5) | typed / bytes |";
  const sep = "| --- | --- | --- | --- |";
  const rows = results.map((r) =>
    `| ${r.op} | ${fmtMs(r.medianMs.bytes)} | ${fmtMs(r.medianMs.typed)} | ${
      fmtRatio(r.medianMs.bytes, r.medianMs.typed)
    } |`
  );
  const table = [header, sep, ...rows].join("\n");
  const failureNotes = results.flatMap((r) =>
    TRANSPORTS.filter((t) => r.error[t]).map((t) => `- **${r.op}** (${t}): ${r.error[t]}`)
  );
  if (failureNotes.length === 0) return table;
  return table + "\n\n### N/A explanations\n\n" + failureNotes.join("\n");
}

async function gitRev(): Promise<string> {
  // `git describe --always --dirty` rather than `rev-parse --short HEAD`:
  // this whole spike is uncommitted, so a bare HEAD rev would claim a
  // pre-spike commit that has no `run-typed` in it at all — the `--dirty`
  // suffix makes that visible instead of silently misleading.
  try {
    const cmd = new Deno.Command("git", { args: ["describe", "--always", "--dirty"], stdout: "piped" });
    const { stdout } = await cmd.output();
    return new TextDecoder().decode(stdout).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function main() {
  const results = await benchAll();
  const table = renderTable(results);

  const date = new Date().toISOString().slice(0, 10);
  const host = Deno.build.target;
  const rev = await gitRev();
  const denoVersion = Deno.version.deno;

  const header = `# bench-rows results — ${date}\n\n` +
    `- Deno: ${denoVersion} (${host})\n` +
    `- git rev: ${rev}\n` +
    `- Box note: numbers are box-relative — compare columns within this run, not across machines. See bench/README.md.\n\n`;

  const fullReport = header + table + "\n";
  console.log(fullReport);

  const outPath = new URL(`./results-${date}-${host}.md`, import.meta.url).pathname;
  await Deno.writeTextFile(outPath, fullReport);
  console.error(`\nwrote ${outPath}`);

  await updateReadme(fullReport);
}

async function updateReadme(report: string): Promise<void> {
  const readmePath = new URL("./README.md", import.meta.url).pathname;
  const readme = await Deno.readTextFile(readmePath);
  const startMarker = "<!-- LATEST-LOCAL-NUMBERS:START -->";
  const endMarker = "<!-- LATEST-LOCAL-NUMBERS:END -->";
  const startIdx = readme.indexOf(startMarker);
  const endIdx = readme.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    console.error("bench/README.md missing latest-local-numbers markers; skipping README update.");
    return;
  }
  const replacement = `${startMarker}\n\n${report}\n${endMarker}`;
  const updated = readme.slice(0, startIdx) + replacement + readme.slice(endIdx + endMarker.length);
  await Deno.writeTextFile(readmePath, updated);
  console.error(`updated ${readmePath}`);
}

if (import.meta.main) {
  await main();
}
