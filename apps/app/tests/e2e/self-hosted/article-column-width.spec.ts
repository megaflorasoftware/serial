import { expect, test } from "@playwright/test";
import { signIn } from "../fixtures/auth";
import {
  SELF_HOSTED_APP_PORT,
  SELF_HOSTED_TURSO_PORT,
} from "../fixtures/ports";
import { cleanupUser, seedReaderArticle } from "../fixtures/seed-db";
import type { Locator, Page } from "@playwright/test";

const paragraph = "A paragraph in the reader column.";
// Feed HTML keeps an element's own width; bookmark capture drops it.
const articleHtml = `<p>${paragraph}</p>
  <video width="660" height="40"></video>`;

/** The element's edges meet the source row's content edges above it. */
async function expectToLineUpWithSource(page: Page, element: Locator) {
  const source = await page.locator("[data-reader-source]").evaluate((node) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return {
      left: box.left + parseFloat(style.paddingLeft),
      right: box.right - parseFloat(style.paddingRight),
    };
  });
  const box = (await element.boundingBox())!;
  const width = page.viewportSize()?.width;
  expect(
    Math.abs(box.x - source.left),
    `left edge at ${width}px`,
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(box.x + box.width - source.right),
    `right edge at ${width}px`,
  ).toBeLessThanOrEqual(1);
}

test.describe("article column width", () => {
  test.use({ serviceWorkers: "block" });
  let email: string;
  test.afterEach(async () => {
    if (email) await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
  });

  async function openArticle(page: Page, reader: "full" | "bookmark") {
    const fixture = await seedReaderArticle(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
      reader,
      articleHtml,
    );
    email = fixture.email;
    await signIn({ page, email, password: fixture.password });
    await page.goto(`/read/${fixture.contentId}`);
    const text = page.getByText(paragraph);
    await expect(text).toBeVisible();
    return text;
  }

  for (const reader of ["full", "bookmark"] as const) {
    test(`${reader} text lines up with the source row on a phone`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 900 });
      const text = await openArticle(page, reader);
      await expectToLineUpWithSource(page, text);
    });
  }

  test("a fixed-width element stays inside the column", async ({ page }) => {
    await openArticle(page, "full");
    const video = page.locator("video");
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expectToLineUpWithSource(page, video);
    }
  });
});
