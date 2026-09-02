// Build script for the E2E dev-host harness bundle (owned by the E2E
// track: e2e/ + harness/). Run via `deno run -A harness/build.ts`, or
// through `just e2e`.
//
// Emits harness/dist/ (gitignored — see repo .gitignore's unanchored
// `dist/` pattern):
//   - entry.js               — `deno bundle --platform browser --minify`
//                               output of harness/entry.ts (same mechanism
//                               .deps/polyengine/tools/release-bundle/build.ts
//                               uses for the embedder release asset).
//   - build-stamp.json        — { gitRev, builtAt } for the E2E server's
//                               build-identity probe (dispatch's mandatory
//                               "verify the served build before trusting
//                               any probe" rule).
//
// No translator_shim.wasm: translation happens at BUILD time (`just
// example <name>` emits a translation envelope next to the component —
// embedder-api.md amendment A4), so the bundle no longer imports
// @deltic/translator and nothing ever fetches the shim asset.

import { dirname, fromFileUrl, join, normalize } from "jsr:@std/path@1";

const repoRoot = normalize(join(dirname(fromFileUrl(import.meta.url)), ".."));
const harnessDir = join(repoRoot, "harness");
const distDir = join(harnessDir, "dist");

async function gitRev(): Promise<string> {
  const cmd = new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    cwd: repoRoot,
    stdout: "piped",
    stderr: "inherit",
  });
  const { code, stdout } = await cmd.output();
  if (code !== 0) throw new Error("git rev-parse HEAD failed");
  return new TextDecoder().decode(stdout).trim();
}

export async function buildHarness(): Promise<void> {
  await Deno.mkdir(distDir, { recursive: true });

  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--platform",
      "browser",
      "--format",
      "esm",
      "--minify",
      "-o",
      join(distDir, "entry.js"),
      join(harnessDir, "entry.ts"),
    ],
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) throw new Error(`deno bundle failed with code ${code}`);

  const stamp = { gitRev: await gitRev(), builtAt: new Date().toISOString() };
  await Deno.writeTextFile(join(distDir, "build-stamp.json"), JSON.stringify(stamp, null, 2));
}

if (import.meta.main) {
  await buildHarness();
  console.log("harness bundle built at", distDir);
}
