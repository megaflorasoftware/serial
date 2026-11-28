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

const paragraph =
  "A paragraph long enough to wrap, so its box takes whatever width the reader column gives it.";
const articleHtml = `<p>${paragraph}</p>
  <video width="660" height="40"></video>`;

test.describe("article column width", () => {
  test.use({ serviceWorkers: "block" });
  let email: string;
  test.afterEach(async () => {
    if (email) await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
  });

  for (const kind of ["full", "bookmark"] as const) {
    test(`${kind} content spans the column between its padding edges`, async ({
      page,
    }) => {
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
      await expect(page.locator("video")).toBeAttached();

      // A phone, where the old screen-based cap fell short of the padding,
      // and a desktop column, where it let a fixed-width element overflow.
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const edges = await text.evaluate((node) => {
          const article = node.closest(".px-6")!;
          const style = getComputedStyle(article);
          const box = article.getBoundingClientRect();
          const span = (element: Element) => {
            const rect = element.getBoundingClientRect();
            return [rect.left, rect.right];
          };
          return {
            column: [
              box.left + parseFloat(style.paddingLeft),
              box.right - parseFloat(style.paddingRight),
            ],
            text: span(node),
            fixed: span(document.querySelector("video")!),
          };
        });
        for (const element of [edges.text, edges.fixed]) {
          expect(Math.abs(element[0]! - edges.column[0]!)).toBeLessThanOrEqual(
            1,
          );
          expect(Math.abs(element[1]! - edges.column[1]!)).toBeLessThanOrEqual(
            1,
          );
        }
      }
    });
  }
});
