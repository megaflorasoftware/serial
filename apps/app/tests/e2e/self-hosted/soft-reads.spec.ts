import { expect, test } from "@playwright/test";
import { signIn } from "../fixtures/auth";
import {
  SELF_HOSTED_APP_PORT,
  SELF_HOSTED_TURSO_PORT,
} from "../fixtures/ports";
import {
  cleanupUser,
  getBookmarkState,
  getFeedItemWatchedState,
  seedArticleData,
  seedBookmarkProjectionData,
  setFeedItemWatchLater,
} from "../fixtures/seed-db";

test.describe("Saved soft reads", () => {
  test.use({ viewport: { width: 1280, height: 900 } });
  let email = "";
  test.afterEach(async () => {
    if (email) await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
  });

  for (const kind of ["feed", "bookmark"] as const) {
    test(`${kind} retains individual toggles until status navigation or reader departure`, async ({
      page,
    }) => {
      const fixture = await seedArticleData(
        SELF_HOSTED_TURSO_PORT,
        SELF_HOSTED_APP_PORT,
      );
      email = fixture.email;
      const id =
        kind === "bookmark"
          ? (
              await seedBookmarkProjectionData(
                SELF_HOSTED_TURSO_PORT,
                email,
                fixture.feedItemId,
              )
            ).bookmarkId
          : fixture.feedItemId;
      if (kind === "feed")
        await setFeedItemWatchLater(SELF_HOSTED_TURSO_PORT, id, true);
      const isRead = async () =>
        kind === "bookmark"
          ? (await getBookmarkState(SELF_HOSTED_TURSO_PORT, id))?.isRead
          : await getFeedItemWatchedState(SELF_HOSTED_TURSO_PORT, id);
      await signIn({ page, email, password: fixture.password });
      await page.getByRole("tab", { name: /^Saved/ }).click();
      const row = page.locator(`article[data-item-id="${id}"]`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.hover();
      await row.getByRole("button", { name: /^Archive/ }).click();
      await expect.poll(isRead).toBe(true);
      await expect(row).toHaveCSS("opacity", "0.75");

      // A retained row remains actionable and its actual status drives opacity.
      await row.hover();
      await row.getByRole("button", { name: /^Unarchive/ }).click();
      await expect.poll(isRead).toBe(false);
      await expect(row).toHaveCSS("opacity", "1");
      await page.getByRole("heading", { name: "Serial", exact: true }).hover();
      await row.hover();
      await page.keyboard.press("e");
      await expect.poll(isRead).toBe(true);
      await expect(row).toHaveCSS("opacity", "0.75");

      await page
        .getByRole("tab", { name: "Switch to archived content" })
        .click();
      await expect(row).toHaveCSS("opacity", "0.75");
      await page.getByRole("tab", { name: "Switch to unread content" }).click();
      await expect(row).toHaveCount(0);

      await page
        .getByRole("tab", { name: "Switch to archived content" })
        .click();
      await expect(row).toBeVisible();
      await row.hover();
      await row.getByRole("button", { name: /^Unarchive/ }).click();
      await expect.poll(isRead).toBe(false);
      await expect(row).toHaveCSS("opacity", "1");
      await row.getByRole("link").click();
      await expect(page).toHaveURL(`/read/${id}`);
      await page.goBack();
      await expect(page).toHaveURL("/");
      await expect(row).toHaveCount(0);
      await page.getByRole("tab", { name: "Switch to unread content" }).click();
      await expect(row).toBeVisible();

      // Unsave still removes a soft-retained row immediately.
      await row.hover();
      await row.getByRole("button", { name: /^Archive/ }).click();
      await expect.poll(isRead).toBe(true);
      await expect(row).toHaveCSS("opacity", "0.75");
      await row.hover();
      await row.getByRole("button", { name: /^Unsave/ }).click();
      await expect(row).toHaveCount(0);
      await page.getByRole("tab", { name: /^Inbox/ }).click();
      await page
        .getByRole("tab", { name: "Switch to archived content" })
        .click();
      await expect(row).toHaveCSS("opacity", "0.75");
      await row.hover();
      await row.getByRole("button", { name: /^Unarchive/ }).click();
      await expect(row).toHaveCount(0);
      await page.getByRole("tab", { name: "Switch to unread content" }).click();
      await expect(row).toBeVisible();
      await page.getByRole("button", { name: "Mark all as read" }).click();
      await expect(row).toHaveCount(0);
    });
  }
});
