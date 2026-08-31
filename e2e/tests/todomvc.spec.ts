// Real-browser (Chromium via Playwright) E2E test for the todomvc example.
//
// Governing docs / authorities:
//   - examples/todomvc/src/lib.rs: authoritative for markup/ids/structure
//     and behavior (ported verbatim from DioxusLabs/dioxus @ v0.7.10's
//     examples/01-app-demos/todomvc.rs — see that file's header for the
//     tiny list of lib-crate adaptations).
//   - harness/entry.ts: window hooks this test depends on (__mounted,
//     __mountedHandle, __e2eErrors, __buildStamp, __mountFailed) and the
//     `?app=todomvc` selection / stylesheet injection this test relies on.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const repoRoot = join(new URL(".", import.meta.url).pathname, "..", "..");

function baseUrl(): string {
  const url = process.env.E2E_BASE_URL;
  if (!url) throw new Error("E2E_BASE_URL not set — did global-setup.ts run?");
  return `${url}/?app=todomvc`;
}

const BENIGN_CONSOLE_PATTERNS: RegExp[] = [];

test.beforeEach(async () => {
  if (!existsSync(join(repoRoot, "examples", "build", "todomvc.component.wasm"))) {
    throw new Error(
      "examples/build/todomvc.component.wasm missing — run `just example todomvc` first " +
        "(the `just e2e` recipe does this for you).",
    );
  }
});

test("todomvc example: real click/type/edit flows through Chromium", async ({ page }) => {
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

  await page.waitForFunction(() => (globalThis as unknown as { __mounted?: boolean }).__mounted === true, {
    timeout: 15_000,
  });
  const mountFailed = await page.evaluate(() => (globalThis as unknown as { __mountFailed?: boolean }).__mountFailed);
  expect(mountFailed, "mountApp must not have thrown").toBeFalsy();

  // 1) Initial render: header present, no items, no footer (footer/toggle-all
  // are only rendered `if !todos.read().is_empty()`).
  await expect(page.locator("header.header h1")).toHaveText("todos");
  await expect(page.locator(".new-todo")).toHaveAttribute("placeholder", "What needs to be done?");
  await expect(page.locator(".todo-list li")).toHaveCount(0);
  await expect(page.locator(".footer")).toHaveCount(0);

  // 2) Add two todos via typing + real Enter keypress in .new-todo (exercises
  // KeyboardData Key::Enter through the event converter).
  const newTodo = page.locator(".new-todo");
  await newTodo.click();
  await page.keyboard.type("buy milk", { delay: 20 });
  await page.keyboard.press("Enter");
  await expect(page.locator(".todo-list li label")).toHaveText(["buy milk"]);
  await expect(newTodo).toHaveValue("");

  await page.keyboard.type("walk dog", { delay: 20 });
  await page.keyboard.press("Enter");
  await expect(page.locator(".todo-list li label")).toHaveText(["buy milk", "walk dog"]);

  await expect(page.locator(".todo-count strong")).toHaveText("2 ");
  await expect(page.locator(".todo-count")).toContainText("items left");

  // 3) Toggle the first todo via its checkbox -> li gains `completed`, count
  // updates (exercises the checkbox checked/value fold).
  const firstLi = page.locator(".todo-list li").first();
  await firstLi.locator(".toggle").click();
  await expect(firstLi).toHaveClass(/completed/);
  await expect(page.locator(".todo-count strong")).toHaveText("1 ");
  await expect(page.locator(".todo-count")).toContainText("item left");

  // 4) Filters: clicking Active/Completed/All must change the visible set
  // AND must not mutate location.hash (the handlers evt.prevent_default()
  // real `#/...` anchors — an un-prevented default would change the hash).
  const hashBefore = await page.evaluate(() => location.hash);

  await page.locator(".filters a", { hasText: "Active" }).click();
  await expect(page.locator(".todo-list li label")).toHaveText(["walk dog"]);
  expect(await page.evaluate(() => location.hash), "Active filter click must not mutate location.hash").toBe(
    hashBefore,
  );
  await expect(page.locator(".filters a.selected")).toHaveText("Active");

  await page.locator(".filters a", { hasText: "Completed" }).click();
  await expect(page.locator(".todo-list li label")).toHaveText(["buy milk"]);
  expect(await page.evaluate(() => location.hash), "Completed filter click must not mutate location.hash").toBe(
    hashBefore,
  );

  await page.locator(".filters a", { hasText: "All" }).click();
  await expect(page.locator(".todo-list li label")).toHaveText(["buy milk", "walk dog"]);
  expect(await page.evaluate(() => location.hash), "All filter click must not mutate location.hash").toBe(
    hashBefore,
  );

  // 5) Label click prevent_default: clicking a todo's label must NOT toggle
  // its checkbox (label has for="cbg-{id}" plus an onclick prevent_default).
  const secondLi = page.locator(".todo-list li").nth(1); // "walk dog", unchecked
  const secondCheckbox = secondLi.locator(".toggle");
  await expect(secondCheckbox).not.toBeChecked();
  await secondLi.locator("label").click();
  await expect(secondCheckbox).not.toBeChecked();
  await expect(secondLi).not.toHaveClass(/completed/);

  // 6) Edit flow: dblclick label -> li gains `editing` + `.edit` input
  // appears. Click into it, clear+type new text, Enter -> label text
  // updated, editing class gone. (autofocus is attribute-only here and in
  // dioxus-web, so focusing by clicking is the correct expectation.)
  await secondLi.locator("label").dblclick();
  await expect(secondLi).toHaveClass(/editing/);
  const editInput = secondLi.locator(".edit");
  await expect(editInput).toBeVisible();
  await expect(editInput).toHaveValue("walk dog");

  await editInput.click();
  await editInput.press("Control+a");
  await page.keyboard.type("walk the dog", { delay: 20 });
  await editInput.press("Enter");

  await expect(secondLi).not.toHaveClass(/editing/);
  await expect(secondLi.locator("label")).toHaveText("walk the dog");

  // 7) Destroy button removes the item; "Clear completed" appears when
  // something's checked and clears it.
  //
  // At this point: ["buy milk" (checked), "walk the dog" (unchecked)].
  await expect(page.locator(".clear-completed")).toBeVisible();

  // Destroy "walk the dog" via its .destroy button.
  await secondLi.locator(".destroy").click();
  await expect(page.locator(".todo-list li label")).toHaveText(["buy milk"]);

  // Clear completed removes "buy milk" (still checked).
  await page.locator(".clear-completed").click();
  await expect(page.locator(".todo-list li")).toHaveCount(0);
  await expect(page.locator(".footer")).toHaveCount(0);

  // 8) Zero collected page errors throughout.
  const collectedErrors = await page.evaluate(() =>
    (globalThis as unknown as { __e2eErrors: unknown[] }).__e2eErrors
  );
  expect(collectedErrors, "no onError/window.onerror/unhandledrejection ever fired").toEqual([]);
  expect(pageErrors, "no uncaught page exceptions").toEqual([]);
  expect(consoleErrors, "no console.error output").toEqual([]);
});
