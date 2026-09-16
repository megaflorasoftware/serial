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
  seedMixedViewSectionCase,
  setFeedItemWatchLater,
} from "../fixtures/seed-db";

test.describe("Saved soft reads", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });
  let email = "";
  test.afterEach(async () => {
    if (email) await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
  });

  for (const scope of ["View", "Tag", "Feed"] as const) {
    test(`clears retention when changing ${scope} scope and returning`, async ({
      page,
    }) => {
      const fixture = await seedMixedViewSectionCase(
        SELF_HOSTED_TURSO_PORT,
        SELF_HOSTED_APP_PORT,
        {
          feedSectionFeedItem: false,
          tagSectionFeedItem: true,
          tagSectionBookmark: false,
          uncategorizedFeedItem: false,
          uncategorizedBookmark: false,
        },
      );
      email = fixture.email;
      await signIn({ page, email, password: fixture.password });
      await page.getByRole("tab", { name: /^Saved/ }).click();
      const view = page.getByRole("radio", {
        name: fixture.viewName,
        exact: true,
      });
      await view.click();
      const id = fixture.items.tagSectionFeedItem;
      const row = page.locator(`article[data-item-id="${id}"]`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.hover();
      await row.getByRole("button", { name: /^Archive/ }).click();
      await expect
        .poll(() => getFeedItemWatchedState(SELF_HOSTED_TURSO_PORT, id))
        .toBe(true);
      await expect(row).toHaveCSS("opacity", "0.75");
      if (scope === "View") {
        await page
          .getByRole("radio", { name: fixture.emptyViewName, exact: true })
          .click();
      } else {
        const group = page.locator('[data-sidebar="group"]').filter({
          has: page.locator('[data-sidebar="group-label"]', {
            hasText: `${scope}s`,
          }),
        });
        await group
          .locator('[data-sidebar="menu-button"]')
          .filter({
            hasText:
              scope === "Tag" ? fixture.tagName : fixture.feeds.tagSection.name,
          })
          .click();
      }
      await expect(row).toHaveCount(0);
      await view.click();
      await expect(row).toHaveCount(0);
    });
  }

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
