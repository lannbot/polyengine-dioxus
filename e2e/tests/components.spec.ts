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

// JS-free Dialog/Tooltip adaptations (examples/components/src/jsfree.rs).
// These replace the upstream dioxus_components Dialog/Tooltip, which trap
// under this renderer, where wasm-bindgen has no working implementation. The point
// of this test is that the replacements are real browser behaviour, not
// just compiling code: CSS-driven tooltip visibility, and a dialog whose
// escape/backdrop/close paths all run through plain Dioxus handlers.
test("components example: JS-free tooltip and dialog behave in a real browser", async ({ page }) => {
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
  await page.waitForFunction(() => (globalThis as unknown as { __mounted?: boolean }).__mounted === true, {
    timeout: 15_000,
  });
  await expect(page.locator("#showcase")).toBeVisible();

  // --- Tooltip -----------------------------------------------------------
  // Hidden via `invisible` (not merely opacity-0), so Playwright's
  // visibility model agrees with the user-visible state.
  const tooltip = page.locator("#demo-tooltip");
  const trigger = page.locator("#demo-tooltip-trigger");
  await expect(tooltip).toBeAttached();
  await expect(tooltip).toBeHidden();

  // group-hover path. The open delay is CSS `delay-300` on a visibility
  // transition, so give toBeVisible room to auto-wait past it.
  await trigger.hover();
  await expect(tooltip).toBeVisible({ timeout: 5_000 });

  // Moving the pointer off the group hides it again (same delay applies).
  await page.locator("#showcase h2").first().hover();
  await expect(tooltip).toBeHidden({ timeout: 5_000 });

  // group-focus-within path: keyboard users get the tooltip too.
  await trigger.focus();
  await expect(tooltip).toBeVisible({ timeout: 5_000 });
  await trigger.blur();
  await expect(tooltip).toBeHidden({ timeout: 5_000 });

  // --- Dialog ------------------------------------------------------------
  const dialog = page.locator("#demo-dialog");
  const openBtn = page.locator("#demo-dialog-open");
  await expect(dialog).toHaveCount(0);

  // Open. Initial focus lands on the close button with no user action:
  // the button's `onmounted` handler calls MountedData::set_focus, backed
  // by the `dom.set-focus` import (wit/world.wit). No Tab, no autofocus.
  await openBtn.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Dialog body");
  await expect(page.locator("#demo-dialog-close")).toBeFocused();

  // Tab trap: focus cannot leave the dialog. Tabbing off the last control
  // lands on an sr-only focus guard whose onfocusin bounces focus back
  // inside, so every one of these presses leaves activeElement within
  // #demo-dialog (the guards are inside the panel too).
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => document.activeElement?.closest("#demo-dialog") !== null);
    expect(inside, `focus escaped #demo-dialog after Tab #${i + 1}`).toBe(true);
  }

  // Backwards too — this is the leading guard, which the forward loop
  // above never reaches (focus cycles close -> trailing guard -> close).
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#demo-dialog-close")).toBeFocused();

  // Escape closes. No Tab needed first: focus has been inside the dialog
  // since it opened.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Backdrop click closes: click far outside the centred panel.
  await openBtn.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(dialog).toHaveCount(0);

  // Explicit close button closes (and its stop_propagation does not
  // interfere).
  await openBtn.click();
  await expect(dialog).toBeVisible();
  await page.locator("#demo-dialog-close").click();
  await expect(dialog).toHaveCount(0);

  const collectedErrors = await page.evaluate(() =>
    (globalThis as unknown as { __e2eErrors: unknown[] }).__e2eErrors
  );
  expect(collectedErrors, "no onError/window.onerror/unhandledrejection ever fired").toEqual([]);
  expect(pageErrors, "no uncaught page exceptions").toEqual([]);
  expect(consoleErrors, "no console.error output").toEqual([]);
});

// MountedData round trip against a real layout engine.
//
// The five non-focus RenderedElementBacking methods (get_client_rect,
// get_scroll_size, get_scroll_offset, scroll, scroll_to) are covered
// host-side by unit tests running under linkedom, which has no layout
// engine — there, every box is zero-sized and nothing scrolls. So the
// assertions below (a width that is actually > 0, a scroll size that
// actually exceeds the client size, a scrollTop that actually moves) are
// the only proof that the guest -> host -> guest round trip works, record
// and enum conversions included.
test("components example: MountedData queries round-trip through real layout", async ({ page }) => {
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
  await page.waitForFunction(() => (globalThis as unknown as { __mounted?: boolean }).__mounted === true, {
    timeout: 15_000,
  });
  await expect(page.locator("#showcase")).toBeVisible();

  const rectWidth = page.locator("#rect-width");
  const rectHeight = page.locator("#rect-height");
  const scrollHeight = page.locator("#scroll-height");
  const scrollTop = page.locator("#scroll-top");
  const num = async (loc: typeof rectWidth) => Number(await loc.textContent());

  // -1 is the example's "not measured yet" sentinel; -2 is "MountedResult
  // came back Err". Starting from -1 is what keeps a genuine 0 (the
  // unscrolled scrollTop) distinguishable from a query that never ran.
  await expect(page.locator("#demo-scrollbox")).toBeVisible();
  for (const loc of [rectWidth, rectHeight, scrollHeight, scrollTop]) {
    await expect(loc).toHaveText("-1");
  }

  // Measure.
  await page.locator("#demo-measure").click();
  await expect(rectWidth).not.toHaveText("-1");
  await expect(scrollTop).not.toHaveText("-1");

  const w = await num(rectWidth);
  const h = await num(rectHeight);
  const sh = await num(scrollHeight);
  const st0 = await num(scrollTop);
  console.log(`measured: rect ${w}x${h}, scrollHeight ${sh}, scrollTop ${st0}`);

  // Real layout: a bordered 16rem x 6rem box has a nonzero client rect.
  expect(w, "client rect width must be real layout, not linkedom's zero").toBeGreaterThan(0);
  expect(h, "client rect height must be real layout, not linkedom's zero").toBeGreaterThan(0);
  // 20 rows in a fixed-height box: the content genuinely overflows.
  expect(sh, "scroll height must exceed client height (content overflows)").toBeGreaterThan(h);
  // Not scrolled yet.
  expect(st0, "scroll offset starts at 0").toBe(0);

  // Mutating op with an enum operand (ScrollBehavior::Instant), then
  // re-measure: the scroll actually took effect in the DOM.
  await page.locator("#demo-scroll").click();
  await page.locator("#demo-measure").click();
  await expect(scrollTop).not.toHaveText(String(st0));
  const st1 = await num(scrollTop);
  console.log(`after scroll: scrollTop ${st1}`);
  expect(st1, "scroll(0, 120) must move the box's scrollTop").toBeGreaterThan(0);

  // No MountedResult errors anywhere.
  for (const loc of [rectWidth, rectHeight, scrollHeight, scrollTop]) {
    expect(Number(await loc.textContent()), "no field may report the -2 query-failed sentinel").not.toBe(-2);
  }

  const collectedErrors = await page.evaluate(() =>
    (globalThis as unknown as { __e2eErrors: unknown[] }).__e2eErrors
  );
  expect(collectedErrors, "no onError/window.onerror/unhandledrejection ever fired").toEqual([]);
  expect(pageErrors, "no uncaught page exceptions").toEqual([]);
  expect(consoleErrors, "no console.error output").toEqual([]);
});

// scroll_to (the scrollIntoView wrapper) — a sibling test rather than an
// extension of the one above, because it asserts window.scrollY === 0 at
// the start and Playwright's click auto-scrolling would have already moved
// the page by the end of the measurement test.
//
// This is the conversion-heaviest method on RenderedElementBacking: its
// ScrollToOptions carries three enum values, two of which are the same type
// (ScrollLogicalPosition) in different fields. The example passes Start for
// `vertical` and Nearest for `horizontal` deliberately — with equal values
// a conversion that transposed or collapsed the fields would behave
// identically and prove nothing.
test("components example: scroll_to brings an off-screen element into view", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.stack ?? err.message));

  await page.goto(baseUrl());
  await page.waitForFunction(() => (globalThis as unknown as { __mounted?: boolean }).__mounted === true, {
    timeout: 15_000,
  });
  await expect(page.locator("#showcase")).toBeVisible();

  const status = page.locator("#scroll-to-status");
  const target = page.locator("#demo-scroll-target");
  await expect(status).toHaveText("scroll-to-idle");

  const viewport = page.viewportSize();
  if (!viewport) throw new Error("no viewport size (headless run should always have one)");

  // Geometry, not isVisible(): Playwright counts an off-screen-but-rendered
  // element as visible, so only the bounding box can establish that the
  // target starts outside the viewport.
  const scrollYBefore = await page.evaluate(() => window.scrollY);
  const boxBefore = await target.boundingBox();
  if (!boxBefore) throw new Error("#demo-scroll-target has no bounding box");
  console.log(
    `scroll_to before: scrollY ${scrollYBefore}, target box y=${Math.round(boxBefore.y)} ` +
      `h=${Math.round(boxBefore.height)}, viewport h=${viewport.height}`,
  );
  expect(scrollYBefore, "page must start at the top").toBe(0);
  expect(boxBefore.y, "target must start below the fold").toBeGreaterThan(viewport.height);

  await page.locator("#demo-scroll-into-view").click();
  await expect(status).toHaveText("scroll-to-ok");

  const scrollYAfter = await page.evaluate(() => window.scrollY);
  const boxAfter = await target.boundingBox();
  if (!boxAfter) throw new Error("#demo-scroll-target lost its bounding box");
  console.log(
    `scroll_to after:  scrollY ${Math.round(scrollYAfter)}, target box y=${Math.round(boxAfter.y)} ` +
      `h=${Math.round(boxAfter.height)}`,
  );

  expect(scrollYAfter, "scroll_to must have scrolled the page").toBeGreaterThan(0);
  // Fully inside the viewport now.
  expect(boxAfter.y, "target's top edge must be inside the viewport").toBeGreaterThanOrEqual(0);
  expect(boxAfter.y + boxAfter.height, "target's bottom edge must be inside the viewport")
    .toBeLessThanOrEqual(viewport.height);
  // And specifically flush with the TOP of the viewport, which is what
  // `vertical: Start` means. This is the assertion that discriminates the
  // enum: Center would land the box near viewport.height / 2, End and
  // Nearest (scrolling downward) near the bottom. It is therefore also what
  // catches a vertical/horizontal transposition in the conversion — the
  // example passes Nearest for `horizontal`, so a swap would show up here
  // as a bottom-aligned box.
  expect(boxAfter.y, "vertical: Start must align the target's top edge with the viewport top")
    .toBeLessThanOrEqual(2);

  const collectedErrors = await page.evaluate(() =>
    (globalThis as unknown as { __e2eErrors: unknown[] }).__e2eErrors
  );
  expect(collectedErrors, "no onError/window.onerror/unhandledrejection ever fired").toEqual([]);
  expect(pageErrors, "no uncaught page exceptions").toEqual([]);
});

// onresize / onvisible against real observers.
//
// A new test rather than an extension of an existing one: the subject is
// different (the two synthesized observer event families, not
// MountedData's element queries) and, like the scroll_to test, it depends
// on the page starting at the top — the "not intersecting yet" assertion
// below is only meaningful before any click has auto-scrolled the page.
//
// `resize` and `visible` are not DOM events; the host synthesizes them
// from a ResizeObserver and an IntersectionObserver. The host-side unit
// tests run under linkedom, which has neither, so they hand-build entry
// objects: they cover the serializer's arithmetic and cannot say whether
// an observer is ever constructed, ever observes the element, or ever
// delivers a callback. This test is the only thing that can.
test("components example: onresize/onvisible are driven by real observers", async ({ page }) => {
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
  await page.waitForFunction(() => (globalThis as unknown as { __mounted?: boolean }).__mounted === true, {
    timeout: 15_000,
  });
  await expect(page.locator("#showcase")).toBeVisible();

  const resizeWidth = page.locator("#resize-width");
  const resizeHeight = page.locator("#resize-height");
  const visIntersecting = page.locator("#visible-intersecting");
  const visRatio = page.locator("#visible-ratio");

  // --- Initial delivery on observe ---------------------------------------
  // Both observers invoke their callback once as soon as they observe an
  // element, so both readouts must leave their sentinels with no user
  // interaction whatsoever. That alone establishes that the observers were
  // actually constructed and wired to these elements.
  //
  // The example sets #demo-resize-box to exactly 160x96 CSS px via inline
  // `style:` (never a viewport-relative unit), with no border or padding,
  // so under `box-sizing: border-box` the border box is exactly those two
  // numbers on any viewport. 160 and 96 are deliberately different: a
  // writing-mode mapping that transposed inlineSize/blockSize onto
  // width/height would report 96 here and fail.
  await expect(resizeWidth).toHaveText("160");
  await expect(resizeHeight).toHaveText("96");

  // #demo-visible-target sits a full 120vh below its section, so it is
  // off-screen at load regardless of window size — the initial
  // IntersectionObserver callback must therefore report not-intersecting.
  // "visible-unknown" is the example's never-observed sentinel; seeing it
  // here would mean the observer never fired.
  await expect(visIntersecting).toHaveText("visible-no");
  const ratioBefore = Number(await visRatio.textContent());
  console.log(`observers: initial intersection ratio ${ratioBefore}`);
  expect(ratioBefore, "an off-screen element has zero intersection ratio").toBe(0);

  // --- Resize fires on change, with correct numbers ----------------------
  // The toggle switches the inline width to 240px; the height is untouched.
  // Asserting both catches a handler that writes one field from the other.
  await page.locator("#demo-resize-toggle").click();
  await expect(resizeWidth).toHaveText("240");
  await expect(resizeHeight).toHaveText("96");

  // And back, so the readout is proven to track the element rather than
  // having latched a second constant.
  await page.locator("#demo-resize-toggle").click();
  await expect(resizeWidth).toHaveText("160");
  await expect(resizeHeight).toHaveText("96");

  // --- Visible flips when the target enters the viewport -----------------
  // The flip is the proof: a readout stuck at one state could be a
  // constant. Scrolling is done by the browser, not by the guest, so this
  // exercises the observer itself rather than any scroll API.
  await page.locator("#demo-visible-target").scrollIntoViewIfNeeded();
  await expect(visIntersecting).toHaveText("visible-yes");
  // The target is a ~30px bordered box now fully inside the viewport, so
  // the ratio must be essentially 1. expect.poll auto-waits (no fixed
  // sleep) because the observer may deliver an entry mid-scroll first.
  await expect.poll(async () => Number(await visRatio.textContent()), {
    message: "a fully in-view target must report an intersection ratio of ~1",
  }).toBeGreaterThan(0.9);
  const ratioAfter = Number(await visRatio.textContent());
  console.log(`observers: intersection ratio after scrolling into view ${ratioAfter}`);
  expect(ratioAfter, "intersection ratio is a fraction, never above 1").toBeLessThanOrEqual(1);

  const collectedErrors = await page.evaluate(() =>
    (globalThis as unknown as { __e2eErrors: unknown[] }).__e2eErrors
  );
  expect(collectedErrors, "no onError/window.onerror/unhandledrejection ever fired").toEqual([]);
  expect(pageErrors, "no uncaught page exceptions").toEqual([]);
  expect(consoleErrors, "no console.error output").toEqual([]);
});
