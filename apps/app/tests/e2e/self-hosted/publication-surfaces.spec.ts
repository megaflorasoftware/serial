import { expect, test } from "@playwright/test";
import { signIn } from "../fixtures/auth";
import {
  SELF_HOSTED_APP_PORT,
  SELF_HOSTED_TURSO_PORT,
} from "../fixtures/ports";
import {
  addArticlePublicationOrigin,
  cleanupUser,
  seedArticleData,
  setFeedItemContent,
} from "../fixtures/seed-db";

test.describe("publication Feed surfaces", () => {
  let email: string;
  test.afterEach(async () => {
    if (email) await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
  });

  for (const rss of [false, true]) {
    test(`copies publication identity from an ${rss ? "active combined" : "inactive Atmosphere-only"} Feed`, async ({
      page,
      context,
    }) => {
      const fixture = await seedArticleData(
        SELF_HOSTED_TURSO_PORT,
        SELF_HOSTED_APP_PORT,
      );
      email = fixture.email;
      const { publicationUri, siteUrl } = await addArticlePublicationOrigin(
        SELF_HOSTED_TURSO_PORT,
        fixture.feedItemId,
        { rss, active: rss },
      );
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await signIn({ page, email, password: fixture.password });
      const row = page
        .locator('[data-slot="sidebar-menu-item"]')
        .filter({ has: page.getByText("My renamed Feed", { exact: true }) });
      await expect(row).toBeVisible();
      await expect(
        row.locator('svg[aria-label="Published name"]'),
      ).toBeVisible();
      await row.locator("button").last().click();
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByRole("link", { name: "Open in Website" }),
      ).toHaveAttribute("href", siteUrl);
      const rssCopy = dialog.getByRole("button", {
        name: "Copy Feed URL",
        exact: true,
      });
      if (rss) await expect(rssCopy).toBeVisible();
      else await expect(rssCopy).toHaveCount(0);
      const copy = dialog.getByRole("button", {
        name: "Copy publication link",
        exact: true,
      });
      await copy.click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(publicationUri);
      await expect(copy.locator("svg.lucide-check")).toBeVisible();
      if (rss) await expect(rssCopy.locator("svg.lucide-check")).toHaveCount(0);
    });
  }

  for (const body of ["", "<p>Delayed publication body</p>"]) {
    test(`waits for body loading before ${body ? "rendering content" : "showing the external fallback"}`, async ({
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
        body,
      );
      await signIn({ page, email, password: fixture.password });
      let release: () => void = () => undefined;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let received: () => void = () => undefined;
      const requested = new Promise<void>((resolve) => {
        received = resolve;
      });
      await page.route("**/feedItem/getById**", async (route) => {
        received();
        await pending;
        await route.continue();
      });
      await page.goto(`/read/${fixture.feedItemId}`);
      await requested;
      const fallback = page.getByRole("link", {
        name: "Open in Website",
        exact: true,
      });
      try {
        await expect(fallback).toHaveCount(0);
      } finally {
        release();
      }
      if (body) {
        await expect(page.getByText("Delayed publication body")).toBeVisible();
        await expect(fallback).toHaveCount(0);
      } else {
        await expect(fallback).toBeVisible();
        await expect(fallback).toHaveAttribute("href", /\/test-blog\//);
        await expect(fallback).toHaveAttribute("target", "_blank");
      }
      await expect(page).toHaveURL(`/read/${fixture.feedItemId}`);
    });
  }
});
