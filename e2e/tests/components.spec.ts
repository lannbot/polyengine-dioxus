// Real-browser (Chromium via Playwright) E2E test for the components
// example.
//
// Governing docs / authorities:
//   - This dispatch's "Contract with the parallel task" section (fixed
//     DOM contract for the `components` example: #showcase, #demo-button,
//     #click-count, checkbox state text in #checkbox-state
//     ("checked"/"unchecked"), #demo-accordion with per-item trigger +
//     content) — the parallel task owns examples/components/ and must
//     conform to it.
//   - harness/entry.ts: window hooks this test depends on (__mounted,
//     __mountedHandle, __e2eErrors, __buildStamp, __mountFailed) and the
//     `?app=components` selection / stylesheet injection this test relies
//     on.
//
// Selector note: the checkbox and accordion trigger selectors below are
// written defensively against ARIA/semantic structure only (role=checkbox,
// role=button, or a plain <button>/<input type=checkbox> descendant)
// since the exact internal markup of those library components isn't
// fixed by the contract. The parallel task's example author may need to
// tighten these once examples/components/ exists — see the dispatch.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const repoRoot = join(new URL(".", import.meta.url).pathname, "..", "..");

function baseUrl(): string {
  const url = process.env.E2E_BASE_URL;
  if (!url) throw new Error("E2E_BASE_URL not set — did global-setup.ts run?");
  return `${url}/?app=components`;
}

const BENIGN_CONSOLE_PATTERNS: RegExp[] = [];

test.beforeEach(async () => {
  if (!existsSync(join(repoRoot, "examples", "build", "components.component.wasm"))) {
    throw new Error(
      "examples/build/components.component.wasm missing — run `just example components` first " +
        "(the `just e2e` recipe does this for you).",
    );
  }
});

test("components example: gallery mounts, button/checkbox/accordion interactions work", async ({ page }) => {
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

  // Build-identity probe (dispatch mandatory rule).
  await page.waitForFunction(() => (globalThis as unknown as { __buildStamp?: unknown }).__buildStamp !== undefined);
  const stamp = await page.evaluate(() => (globalThis as unknown as { __buildStamp: { gitRev: string } }).__buildStamp);
  const actualGitRev = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
  expect(stamp.gitRev, "harness/dist/build-stamp.json gitRev must match the checked-out HEAD").toBe(actualGitRev);

  // 1) Mount.
  await page.waitForFunction(() => (globalThis as unknown as { __mounted?: boolean }).__mounted === true, {
    timeout: 15_000,
  });
  const mountFailed = await page.evaluate(() => (globalThis as unknown as { __mountFailed?: boolean }).__mountFailed);
  expect(mountFailed, "mountApp must not have thrown").toBeFalsy();
  await expect(page.locator("#showcase")).toBeVisible();

  // 2) Button: two clicks -> "2".
  const button = page.locator("#demo-button");
  await button.click();
  await button.click();
  await expect(page.locator("#click-count")).toHaveText("2");

  // 3) Checkbox: flips state text on click, flips back on second click.
  // Selector is defensive: the checkbox itself, or a role=checkbox
  // descendant, wherever it lives relative to #checkbox-state (contract
  // only fixes the state-text element's id, not the checkbox's).
  const stateEl = page.locator("#checkbox-state");
  const initialState = (await stateEl.textContent())?.trim();
  expect(["checked", "unchecked"]).toContain(initialState);

  const checkbox = page.locator('input[type=checkbox], [role="checkbox"]').first();
  await checkbox.click();
  await expect(stateEl).not.toHaveText(initialState ?? "");
  expect(["checked", "unchecked"]).toContain((await stateEl.textContent())?.trim());

  await checkbox.click();
  await expect(stateEl).toHaveText(initialState ?? "");

  // 4) Accordion: clicking an item's trigger reveals its content.
  // Trigger selector is defensive (role=button or a bare <button>
  // descendant of #demo-accordion) since the library's internal markup
  // isn't fixed by the contract — only "at least two items" and
  // "per-item content text appears when its trigger is clicked" are.
  const accordion = page.locator("#demo-accordion");
  await expect(accordion).toBeVisible();
  const triggers = accordion.locator('[role="button"], button');
  const triggerCount = await triggers.count();
  expect(triggerCount, "#demo-accordion must have at least two item triggers").toBeGreaterThanOrEqual(2);

  const firstTrigger = triggers.nth(0);
  await firstTrigger.click();
  // The library marks expansion with data-state="open" on the item, its
  // trigger, and its content div (verified against dioxus_components
  // 0.1.2's accordion markup), and the content's height animates from 0.
  // Assert on data-state rather than innerText: the collapsed content is
  // hidden via overflow-hidden + height 0, which innerText still includes,
  // so a text-based assertion would be vacuous.
  const openContent = accordion.locator('div[data-state="open"] >> nth=-1');
  await expect(openContent).toContainText("first accordion item");

  const secondTrigger = triggers.nth(1);
  await secondTrigger.click();
  // Single-open mode: item two opens (and item one closes).
  await expect(accordion.locator('div[data-state="open"] >> nth=-1')).toContainText(
    "second accordion item",
  );
  await expect(accordion.locator('button[data-state="open"]')).toHaveCount(1);

  // 5) Zero collected page errors / console errors throughout.
  const collectedErrors = await page.evaluate(() =>
    (globalThis as unknown as { __e2eErrors: unknown[] }).__e2eErrors
  );
  expect(collectedErrors, "no onError/window.onerror/unhandledrejection ever fired").toEqual([]);
  expect(pageErrors, "no uncaught page exceptions").toEqual([]);
  expect(consoleErrors, "no console.error output").toEqual([]);
});
