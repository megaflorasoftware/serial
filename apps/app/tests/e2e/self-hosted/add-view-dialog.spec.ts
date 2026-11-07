import { expect, test } from "@playwright/test";
import { signIn } from "../fixtures/auth";
import { openSidebar } from "../fixtures/sidebar";
import { cleanupUser, seedArticleData } from "../fixtures/seed-db";
import {
  SELF_HOSTED_APP_PORT,
  SELF_HOSTED_TURSO_PORT,
} from "../fixtures/ports";

for (const mobile of [false, true]) {
  test(`Add View tabs stay fixed while content scrolls on ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    const fixture = await seedArticleData(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
    );
    try {
      await page.setViewportSize({ width: mobile ? 390 : 1280, height: 800 });
      await signIn({ page, email: fixture.email, password: fixture.password });
      const openAddView = async () => {
        if (mobile) {
          if (
            !(await page
              .getByRole("button", { name: "Add View", exact: true })
              .isVisible())
          ) {
            await page.locator('[data-onboarding="open-menu"]').click();
          }
        } else {
          await openSidebar(page);
        }
        await page
          .getByRole("button", { name: "Add View", exact: true })
          .click();
      };
      await openAddView();
      const dialog = page.getByRole("dialog", {
        name: "Add View",
        exact: true,
      });
      const name = dialog.getByPlaceholder("My View");
      await expect(name).toBeFocused();
      await name.fill("Retained draft");
      await name.blur();
      await page.setViewportSize({ width: mobile ? 390 : 1280, height: 400 });
      const tabs = dialog.getByRole("tablist");
      const scroller = dialog.locator(".overflow-y-auto");
      await expect
        .poll(() =>
          scroller.evaluate((el) => el.scrollHeight > el.clientHeight),
        )
        .toBe(true);
      // Wait for dialog entrance and viewport transitions before comparing positions.
      await dialog.evaluate(async (el) => {
        await Promise.all(
          el.getAnimations().map((animation) => animation.finished),
        );
      });
      const top = (await tabs.boundingBox())!.y;
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect
        .poll(() => scroller.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(0);
      await expect
        .poll(async () => Math.abs((await tabs.boundingBox())!.y - top))
        .toBeLessThan(1);
      await expect(tabs).toBeInViewport();
      const display = dialog.getByRole("tab", { name: "Display", exact: true });
      await display.click();
      await expect(display).toHaveAttribute("aria-selected", "true");
      await expect(
        dialog.getByRole("tabpanel", { name: "Display", exact: true }),
      ).toBeVisible();
      await display.press("ArrowLeft");
      await expect(
        dialog.getByRole("tab", { name: "Content", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(name).toHaveValue("Retained draft");
      await display.click();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await openAddView();
      await expect(
        dialog.getByRole("tab", { name: "Content", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(name).toHaveValue("");
      await expect(name).toBeFocused();
    } finally {
      await cleanupUser(SELF_HOSTED_TURSO_PORT, fixture.email);
    }
  });
}
