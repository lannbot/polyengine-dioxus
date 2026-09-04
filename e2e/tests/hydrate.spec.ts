// Real-browser (Chromium via Playwright) E2E test for HYDRATION of the
// counter example: the page arrives with the app's markup already in it and
// the client adopts those exact nodes.
//
// Governing docs / authorities:
//   - host/tests/hydrate_component_test.ts: authoritative for what
//     hydration must preserve (mirrors it, but drives real user input and a
//     real browser instead of linkedom + `mounted.dispatch(...)`).
//   - wit/world.wit, `interface mutations`' `hydrate` type and world `app`'s
//     `render-mode`: the contract.
//   - e2e/server.ts `serveHydratePage`: synthesizes `/hydrate.html` and
//     stamps every server-rendered element with `data-server-rendered`.
//   - examples/counter/src/lib.rs: authoritative for element ids/structure.
//
// The stamp is the whole point. Hydration that silently re-rendered would
// produce a visually identical page that passes every text assertion — and
// fail here, because the replacement nodes carry no stamp.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const repoRoot = join(new URL(".", import.meta.url).pathname, "..", "..");

function hydrateUrl(): string {
  const url = process.env.E2E_BASE_URL;
  if (!url) throw new Error("E2E_BASE_URL not set — did global-setup.ts run?");
  return new URL("/hydrate.html?app=counter", url).toString();
}

test.beforeEach(() => {
  for (
    const [path, recipe] of [
      ["examples/build/counter.component.wasm", "just example counter"],
      ["examples/counter/golden.html", "just ssg-example counter"],
    ] as const
  ) {
    if (!existsSync(join(repoRoot, path))) {
      throw new Error(`${path} missing — run \`${recipe}\` first (\`just e2e\` does this for you).`);
    }
  }
});

test("counter example: hydrates server-rendered markup in Chromium", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.stack ?? err.message));

  await page.goto(hydrateUrl());

  // Before the client boots, the markup is already the finished page — this
  // is what a user sees with JS still downloading, and it is the reason to
  // prerender at all.
  await expect(page.locator("#count")).toHaveText("0");
  await expect(page.locator("#parity")).toHaveText("count is 0");
  await expect(page.locator("#items li")).toHaveText(["alpha", "beta"]);

  await page.waitForFunction(() => (globalThis as unknown as { __mounted?: boolean }).__mounted === true);
  expect(await page.evaluate(() => (globalThis as unknown as { __mountFailed?: boolean }).__mountFailed)).toBeFalsy();

  // The server's marker comments are consumed by the hydrate operation.
  expect(await page.evaluate(() => document.getElementById("app")!.innerHTML)).not.toContain("node-id");

  // Adoption, not re-creation: the live nodes still carry the stamp the
  // page put on them before any component code ran.
  const stamped = (selector: string) =>
    page.evaluate(
      (s) => document.querySelector(s)?.getAttribute("data-server-rendered"),
      selector,
    );
  expect(await stamped("#count")).toBe("1");
  expect(await stamped("#parity")).toBe("1");
  expect(await stamped("#items li")).toBe("1");

  // Listeners are live, and they reach the guest through ordinary
  // new-event-listener ops rather than the marker's `,click:1` suffix,
  // which the host ignores (host/src/applier.ts's hydrate).
  await page.locator("#inc").click();
  await expect(page.locator("#count")).toHaveText("1");
  await expect(page.locator("#parity")).toHaveText("count is 1");
  await expect(page.locator("#parity")).toHaveClass("odd");

  // ...and the re-render mutated the adopted node rather than replacing it.
  // A misbound id would have updated some other node, leaving this stamp
  // intact but the text wrong — or replaced the node, dropping the stamp.
  expect(await stamped("#count")).toBe("1");
  expect(await stamped("#parity")).toBe("1");

  // The empty dynamic text (#echo renders as `<!--node-id7--><!--#-->`, with
  // no text node for the host to adopt, so it creates one) accepts input.
  await page.locator("#draft").fill("hello");
  await expect(page.locator("#echo")).toHaveText("hello");

  // Structural mutation around adopted children.
  await page.locator("#add").click();
  await expect(page.locator("#items li")).toHaveText(["alpha", "beta", "item-0"]);
  expect(await stamped("#items li")).toBe("1");
  await page.locator("#remove").click();
  await expect(page.locator("#items li")).toHaveText(["alpha", "beta"]);

  // prevent_default through a hydrated form: a real submit would navigate.
  await page.locator("#submit").click();
  await expect(page.locator("#submitted")).toHaveText("submitted 1 time(s)");
  expect(page.url()).toBe(hydrateUrl());

  expect(await page.evaluate(() => (globalThis as unknown as { __e2eErrors: unknown[] }).__e2eErrors)).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
