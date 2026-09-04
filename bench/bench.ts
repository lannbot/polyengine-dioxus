// bench/bench.ts — the row-operation benchmark's orchestrator: for each
// operation, spawns bench/bench_worker.ts in its own Deno process, collects
// its median ms, and renders/writes the results table.
//
// A worker may report a null median (host-runtime trap exhausted its
// retries — see bench/ops.ts's runOp doc); that renders as "N/A" in the
// table rather than aborting the whole run or fabricating a number.

import { ops } from "./ops.ts";

interface OpResult {
  op: string;
  medianMs: number | null;
  error: string | undefined;
}

async function runWorker(opName: string): Promise<{ medianMs: number | null; error?: string }> {
  const workerPath = new URL("./bench_worker.ts", import.meta.url).pathname;
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read=.", "--allow-env", "--allow-run", workerPath, opName],
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  const stdoutText = new TextDecoder().decode(stdout);
  if (code !== 0) {
    const stderrText = new TextDecoder().decode(stderr);
    throw new Error(`bench_worker failed for op=${opName} (exit ${code}):\n${stderrText}`);
  }
  // The worker's only stdout line is its JSON result; be tolerant of any
  // stray output by taking the last non-empty line.
  const lines = stdoutText.trim().split("\n").filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  const parsed = JSON.parse(last) as { op: string; medianMs: number | null; error?: string };
  return { medianMs: parsed.medianMs, error: parsed.error };
}

async function benchAll(): Promise<OpResult[]> {
  const results: OpResult[] = [];
  for (const op of ops) {
    const r = await runWorker(op.name);
    results.push({ op: op.name, medianMs: r.medianMs, error: r.error });
  }
  return results;
}

function fmtMs(ms: number | null): string {
  return ms === null ? "N/A" : ms.toFixed(2);
}

function renderTable(results: OpResult[]): string {
  const header = "| op | ms (median of 5) |";
  const sep = "| --- | --- |";
  const rows = results.map((r) => `| ${r.op} | ${fmtMs(r.medianMs)} |`);
  const table = [header, sep, ...rows].join("\n");
  const failureNotes = results.filter((r) => r.error).map((r) => `- **${r.op}**: ${r.error}`);
  if (failureNotes.length === 0) return table;
  return table + "\n\n### N/A explanations\n\n" + failureNotes.join("\n");
}

async function gitRev(): Promise<string> {
  // `git describe --always --dirty` rather than `rev-parse --short HEAD`:
  // this tree may be uncommitted, so a bare HEAD rev could claim a stale
  // commit — the `--dirty` suffix makes that visible instead of silently
  // misleading.
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
