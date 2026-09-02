// Real-browser (Chromium via Playwright) E2E test for the primitives
// example.
//
// Governing docs / authorities:
//   - This dispatch's "Contract with the parallel task" section (fixed
//     DOM contract for the `primitives` example: #primitives-showcase,
//     #demo-switch, #demo-slider, #demo-tabs, #demo-accordion-p,
//     #demo-progress, and #switch-state whose text is exactly "on" or
//     "off") — the parallel task owns examples/primitives/ and must
//     conform to it.
//   - harness/entry.ts: window hooks this test depends on (__mounted,
//     __mountedHandle, __e2eErrors, __buildStamp, __mountFailed) and the
//     `?app=primitives` selection / stylesheet injection this test relies
//     on.
//   - e2e/tests/components.spec.ts: structure/hooks mirrored here
//     (build-stamp identity probe, __mounted, __e2eErrors, zero-page-errors).
//
// Selector notes (upstream markup uncertain until examples/primitives/
// exists — dispatch: "select on ARIA roles / data-state rather than
// internal class names, and say so"):
//   - Switch: dioxus_primitives::switch::Switch renders as a focusable
//     element with data-state="checked"/"unchecked". Selected defensively
//     within #demo-switch via `[role=switch], button, [data-state]` — the
//     parallel task's example author may need to tighten this once the
//     example exists.
//   - Tabs: upstream tabs use role="tab" / role="tabpanel" with
//     data-state. Asserting on data-state="active" (or "selected") on the
//     clicked trigger, and visibility of the corresponding panel, rather
//     than innerText — same rationale as the components accordion test
//     (collapsed/inactive content may still carry text even when hidden
//     via CSS).
//   - Accordion: same data-state approach as components.spec.ts's
//     accordion coverage (div[data-state="open"]).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const repoRoot = join(new URL(".", import.meta.url).pathname, "..", "..");

function baseUrl(): string {
  const url = process.env.E2E_BASE_URL;
  if (!url) throw new Error("E2E_BASE_URL not set — did global-setup.ts run?");
  return `${url}/?app=primitives`;
}

const BENIGN_CONSOLE_PATTERNS: RegExp[] = [];

test.beforeEach(async () => {
  if (!existsSync(join(repoRoot, "examples", "build", "primitives.component.wasm"))) {
    throw new Error(
      "examples/build/primitives.component.wasm missing — run `just example primitives` first " +
        "(the `just e2e` recipe does this for you).",
    );
  }
});

test("primitives example: gallery mounts, switch/tabs/accordion interactions work", async ({ page }) => {
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
  await expect(page.locator("#primitives-showcase")).toBeVisible();

  // 2) Switch: click flips #switch-state off<->on. Selector is defensive
  // (see file-header comment) since dioxus_primitives::switch::Switch's
  // exact markup isn't fixed by the contract beyond living within
  // #demo-switch.
  const stateEl = page.locator("#switch-state");
  await expect(stateEl).toHaveText(/^(on|off)$/);
  const initialState = (await stateEl.textContent())?.trim();

  const switchControl = page.locator('#demo-switch [role="switch"], #demo-switch button, #demo-switch [data-state]')
    .first();
  await switchControl.click();
  await expect(stateEl).not.toHaveText(initialState ?? "");
  await expect(stateEl).toHaveText(/^(on|off)$/);

  await switchControl.click();
  await expect(stateEl).toHaveText(initialState ?? "");

  // 3) Tabs: clicking the second tab trigger activates its panel. Trigger
  // selector uses role="tab" (upstream ARIA convention for
  // dioxus_primitives tabs); panel assertion prefers data-state/visibility
  // over innerText per the file-header comment.
  const tabs = page.locator("#demo-tabs");
  await expect(tabs).toBeVisible();
  const tabTriggers = tabs.locator('[role="tab"]');
  const tabCount = await tabTriggers.count();
  expect(tabCount, "#demo-tabs must have at least two tab triggers").toBeGreaterThanOrEqual(2);

  const secondTabTrigger = tabTriggers.nth(1);
  await expect(secondTabTrigger).toHaveAttribute("data-state", "inactive");
  await secondTabTrigger.click();
  // Verified against the built markup: upstream tabs mark the current
  // trigger `data-state="active"` + `aria-selected="true"`, and hide the
  // other panels with the `hidden` attribute. Assert the swap on BOTH the
  // newly-selected and the previously-selected trigger — asserting only
  // the former would still pass if clicking selected everything.
  await expect(secondTabTrigger).toHaveAttribute("data-state", "active");
  await expect(secondTabTrigger).toHaveAttribute("aria-selected", "true");
  await expect(tabTriggers.nth(0)).toHaveAttribute("data-state", "inactive");
  await expect(tabs.locator('[role="tabpanel"]').nth(1)).toBeVisible();
  await expect(tabs.locator('[role="tabpanel"]').nth(0)).toBeHidden();

  // 4) Accordion: clicking the first trigger expands its content.
  const accordion = page.locator("#demo-accordion-p");
  await expect(accordion).toBeVisible();
  const accordionTriggers = accordion.locator("button.dx-accordion-trigger");
  const accordionTriggerCount = await accordionTriggers.count();
  expect(accordionTriggerCount, "#demo-accordion-p must have at least one item trigger").toBeGreaterThanOrEqual(1);

  const firstAccordionTrigger = accordionTriggers.nth(0);
  // Verified against the built markup: upstream accordion uses
  // `data-open="true"|"false"` on the item and content (NOT `data-state`,
  // which is what tabs use), plus `aria-expanded` on the trigger. The
  // content element is only mounted once opened.
  await expect(firstAccordionTrigger).toHaveAttribute("aria-expanded", "false");
  await firstAccordionTrigger.click();
  await expect(firstAccordionTrigger).toHaveAttribute("aria-expanded", "true");
  const openContent = accordion.locator('.dx-accordion-content[data-open="true"]');
  await expect(openContent).toBeVisible();
  await expect(openContent).toContainText(/\S/);

  // 5) Zero collected page errors / console errors throughout.
  const collectedErrors = await page.evaluate(() =>
    (globalThis as unknown as { __e2eErrors: unknown[] }).__e2eErrors
  );
  expect(collectedErrors, "no onError/window.onerror/unhandledrejection ever fired").toEqual([]);
  expect(pageErrors, "no uncaught page exceptions").toEqual([]);
  expect(consoleErrors, "no console.error output").toEqual([]);
});
