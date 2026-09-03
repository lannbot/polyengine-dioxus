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

  // Drag-and-drop list. The <ul>'s own `ondragover`/`ondrop`
  // (drag_and_drop_list.rs:448-458) decide the reorder with no eval; the
  // eval installed at drag_and_drop_list.rs:673 only adds document-level
  // acceptance so a release OUTSIDE the list still commits — that remains
  // unasserted here.
  const dndItems = page.locator(".dx-dnd-list-item");
  expect(await dndItems.count(), "dnd list must render its items").toBe(3);
  const dndItemText = async () => dndItems.allTextContents();
  expect(await dndItemText(), "dnd list initial order").toEqual([
    "Ship the roadmap",
    "Redesign onboarding",
    "Audit webhook logs",
  ]);

  // (a) Mouse drag honours which HALF of the target item you drop on —
  // regression coverage for host/src/events.ts previously dispatching
  // drag-family events with `{ kind: "empty" }` (no coordinates), which
  // made `event.client_coordinates().y` always read 0.0 and upstream's
  // ondragover always choose "Before". Both of the following used to land
  // the dragged item at index 1 regardless of which edge was targeted.
  const lastItem = dndItems.nth(2);
  const lastBox = await lastItem.boundingBox();
  if (!lastBox) throw new Error("last dnd item has no bounding box");
  await dndItems.nth(0).dragTo(lastItem, { targetPosition: { x: lastBox.width / 2, y: lastBox.height - 2 } });
  expect(await dndItemText(), "dropping on the BOTTOM half of the last item must land it last").toEqual([
    "Redesign onboarding",
    "Audit webhook logs",
    "Ship the roadmap",
  ]);

  const firstItem = dndItems.nth(0);
  const firstBox = await firstItem.boundingBox();
  if (!firstBox) throw new Error("first dnd item has no bounding box");
  await dndItems.nth(2).dragTo(firstItem, { targetPosition: { x: firstBox.width / 2, y: 2 } });
  expect(await dndItemText(), "dropping on the TOP half of the first item must land it first, restoring order")
    .toEqual([
      "Ship the roadmap",
      "Redesign onboarding",
      "Audit webhook logs",
    ]);

  // (b) A keyboard grab shows a drop indicator — regression coverage for
  // examples/primitives/src/lib.rs's DndItems having overridden
  // DragAndDropListItems' children and omitted the DragAndDropDropIndicator
  // pair that harness/primitives.css:2152-2205 keys ALL drop feedback off
  // of (`.dx-drop-indicator[data-position=…] + .dx-dnd-list-item`).
  expect(await page.locator(".dx-drop-indicator").count(), "no drop indicators before a grab").toBe(0);
  await dndItems.nth(0).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  const dropIndicators = page.locator(".dx-drop-indicator");
  expect(await dropIndicators.count(), "exactly one drop indicator while grabbed and moved").toBe(1);
  await expect(dropIndicators).toHaveAttribute("data-position", "after");
  // The indicator is a sibling immediately preceding the item it sits
  // before — assert it lands between "Redesign onboarding" and "Audit
  // webhook logs", not just that some indicator exists somewhere.
  const indicatorNextSibling = await dropIndicators.evaluate((el) => el.nextElementSibling?.textContent);
  expect(indicatorNextSibling, "drop indicator must sit directly before \"Audit webhook logs\"").toContain(
    "Audit webhook logs",
  );

  // (c) The keyboard reorder commits on a second Enter: order updates,
  // indicators clear, and the live region announces the move.
  await page.keyboard.press("Enter");
  expect(await dndItemText(), "keyboard reorder must commit").toEqual([
    "Redesign onboarding",
    "Ship the roadmap",
    "Audit webhook logs",
  ]);
  expect(await page.locator(".dx-drop-indicator").count(), "drop indicators must clear after committing").toBe(0);
  await expect(page.locator("[aria-live]")).toHaveText(
    "You have dropped the item. It has moved from position 1 to position 2",
  );

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

  // 8) Select: choose an option, then exercise typeahead.
  //
  // Selectors verified against the BUILT app's DOM (inspected in Chromium, not
  // inferred from upstream source):
  //   - root      div.dx-select with data-state="closed" | "open"
  //   - trigger   <button aria-haspopup="listbox" aria-expanded="true|false">
  //               — note there is NO role="combobox" here, so don't reach for it
  //   - list      div[role="listbox"][data-state="open"], tabindex="0"
  //   - options   div[role="option"] with aria-selected / data-disabled, and a
  //               ROVING tabindex: the active option holds tabindex="0" while
  //               every other option holds "-1"
  const select = page.locator("#demo-p-select");
  const selectRoot = select.locator(".dx-select");
  const selectTrigger = select.locator('button[aria-haspopup="listbox"]');
  const selectValue = page.locator("#select-value");

  await expect(selectValue).toHaveText("none");
  await expect(selectRoot).toHaveAttribute("data-state", "closed");

  await selectTrigger.click();
  await expect(selectRoot).toHaveAttribute("data-state", "open");
  await expect(selectTrigger).toHaveAttribute("aria-expanded", "true");

  const options = select.locator('[role="option"]');
  expect(await options.count(), "select must offer its six fruits").toBe(6);

  // 8a) Typeahead — the regression witness that matters. Pressing a letter
  // with the list open runs upstream's search, which spawns a task that
  // sleeps the typeahead timeout before clearing the search buffer
  // (primitives/src/select/context.rs:69). That is the same
  // `dioxus_sdk_time::sleep` the `#progress-delayed` button exercises, but
  // reached through REAL component code rather than a purpose-built button,
  // which makes it the better guard on the wasip3 timer patch: a regression
  // there aborts the instance mid-keystroke and shows up as a page error
  // below.
  //
  // The active option is identified by the roving tabindex flipping to "0"
  // (upstream also moves DOM focus to it).
  await page.keyboard.press("d");
  await expect(
    options.filter({ hasText: "Damson" }),
    "typing 'd' must make Damson the active option",
  ).toHaveAttribute("tabindex", "0");
  await expect(options.filter({ hasText: "Apple" })).toHaveAttribute("tabindex", "-1");

  // 8b) The buffer clear itself, not just the search. The typeahead timeout is
  // 1s by default; waiting past it and pressing "b" must match "Banana". If
  // the sleep never completed, the buffer would still hold "d" and the search
  // would run for "db" — which does not match Banana. So this assertion fails
  // if the timer silently stops firing, which a focus-only check would not
  // catch.
  await page.waitForTimeout(1_500);
  await page.keyboard.press("b");
  await expect(
    options.filter({ hasText: "Banana" }),
    "after the typeahead buffer clears, 'b' must match Banana rather than searching 'db'",
  ).toHaveAttribute("tabindex", "0");

  // 8c) Committing a selection updates the readout and closes the list.
  await options.filter({ hasText: "Elderberry" }).click();
  await expect(selectValue).toHaveText("Elderberry");
  await expect(selectRoot).toHaveAttribute("data-state", "closed");
  await expect(selectTrigger).toContainText("Elderberry");

  // 9) Zero collected page errors / console errors throughout.
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
