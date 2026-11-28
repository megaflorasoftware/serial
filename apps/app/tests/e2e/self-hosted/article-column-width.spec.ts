import { expect, test } from "@playwright/test";
import { signIn } from "../fixtures/auth";
import {
  SELF_HOSTED_APP_PORT,
  SELF_HOSTED_TURSO_PORT,
} from "../fixtures/ports";
import {
  cleanupUser,
  seedArticleData,
  seedBookmarkProjectionData,
  setFeedItemContent,
} from "../fixtures/seed-db";
import type { Locator, Page } from "@playwright/test";

const paragraph =
  "A paragraph long enough to wrap, so its box takes whatever width the reader column gives it.";
// Feed HTML keeps an element's own width; bookmark capture drops it.
const articleHtml = `<p>${paragraph}</p>
  <video width="660" height="40"></video>`;

/** The element sits exactly between the reader column's padding edges. */
async function expectToSpanColumn(page: Page, element: Locator) {
  const edges = await element.evaluate((node) => {
    const article = node.closest(".px-6")!;
    const style = getComputedStyle(article);
    const column = article.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return {
      left: box.left - (column.left + parseFloat(style.paddingLeft)),
      right: box.right - (column.right - parseFloat(style.paddingRight)),
    };
  });
  expect(
    Math.abs(edges.left),
    `left edge at ${page.viewportSize()?.width}px`,
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(edges.right),
    `right edge at ${page.viewportSize()?.width}px`,
  ).toBeLessThanOrEqual(1);
}

test.describe("article column width", () => {
  test.use({ serviceWorkers: "block" });
  let email: string;
  test.afterEach(async () => {
    if (email) await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
  });

  async function openArticle(page: Page, kind: "full" | "bookmark") {
    const fixture = await seedArticleData(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
    );
    email = fixture.email;
    await setFeedItemContent(
      SELF_HOSTED_TURSO_PORT,
      fixture.feedItemId,
      articleHtml,
    );
    const contentId =
      kind === "bookmark"
        ? (
            await seedBookmarkProjectionData(
              SELF_HOSTED_TURSO_PORT,
              email,
              fixture.feedItemId,
              articleHtml,
            )
          ).bookmarkId
        : fixture.feedItemId;
    await signIn({ page, email, password: fixture.password });
    await page.goto(`/read/${contentId}`);
    const text = page.getByText(paragraph);
    await expect(text).toBeVisible();
    return text;
  }

  for (const kind of ["full", "bookmark"] as const) {
    test(`${kind} text spans the column on a phone`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 900 });
      const text = await openArticle(page, kind);
      await expectToSpanColumn(page, text);
    });
  }

  test("a fixed-width element stays inside the column", async ({ page }) => {
    await openArticle(page, "full");
    const video = page.locator("video");
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expectToSpanColumn(page, video);
    }
  });
});
