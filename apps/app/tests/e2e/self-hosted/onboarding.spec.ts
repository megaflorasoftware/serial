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
      args: ["Serial Releases", email],
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
      const bounds = (await drawer.boundingBox())!;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 20);
      await page.mouse.down();
      await page.mouse.move(
        bounds.x + bounds.width / 2,
        Math.min(830, bounds.y + 420),
        { steps: 12 },
      );
      await page.mouse.up();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      await page.getByRole("button", { name: "Keep going" }).click();
      await expect(name).toHaveValue("My reading");
      await expect(name).toBeInViewport();
    }
    await guide(page).getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Add feeds", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByPlaceholder("Search feeds...")).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Add feeds", exact: true }).click();
    await page
      .getByRole("option", { name: "Serial Releases", exact: true })
      .click();
    await expect(page.getByPlaceholder("Search feeds...")).toHaveCount(0);
    await page.getByRole("tab", { name: "Display", exact: true }).click();
    await guide(page).getByRole("button", { name: "Next" }).click();
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
    await guide(page).getByRole("button", { name: "Next" }).click();
    await expect(
      page.getByRole("heading", { name: "Ready to explore" }),
    ).toBeVisible();
    await expect
      .poll(async () => (await savedProgress())?.onboarding_complete)
      .toBe(1);
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
    page.getByRole("button", { name: "Copy www.serial.tube" }),
  ).toHaveCount(0);
});
