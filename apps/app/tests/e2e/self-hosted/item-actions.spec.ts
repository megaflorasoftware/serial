import { expect, test } from "@playwright/test";
import {
  SELF_HOSTED_APP_PORT,
  SELF_HOSTED_TURSO_PORT,
} from "../fixtures/ports";
import {
  getScrollPositionDelta,
  SCROLL_POSITION_TOLERANCE_PX,
} from "../fixtures/scroll-position";
import {
  cleanupUser,
  seedArticleData,
  seedMultipleArticleData,
  setFeedItemAsYouTubeVideo,
} from "../fixtures/seed-db";
import { signIn } from "../fixtures/auth";

test.describe("feed item actions", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  let testEmail: string;

  test.afterEach(async () => {
    if (testEmail) {
      await cleanupUser(SELF_HOSTED_TURSO_PORT, testEmail);
    }
  });

  test("mark as read on read page and verify on home page", async ({
    page,
  }) => {
    test.setTimeout(30000);

    const { email, password, feedItemId } = await seedArticleData(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
    );
    testEmail = email;

    await signIn({ page, email, password });

    // Wait for home page to fully load items
    await expect(page.locator("article").first()).toBeVisible({
      timeout: 30000,
    });

    // Navigate to the article read page
    await page.goto(`/read/${feedItemId}`);
    await expect(
      page.locator("h1").filter({ hasText: "Test Article" }),
    ).toBeVisible({ timeout: 10000 });

    // ── Mark as Read ───────────────────────────────────────────────
    await page.keyboard.press("e");
    await page.waitForTimeout(500);

    // ── Navigate back home with 'h' shortcut ───────────────────────
    await page.keyboard.press("h");
    await page.waitForTimeout(500);
    await expect(page).toHaveURL("/", { timeout: 10000 });

    // Switch to archived content with the "y" shortcut.
    await page.keyboard.press("y");
    await page.waitForTimeout(500);

    // Article should appear in the read filter.
    const readArticle = page
      .locator(`article[data-item-id="${feedItemId}"]`)
      .first();
    await expect(readArticle).toBeVisible({ timeout: 10000 });
  });

  test("restores the selected root item or its successor without animation", async ({
    page,
  }) => {
    const { email, password, feedItemIds } = await seedMultipleArticleData(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
      20,
    );
    testEmail = email;

    await signIn({ page, email, password });
    const selectedItemId = feedItemIds[10]!;
    const successorItemId = feedItemIds[11]!;
    const selectedItem = page.locator(
      `article[data-item-id="${selectedItemId}"]`,
    );
    await selectedItem.scrollIntoViewIfNeeded();
    await selectedItem.getByRole("link").click();
    await expect(page).toHaveURL(`/read/${selectedItemId}`);
    await expect(
      page.getByRole("heading", { name: "Test Article 11" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByRole("button", { name: "Unarchive" })).toBeVisible();
    await page.getByRole("button", { name: "Home" }).click();
    await expect(page).toHaveURL("/");
    await expect(selectedItem).toHaveCount(0);

    const successorItem = page.locator(
      `article[data-item-id="${successorItemId}"]`,
    );
    await expect(successorItem.getByRole("link")).toHaveClass(/md:bg-muted/);
    await expect
      .poll(async () => {
        const [containerBox, itemBox] = await Promise.all([
          page.locator('[data-slot="sidebar-inset"]').boundingBox(),
          successorItem.boundingBox(),
        ]);
        if (!containerBox || !itemBox) return Number.POSITIVE_INFINITY;

        const itemCenter = itemBox.y + itemBox.height / 2;
        const target = containerBox.y + containerBox.height / 3;
        return getScrollPositionDelta(itemCenter, target);
      })
      .toBeLessThanOrEqual(SCROLL_POSITION_TOLERANCE_PX);
  });

  test("restores the root to the top when there is no selected item", async ({
    page,
  }) => {
    const { email, password, feedItemIds } = await seedMultipleArticleData(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
      20,
    );
    testEmail = email;

    await signIn({ page, email, password });
    await page.goto(`/read/${feedItemIds[0]!}`);
    await expect(
      page.getByRole("heading", { name: "Test Article 1" }),
    ).toBeVisible();
    const scrollContainer = page.locator('[data-slot="sidebar-inset"]');
    await scrollContainer.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(
      await scrollContainer.evaluate((element) => element.scrollTop),
    ).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Home" }).click();
    await expect(page).toHaveURL("/");
    await expect
      .poll(async () =>
        getScrollPositionDelta(
          await scrollContainer.evaluate((element) => element.scrollTop),
          0,
        ),
      )
      .toBeLessThanOrEqual(SCROLL_POSITION_TOLERANCE_PX);
  });

  test("does not show a copy-link action on feed items", async ({ page }) => {
    const { email, password, feedItemId } = await seedArticleData(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
    );
    testEmail = email;

    await signIn({ page, email, password });

    const article = page.locator(`article[data-item-id="${feedItemId}"]`);
    await expect(article).toBeVisible({ timeout: 30000 });
    await article.hover();

    await expect(
      article.getByRole("button", { name: "Copy item URL" }),
    ).toHaveCount(0);
  });

  test("shows Copy URL before Open in the video header", async ({ page }) => {
    const { email, password, feedItemId } = await seedArticleData(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
    );
    testEmail = email;

    await signIn({ page, email, password });
    await page.goto(`/watch/${feedItemId}`);

    const headerActions = page.locator("header > span").last();
    const buttons = headerActions.getByRole("button");
    await expect(buttons.first()).toHaveAccessibleName("Copy URL");
    await expect(buttons).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Copy URL" })).toHaveCount(1);
  });

  test("shows Copy URL before Open in the article header", async ({
    context,
    page,
  }) => {
    const { email, password, feedItemId } = await seedArticleData(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
    );
    testEmail = email;

    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: `http://localhost:${SELF_HOSTED_APP_PORT}`,
    });
    await signIn({ page, email, password });
    await page.goto(`/read/${feedItemId}`);
    await expect(
      page.locator("h1").filter({ hasText: "Test Article" }),
    ).toBeVisible({ timeout: 10000 });

    const headerActions = page.locator("header > span").last();
    const buttons = headerActions.getByRole("button");
    await expect(buttons.first()).toHaveAccessibleName("Copy URL");
    await expect(buttons).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Copy URL" })).toHaveCount(1);

    await page.keyboard.press("Shift+C");
    await expect(page.getByText("Link copied")).toBeVisible();
  });

  test("loads the YouTube player with an identifiable embed context", async ({
    page,
  }) => {
    const { email, password, feedItemId } = await seedArticleData(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
    );
    testEmail = email;
    await setFeedItemAsYouTubeVideo(
      SELF_HOSTED_TURSO_PORT,
      feedItemId,
      "M7lc1UVf-VE",
    );

    await page.addInitScript(() => {
      localStorage.setItem(
        "serial-flag-custom-video-player",
        JSON.stringify("youtube"),
      );
    });
    await page.route("https://www.youtube-nocookie.com/**", (route) =>
      route.abort(),
    );
    await signIn({ page, email, password });
    await page.goto(`/watch/${feedItemId}`);

    const player = page.getByTitle("YouTube video player");
    await expect(player).toHaveAttribute(
      "src",
      "https://www.youtube-nocookie.com/embed/M7lc1UVf-VE",
    );
    await expect(player).toHaveAttribute(
      "referrerpolicy",
      "strict-origin-when-cross-origin",
    );
    await expect(player).not.toHaveAttribute("sandbox", /.*/);
  });

  test("archiving a saved item preserves it in Saved Archived", async ({
    page,
  }) => {
    test.setTimeout(30000);

    const { email, password } = await seedMultipleArticleData(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
      3,
    );
    testEmail = email;

    const itemLink = (itemId: string) =>
      page.locator(`article[data-item-id="${itemId}"] a`).first();
    const selectedItemClass = /md:bg-muted/;

    await signIn({ page, email, password });

    await expect(page.locator("article").first()).toBeVisible({
      timeout: 30000,
    });

    const unreadItemIds = await page
      .locator("article")
      .evaluateAll((articles) =>
        articles
          .map((article) => article.getAttribute("data-item-id"))
          .filter((itemId): itemId is string => itemId !== null),
      );
    const [firstUnreadItemId] = unreadItemIds;
    if (!firstUnreadItemId) {
      throw new Error("Expected an unread feed item");
    }

    await itemLink(firstUnreadItemId).hover();
    await page.keyboard.press("s");

    await page.keyboard.press("b");
    await expect(page.locator("article").first()).toBeVisible({
      timeout: 10000,
    });
    const savedItemIds = await page
      .locator("article")
      .evaluateAll((articles) =>
        articles
          .map((article) => article.getAttribute("data-item-id"))
          .filter((itemId): itemId is string => itemId !== null),
      );
    const [firstSavedItemId] = savedItemIds;
    if (!firstSavedItemId) {
      throw new Error("Expected a saved feed item");
    }

    // Exit keyboard-navigation mode before selecting by hover.
    await page.mouse.move(1, 1);
    await page.mouse.move(10, 10);
    await itemLink(firstSavedItemId).hover();
    await expect(itemLink(firstSavedItemId)).toHaveClass(selectedItemClass, {
      timeout: 5000,
    });

    await page.keyboard.press("e");
    await expect(itemLink(firstSavedItemId)).toHaveCount(0);

    await page
      .getByRole("tab", {
        name: "Switch to archived content",
        exact: true,
      })
      .click();
    await expect(itemLink(firstSavedItemId)).toBeVisible({ timeout: 5000 });
  });

  for (const trigger of ["archive button", "keyboard shortcut"] as const) {
    test(`archiving with the ${trigger} keeps scroll and advances to the successor`, async ({
      page,
    }) => {
      const { email, password, feedItemIds } = await seedMultipleArticleData(
        SELF_HOSTED_TURSO_PORT,
        SELF_HOSTED_APP_PORT,
        20,
      );
      testEmail = email;

      await signIn({ page, email, password });
      await expect(page.locator("article").first()).toBeVisible({
        timeout: 30000,
      });

      // Exit keyboard-navigation mode before selecting by hover.
      await page.mouse.move(1, 1);
      await page.mouse.move(10, 10);

      const targetItemId = feedItemIds[10]!;
      const successorItemId = feedItemIds[11]!;
      const targetItem = page.locator(
        `article[data-item-id="${targetItemId}"]`,
      );
      await targetItem.scrollIntoViewIfNeeded();

      const scrollContainer = page.locator('[data-slot="sidebar-inset"]');
      const scrollBefore = await scrollContainer.evaluate((el) => el.scrollTop);
      expect(scrollBefore).toBeGreaterThan(200);

      await targetItem.getByRole("link").hover();
      if (trigger === "archive button") {
        await targetItem.getByRole("button", { name: "Archive" }).click();
      } else {
        await page.keyboard.press("e");
      }

      await expect(targetItem).toHaveCount(0, { timeout: 10000 });

      const successorItem = page.locator(
        `article[data-item-id="${successorItemId}"]`,
      );
      await expect(successorItem.getByRole("link")).toHaveClass(/md:bg-muted/);

      // The advance scroll re-centers the successor; wait for it to settle,
      // then confirm the list did not jump back toward the top.
      let settledScrollTop = Number.NaN;
      await expect
        .poll(async () => {
          const currentScrollTop = await scrollContainer.evaluate(
            (el) => el.scrollTop,
          );
          const isSettled = currentScrollTop === settledScrollTop;
          settledScrollTop = currentScrollTop;
          return isSettled;
        })
        .toBe(true);
      expect(settledScrollTop).toBeGreaterThan(scrollBefore * 0.5);
    });
  }
});
