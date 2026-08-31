// Real-browser (Chromium via Playwright) E2E test for the counter example.
//
// Governing docs / authorities:
//   - host/tests/counter_test.ts: authoritative for markup/ids/behavior
//     assertions (mirrors it, but drives real user input instead of
//     `mounted.dispatch(...)`).
//   - examples/counter/src/lib.rs: authoritative for element ids/structure.
//   - harness/entry.ts: window hooks this test depends on
//     (__mounted, __mountedHandle, __e2eErrors, __buildStamp,
//     __mountFailed).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const repoRoot = join(new URL(".", import.meta.url).pathname, "..", "..");

function baseUrl(): string {
  const url = process.env.E2E_BASE_URL;
  if (!url) throw new Error("E2E_BASE_URL not set — did global-setup.ts run?");
  return url;
}

// Benign console noise we don't want to fail the test on (dispatch: "zero
// collected page errors / console errors (filter benign)"). Empty for now
// — Chromium + this bundle produce none in practice; kept as an explicit
// allowlist point rather than a blanket suppression.
const BENIGN_CONSOLE_PATTERNS: RegExp[] = [];

test.beforeEach(async ({ page }) => {
  if (!existsSync(join(repoRoot, "examples", "build", "counter.component.wasm"))) {
    throw new Error(
      "examples/build/counter.component.wasm missing — run `just example counter` first " +
        "(the `just e2e` recipe does this for you).",
    );
  }
});

test("counter example: real click/type/submit through Chromium", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (BENIGN_CONSOLE_PATTERNS.some((re) => re.test(text))) return;
    consoleErrors.push(text);
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.stack ?? err.message));

  await page.goto(baseUrl());

  // Build-identity probe (dispatch mandatory rule): confirm we're testing
  // THIS checkout's build, not a stale bundle from a previous run.
  await page.waitForFunction(() => (globalThis as unknown as { __buildStamp?: unknown }).__buildStamp !== undefined);
  const stamp = await page.evaluate(() => (globalThis as unknown as { __buildStamp: { gitRev: string } }).__buildStamp);
  const actualGitRev = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
  expect(stamp.gitRev, "harness/dist/build-stamp.json gitRev must match the checked-out HEAD").toBe(actualGitRev);

  // Mount completion (event-driven wait, not a sleep — mirrors
  // host/tests/counter_test.ts's own waitFor pattern via a page function).
  await page.waitForFunction(() => (globalThis as unknown as { __mounted?: boolean }).__mounted === true, {
    timeout: 15_000,
  });
  const mountFailed = await page.evaluate(() => (globalThis as unknown as { __mountFailed?: boolean }).__mountFailed);
  expect(mountFailed, "mountApp must not have thrown").toBeFalsy();

  // 1) Initial render — pinned to examples/counter/src/lib.rs's markup.
  await expect(page.locator("#count")).toHaveText("0");
  await expect(page.locator("#parity")).toHaveClass("even");
  await expect(page.locator("#parity")).toHaveText("count is 0");
  await expect(page.locator("#echo")).toHaveText("");
  await expect(page.locator("#items li")).toHaveText(["alpha", "beta"]);
  await expect(page.locator("#submitted")).toHaveText("submitted 0 time(s)");

  // 2) +/- buttons via REAL clicks.
  await page.locator("#inc").click();
  await expect(page.locator("#count")).toHaveText("1");
  await expect(page.locator("#parity")).toHaveClass("odd");

  await page.locator("#inc").click();
  await expect(page.locator("#count")).toHaveText("2");
  await expect(page.locator("#parity")).toHaveClass("even");

  await page.locator("#dec").click();
  await expect(page.locator("#count")).toHaveText("1");
  await expect(page.locator("#parity")).toHaveClass("odd");

  // 3) REAL keyboard typing into the draft input -> echo updates.
  await page.locator("#draft").click();
  await page.keyboard.type("hello", { delay: 20 });
  await expect(page.locator("#echo")).toHaveText("hello");
  await expect(page.locator("#draft")).toHaveValue("hello");

  // 4) List add/remove via real clicks; order asserted.
  await page.locator("#add").click();
  await expect(page.locator("#items li")).toHaveText(["alpha", "beta", "item-0"]);

  await page.locator("#add").click();
  await expect(page.locator("#items li")).toHaveText(["alpha", "beta", "item-0", "item-1"]);

  await page.locator("#remove").click();
  await expect(page.locator("#items li")).toHaveText(["alpha", "beta", "item-0"]);

  // 5) Form submit prevent_default probe: submitting must NOT navigate
  // (URL unchanged, no reload — asserted via a window marker planted
  // before submit that would be wiped by a real navigation/reload) AND
  // the app's onsubmit effect (submitted counter) must be visible.
  const urlBefore = page.url();
  await page.evaluate(() => {
    (globalThis as unknown as { __preNavMarker: string }).__preNavMarker = "still-here";
  });

  // Submit via a real click on the form's actual submit button
  // (examples/counter/src/lib.rs: `button { id: "submit", r#type:
  // "submit", ... }`) — the browser's native submit behavior (including
  // its default navigation, which onsubmit's prevent_default() must
  // suppress) is exactly what this exercises.
  await page.locator("#submit").click();

  await expect(page.locator("#submitted")).toHaveText("submitted 1 time(s)");
  expect(page.url(), "form submit must not navigate the page").toBe(urlBefore);
  const marker = await page.evaluate(() => (globalThis as unknown as { __preNavMarker?: string }).__preNavMarker);
  expect(marker, "a real navigation/reload would have wiped this in-page marker").toBe("still-here");

  // 6) STREAM transport smoke assert: every delivered byte has been
  // decoded into whole frames (host/src/host.ts's frameDecoder — "lets a
  // test confirm the zero-copy direct-read path actually engaged").
  const pending = await page.evaluate(() =>
    (globalThis as unknown as { __mountedHandle: { frameDecoder: { pending(): number } } }).__mountedHandle
      .frameDecoder.pending()
  );
  expect(pending, "frameDecoder must have no partial frame staged after settling").toBe(0);

  // 7) Zero collected page errors / console errors throughout.
  const collectedErrors = await page.evaluate(() =>
    (globalThis as unknown as { __e2eErrors: unknown[] }).__e2eErrors
  );
  expect(collectedErrors, "no onError/window.onerror/unhandledrejection ever fired").toEqual([]);
  expect(pageErrors, "no uncaught page exceptions").toEqual([]);
  expect(consoleErrors, "no console.error output").toEqual([]);
});
