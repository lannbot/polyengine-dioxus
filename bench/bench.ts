// bench/bench.ts — the row-operation benchmark's orchestrator: for each
// (operation, transport) pair, spawns bench/bench_worker.ts in its own
// Deno process, collects each worker's median ms, and renders/writes the
// results table.
//
// A worker may report a null median (host-runtime trap exhausted its
// retries — see bench/ops.ts's runOp doc and bench/README.md's
// methodology notes for the discovered CALL-transport scheduler issue);
// that renders as "N/A" in the table rather than aborting the whole run
// or fabricating a number.
//
// Methodology and interpretation guardrails: bench/README.md.

import { ops, TRANSPORTS } from "./ops.ts";
import type { TransportName } from "./ops.ts";

interface OpResult {
  op: string;
  mediansMs: Record<TransportName, number | null>;
  errors: Partial<Record<TransportName, string>>;
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
  for (const op of ops) {
    const mediansMs = {} as Record<TransportName, number | null>;
    const errors: Partial<Record<TransportName, string>> = {};
    for (const t of TRANSPORTS) {
      const { medianMs, error } = await runWorker(op.name, t);
      mediansMs[t] = medianMs;
      if (error) errors[t] = error;
    }
    results.push({ op: op.name, mediansMs, errors });
  }
  return results;
}

function fmtMs(ms: number | null): string {
  return ms === null ? "N/A" : ms.toFixed(2);
}

function fmtDeltaPct(streamMs: number | null, callMs: number | null): string {
  if (streamMs === null || callMs === null) return "N/A";
  if (streamMs === 0) return "n/a";
  const pct = ((callMs - streamMs) / streamMs) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function renderTable(results: OpResult[]): string {
  const header = "| op | stream (ms, median of 5) | call (ms, median of 5) | call vs stream |";
  const sep = "| --- | --- | --- | --- |";
  const rows = results.map((r) => {
    const s = r.mediansMs.stream;
    const c = r.mediansMs.call;
    return `| ${r.op} | ${fmtMs(s)} | ${fmtMs(c)} | ${fmtDeltaPct(s, c)} |`;
  });
  const table = [header, sep, ...rows].join("\n");
  const failureNotes = results
    .flatMap((r) =>
      (["stream", "call"] as TransportName[])
        .filter((t) => r.errors[t])
        .map((t) => `- **${r.op}** (${t}): ${r.errors[t]}`)
    );
  if (failureNotes.length === 0) return table;
  return table + "\n\n### N/A explanations\n\n" + failureNotes.join("\n");
}

async function gitRev(): Promise<string> {
  try {
    const cmd = new Deno.Command("git", { args: ["rev-parse", "--short", "HEAD"], stdout: "piped" });
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
