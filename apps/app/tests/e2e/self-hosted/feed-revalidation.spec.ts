import { expect, test } from "@playwright/test";
import { signIn } from "../fixtures/auth";
import {
  SELF_HOSTED_APP_PORT,
  SELF_HOSTED_TURSO_PORT,
} from "../fixtures/ports";
import {
  cleanupUser,
  prepareFeedRevalidation,
  seedArticleData,
} from "../fixtures/seed-db";

test("revalidates from an icon button and preserves custom names and drafts", async ({
  page,
}) => {
  const fixture = await seedArticleData(
    SELF_HOSTED_TURSO_PORT,
    SELF_HOSTED_APP_PORT,
  );
  try {
    await prepareFeedRevalidation(SELF_HOSTED_TURSO_PORT, fixture.feedItemId);
    await signIn({ page, email: fixture.email, password: fixture.password });
    const openEditor = async (name: string) => {
      const row = page
        .locator('[data-slot="sidebar-menu-item"]')
        .filter({ has: page.getByText(name, { exact: true }) });
      await expect(row).toBeVisible();
      await row.locator("button").last().click();
    };
    await openEditor("Old Feed name");
    const dialog = page.getByRole("dialog");
    const button = dialog.getByRole("button", {
      name: "Revalidate Feed",
      exact: true,
    });
    await expect(button).toHaveText("");
    await dialog.getByLabel("Name", { exact: true }).focus();
    await page.mouse.move(10, 10);
    await expect(button.locator("svg.lucide-refresh-cw")).toBeVisible();
    await button.hover();
    await expect(
      page.getByRole("tooltip", { name: "Revalidate Feed" }),
    ).toBeVisible();
    await button.click();
    await expect(
      page.getByText("Feed revalidated", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
      "Test Blog",
    );
    await expect(
      dialog.getByRole("button", { name: "Copy publication link" }),
    ).toHaveCount(0);
    await dialog.getByLabel("Name", { exact: true }).fill("My custom name");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await openEditor("My custom name");
    const completed = page.waitForResponse(
      (response) =>
        response.url().includes("/feed/revalidate") &&
        response.status() === 200,
    );
    await button.click();
    await completed;
    await expect(button).toHaveAttribute("aria-busy", "false");
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
      "My custom name",
    );

    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/feed/revalidate**", async (route) => {
      await pending;
      await route.continue();
    });
    await button.click();
    await expect(button).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Save", exact: true }),
    ).toBeDisabled();
    await dialog.getByLabel("Name", { exact: true }).fill("Unsaved draft");
    release();
    await expect(button).toBeEnabled();
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
      "Unsaved draft",
    );
  } finally {
    await cleanupUser(SELF_HOSTED_TURSO_PORT, fixture.email);
  }
});
