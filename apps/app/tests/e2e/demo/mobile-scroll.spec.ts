import { expect, test } from "@playwright/test";
import { completeTestOnboarding } from "../fixtures/auth";
import {
  emulateMobileBrowserControls,
  expectPrimaryMobileScrolling,
} from "../fixtures/mobile-scroll";
import { DEMO_RSS_SERVER_PORT } from "../fixtures/ports";

test("demo banner leaves the mobile content pane in charge of scrolling", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await emulateMobileBrowserControls(page);
  await page.goto("/");
  await expect(page.getByText(/This is a demo instance/i)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Get started", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await completeTestOnboarding(page);

  await page.goto("/import");
  await page.locator('input[data-ready="true"]').setInputFiles({
    name: "subscriptions.opml",
    mimeType: "application/xml",
    buffer: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
      <opml version="1.1"><head><title>Scroll fixture</title></head><body>
        <outline text="Test Blog" type="rss" xmlUrl="http://127.0.0.1:${DEMO_RSS_SERVER_PORT}/feed/test-blog"/>
      </body></opml>`),
  });
  await page.getByRole("button", { name: /import 1 feeds/i }).click();
  await expect(page.getByText("Import finished")).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("link", { name: /back to home/i }).click();
  await page
    .locator("article")
    .filter({ hasText: "Test Article" })
    .getByRole("link")
    .first()
    .click();
  await expect(page.getByText("Paragraph 20:")).toBeVisible();

  const content = page.locator('[data-slot="sidebar-inset"]');
  const banner = page.getByRole("button", { name: "Export Data" });
  await expect(banner).toBeVisible();
  const bannerBounds = await banner.boundingBox();
  const contentBounds = await content.boundingBox();
  expect(contentBounds!.y).toBeGreaterThanOrEqual(
    bannerBounds!.y + bannerBounds!.height,
  );
  await expectPrimaryMobileScrolling(page);
  await expect(banner).toBeInViewport();
});
