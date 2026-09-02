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

  // 5) The sections added once the guest moved to wasm32-wasip2 (clock
  // available) and the "include eval-degraded components too" directive.
  // These assert *presence and shape*, never eval-driven behaviour — see
  // examples/primitives/src/lib.rs's compatibility matrix for what each of
  // these deliberately does not do here.
  for (
    const id of [
      "#demo-p-dialog-open",
      "#demo-p-alert-open",
      "#demo-p-popover-open",
      "#demo-p-calendar",
      "#demo-p-date-picker",
      "#checkbox-p-state",
    ]
  ) {
    await expect(page.locator(id), `${id} must render`).toBeVisible();
  }

  // Calendar renders a real month grid off the wasi:clocks wall clock. 44 =
  // 7 weekday headers + 5 or 6 week rows of days; assert "many cells", not an
  // exact count, since the grid size depends on the month being displayed.
  const calendarDays = page.locator("#demo-p-calendar [role=\"gridcell\"], #demo-p-calendar button");
  expect(await calendarDays.count(), "calendar must render a populated grid").toBeGreaterThan(20);

  // Drag-and-drop list: the items render. Dragging is NOT asserted — the drop
  // target is decided by an eval-installed document listener, so mouse drag
  // cannot work here (keyboard reordering is the working path upstream).
  expect(await page.locator(".dx-dnd-list-item").count(), "dnd list must render its items").toBe(3);

  // 6) Dialog interaction: the trigger opens it and the content appears.
  // Deliberately NOT asserted: escape-to-close, outside-click dismissal and
  // the focus trap, all of which need document::eval.
  await expect(page.locator(".dx-dialog")).toBeHidden();
  await page.locator("#demo-p-dialog-open").click();
  await expect(page.locator(".dx-dialog")).toBeVisible();
  await expect(page.locator(".dx-dialog")).toContainText("Item information");
  await page.locator("#demo-p-dialog-close").click();

  // 7) Timers. `#progress-delayed` sleeps 300ms through
  // `dioxus_sdk_time::sleep` before bumping `#progress-value` by 25. The
  // workspace patches that crate to a fork whose `wasip3` feature waits on
  // `wasi:clocks/monotonic-clock`; unpatched, the wait reaches a wasm-bindgen
  // stub that aborts the instance on wasm32-wasip2 and the value never moves.
  //
  // Both halves matter: unchanged immediately after the click (a real
  // deferral, not a synchronous update), then reaching the new value (the
  // clock actually fires).
  const progressValue = page.locator("#progress-value");
  const beforeDelay = await progressValue.textContent();
  const expectedAfter = String(Number(beforeDelay) + 25);
  await page.locator("#progress-delayed").click();
  expect(await progressValue.textContent(), "the 300ms wait must not resolve synchronously").toBe(beforeDelay);
  await expect(progressValue).toHaveText(expectedAfter, { timeout: 5_000 });

  // 8) Zero collected page errors / console errors throughout.
  const collectedErrors = await page.evaluate(() =>
    (globalThis as unknown as { __e2eErrors: unknown[] }).__e2eErrors
  );
  // The load-bearing assertion for the eval-degraded additions: dioxus's
  // NoOpDocument answers eval with EvalError::Unsupported, so those calls
  // must degrade silently. Anything that trapped instead surfaces here as a
  // "guest trapped: unreachable" onError entry.
  expect(collectedErrors, "no onError/window.onerror/unhandledrejection ever fired").toEqual([]);
  expect(pageErrors, "no uncaught page exceptions").toEqual([]);
  expect(consoleErrors, "no console.error output").toEqual([]);
});
