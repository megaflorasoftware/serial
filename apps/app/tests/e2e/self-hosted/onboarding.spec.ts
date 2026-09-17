import { createClient } from "@libsql/client";
import { expect, test } from "@playwright/test";
import { signIn } from "../fixtures/auth";
import { cleanupUser, seedArticleData } from "../fixtures/seed-db";
import {
  SELF_HOSTED_APP_PORT,
  SELF_HOSTED_RSS_SERVER_PORT,
  SELF_HOSTED_TURSO_PORT,
} from "../fixtures/ports";
import type { Page } from "@playwright/test";

// Network stubs must intercept requests before a service worker handles them.
test.use({ serviceWorkers: "block" });

let email = "";
async function start(page: Page, step = "introduction") {
  const fixture = await seedArticleData(
    SELF_HOSTED_TURSO_PORT,
    SELF_HOSTED_APP_PORT,
    SELF_HOSTED_RSS_SERVER_PORT,
  );
  email = fixture.email;
  const db = createClient({
    url: `http://127.0.0.1:${SELF_HOSTED_TURSO_PORT}`,
  });
  try {
    await db.execute({
      sql: "UPDATE serial_user SET onboarding_complete = 0, onboarding_step = ? WHERE email = ?",
      args: [`2026-09-16-${step}`, email],
    });
    await db.execute({
      sql: "UPDATE serial_feed SET name = ? WHERE id = (SELECT id FROM serial_feed WHERE user_id = (SELECT id FROM serial_user WHERE email = ?) LIMIT 1)",
      args: ["Weekend reading", email],
    });
  } finally {
    db.close();
  }
  await signIn({ page, email, password: fixture.password, onboarding: true });
}
async function savedProgress() {
  const db = createClient({
    url: `http://127.0.0.1:${SELF_HOSTED_TURSO_PORT}`,
  });
  try {
    return (
      await db.execute({
        sql: "SELECT onboarding_complete, onboarding_step FROM serial_user WHERE email = ?",
        args: [email],
      })
    ).rows[0];
  } finally {
    db.close();
  }
}
const guide = (page: Page) =>
  page.getByRole("region", { name: "Onboarding guidance" });
test.afterEach(async () => {
  if (email) await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
});

test("advances despite a failed progress write and resumes the last saved step", async ({
  page,
}) => {
  await start(page);
  await page.route("**/api/rpc/onboarding/saveProgress", (route) =>
    route.abort(),
  );
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Make yourself at home" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Get started", exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/rpc/onboarding/saveProgress");
  await page
    .getByRole("button", { name: "Skip Onboarding", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Skip onboarding", exact: true })
    .click();
  await expect
    .poll(async () => (await savedProgress())?.onboarding_complete)
    .toBe(1);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Skip Onboarding", exact: true }),
  ).toHaveCount(0);
});

for (const mobile of [false, true]) {
  test(`guides View creation, preserves drafts on canceled skip, and closes selectors first ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    );
    await start(page, "create-view");
    await expect(guide(page)).toContainText("Open the menu", {
      timeout: 30000,
    });
    await page.locator('[data-onboarding="open-menu"]').click();
    await page.getByRole("button", { name: "Add View", exact: true }).click();
    const name = page.locator('[data-onboarding="name-view"]');
    await expect(name).toBeFocused();
    await name.fill("My reading");
    if (mobile) {
      await page.setViewportSize({ width: 390, height: 420 });
      await expect
        .poll(async () => {
          const helper = await guide(page).boundingBox();
          const input = await name.boundingBox();
          return (
            helper &&
            input &&
            (helper.y + helper.height <= input.y ||
              input.y + input.height <= helper.y)
          );
        })
        .toBeTruthy();
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await page
      .getByRole("button", { name: "Skip Onboarding", exact: true })
      .click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Keep going" }).click();
    await expect(name).toHaveValue("My reading");
    await expect(name).toBeFocused();
    if (mobile) {
      const drawer = page.locator("[data-vaul-drawer]").last();
      await expect(drawer).toBeInViewport();
      // Vaul ignores dismiss gestures during its opening animation.
      await drawer.evaluate(async (element) => {
        await Promise.all(
          element.getAnimations().map((animation) => animation.finished),
        );
      });
      const bounds = (await drawer.boundingBox())!;
      // The helper can cover the centered handle. Swipe from the exposed edge
      // of the drawer so this tests dismissal rather than dragging the helper.
      const swipeX = bounds.x + bounds.width - 12;
      await page.mouse.move(swipeX, bounds.y + 20);
      await page.mouse.down();
      await page.mouse.move(swipeX, Math.min(830, bounds.y + 420), {
        steps: 12,
      });
      await page.mouse.up();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      await page.getByRole("button", { name: "Keep going" }).click();
      await expect(name).toHaveValue("My reading");
      await expect(name).toBeInViewport();
    }
    // A dimmed control blurs the name without activating that control.
    await name.fill("");
    await page.mouse.click(
      page.viewportSize()!.width - 8,
      page.viewportSize()!.height / 2,
    );
    await expect(name).not.toBeFocused();
    await expect(guide(page)).toContainText("Give your View a name");
    await expect(
      page.getByRole("tab", { name: "Content", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await name.fill("My reading");
    await page.mouse.click(
      page.viewportSize()!.width - 8,
      page.viewportSize()!.height / 2,
    );
    await expect(guide(page)).toContainText("Click +");
    await expect(
      page.getByRole("tab", { name: "Content", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Add feeds", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByPlaceholder("Search feeds...")).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Add feeds", exact: true }).click();
    await page
      .getByRole("option", { name: "Weekend reading", exact: true })
      .click();
    await expect(page.getByPlaceholder("Search feeds...")).toHaveCount(0);
    await page.getByRole("tab", { name: "Display", exact: true }).click();
    await expect(guide(page).getByRole("button", { name: "Next" })).toHaveCount(
      0,
    );
    await page.getByRole("tab", { name: "Content", exact: true }).click();
    await page.locator('[data-onboarding="name-view"]').fill("My reading");
    await page.getByRole("tab", { name: "Display", exact: true }).click();
    await page.getByRole("button", { name: "Large List", exact: true }).click();
    const layoutPopup = page.locator('[data-slot="popover-content"]').filter({
      has: page.getByRole("button", { name: "Large Grid", exact: true }),
    });
    await expect(layoutPopup).toBeVisible();
    await expect
      .poll(async () => {
        const bounds = (await layoutPopup.boundingBox())!;
        return page
          .locator("[data-guidance-layer] svg path")
          .evaluate((path, box) => {
            const shape = path as SVGPathElement;
            const point = new DOMPoint(
              box.x + 12,
              box.y + box.height - 12,
            ).matrixTransform(shape.getScreenCTM()!.inverse());
            return shape.isPointInFill(point);
          }, bounds);
      })
      .toBe(false);
    await page.getByRole("button", { name: "Large Grid", exact: true }).click();
    await expect(layoutPopup).toHaveCount(0);
    await page.getByRole("button", { name: "Large Grid", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(layoutPopup).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    let unblock!: () => void;
    const pending = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    await page.route("**/api/rpc/view/create", async (route) => {
      await pending;
      await route.continue();
    });
    await page.locator('[data-onboarding="save-view"]').click();
    await expect(page.locator('[data-onboarding="save-view"]')).toHaveText(
      "Adding...",
    );
    expect((await savedProgress())?.onboarding_step).toBe(
      "2026-09-16-create-view",
    );
    unblock();
    await expect
      .poll(async () => (await savedProgress())?.onboarding_step)
      .toBe("2026-09-16-atmosphere-sync-setup");
    await expect(guide(page)).toContainText("Use these chips");
    await expect(page.locator("[data-guidance-layer] svg")).toHaveCount(0);
    await expect(page.locator('[data-onboarding="view-chips"]')).toContainText(
      "My reading",
    );
    await guide(page).getByRole("button", { name: "Next" }).click();
    await expect(
      page.getByRole("heading", { name: "Ready to explore" }),
    ).toBeVisible();
    await expect
      .poll(async () => (await savedProgress())?.onboarding_complete)
      .toBe(1);
  });
}

for (const mobile of [false, true]) {
  test(`default colors, optional URL copying, and manual Feed menu entry ${mobile ? "mobile" : "desktop"}`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    );
    await start(page, "choose-colors");
    await page.getByRole("button", { name: "Amber", exact: true }).click();
    await page.getByRole("button", { name: "Default", exact: true }).click();
    const themeSave = page.waitForRequest("**/api/rpc/userConfig/setThemePair");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    expect((await themeSave).postDataJSON().json).toEqual({
      light: [60, 10, 100],
      dark: [60, 10, 15],
    });
    await expect(
      page.getByRole("textbox", { name: "Suggested website" }),
    ).toHaveValue("www.serial.tube");
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "Suggested website" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return ["light", "dark"].map((mode) =>
          ["hue", "sat", "lgt"].map((part) =>
            parseFloat(style.getPropertyValue(`--${mode}-${part}`)),
          ),
        );
      }),
    ).toEqual([
      [60, 10, 100],
      [60, 10, 15],
    ]);
    await page.getByRole("button", { name: "Copy website address" }).click();
    await expect(
      page.getByText("Website address copied.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Suggested website" }),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "www.serial.tube",
    );
    // Next also works on a fresh slide without copying the suggestion.
    await page.reload();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(guide(page)).toContainText("Open the menu to find Add Feed");
    await page
      .locator(
        mobile
          ? '[data-onboarding="open-feed-menu"]'
          : '[data-onboarding="open-menu"]',
      )
      .click();
    await expect(guide(page)).toContainText("Add a Feed to bring");
    await page
      .locator('[data-onboarding="add-feed"]')
      .filter({ visible: true })
      .click();
    await expect(guide(page)).toContainText("Enter a website address");
    const search = page.locator('[data-onboarding="find-feed"] input');
    await search.fill("https://example.com/my-favorite-site");
    await expect(search).toHaveValue("https://example.com/my-favorite-site");
  });
}

const connected = {
  isConnected: true,
  needsReconnect: false,
  handle: "reader.test",
  isConfigured: true,
  hasWriteScope: false,
  syncPreferences: { method: "none", importAsInactive: false },
};
test("saves unchanged sync preferences and stays on the slide after a failure", async ({
  page,
}) => {
  await page.route("**/api/rpc/atproto/getConnectionStatus**", (route) =>
    route.fulfill({ json: { json: connected } }),
  );
  await start(page, "atmosphere-sync-setup");
  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect(next).toBeEnabled({ timeout: 30000 });
  await page.route("**/api/rpc/atproto/saveSyncSettings", (route) =>
    route.abort(),
  );
  await next.click();
  await expect(next).toBeEnabled({ timeout: 30000 });
  expect((await savedProgress())?.onboarding_complete).toBe(0);
  await page.unroute("**/api/rpc/atproto/saveSyncSettings");
  await page.route("**/api/rpc/atproto/saveSyncSettings", (route) =>
    route.fulfill({ json: { json: { saved: true } } }),
  );
  await next.click();
  await expect(
    page.getByRole("heading", { name: "Ready to explore" }),
  ).toBeVisible();
});

for (const result of ["denied", "success"]) {
  test(`resumes the sync slide on consent ${result}`, async ({ page }) => {
    await page.route("**/api/rpc/atproto/getConnectionStatus**", (route) =>
      route.fulfill({ json: { json: connected } }),
    );
    await start(page, "atmosphere-sync-setup");
    await expect(
      page.getByRole("heading", { name: "Your Atmosphere subscriptions" }),
    ).toBeVisible({ timeout: 30000 });
    await page.goto(`/?atproto_consent=${result}`);
    await expect(
      page.getByRole("heading", {
        name:
          result === "success"
            ? "Ready to explore"
            : "Your Atmosphere subscriptions",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Connections", exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(async () => (await savedProgress())?.onboarding_complete)
      .toBe(result === "success" ? 1 : 0);
  });
}

test("a pending theme save cannot reopen onboarding after confirmed skip", async ({
  page,
}) => {
  await start(page, "choose-colors");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/rpc/userConfig/setThemePair", async (route) => {
    await pending;
    await route.continue();
  });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saving..." })).toBeVisible();
  await page
    .getByRole("button", { name: "Skip Onboarding", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Skip onboarding", exact: true })
    .click();
  const saved = page.waitForResponse("**/api/rpc/userConfig/setThemePair");
  release();
  await saved;
  await expect
    .poll(async () => (await savedProgress())?.onboarding_complete)
    .toBe(1);
  await expect(
    page.getByRole("button", { name: "Copy website address" }),
  ).toHaveCount(0);
});
