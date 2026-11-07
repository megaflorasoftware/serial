import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

export async function emulateMobileBrowserControls(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  // Desktop automation does not distinguish mobile browser toolbar sizes.
  // Model their large/small viewport units while dvh follows the viewport.
  await page.route(/\.css(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const css = await response.text();
    await route.fulfill({
      response,
      body: css.replace(/\b100vh\b/g, "844px").replace(/\b100svh\b/g, "724px"),
    });
  });
}

export async function expectPrimaryMobileScrolling(page: Page) {
  const content = page.locator('[data-slot="sidebar-inset"]');

  for (const height of [724, 844, 724]) {
    await page.setViewportSize({ width: 390, height });
    await page.evaluate(() => window.scrollTo(0, 1_000));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect
      .poll(() =>
        content.evaluate((element) => element.getBoundingClientRect().bottom),
      )
      .toBe(height);

    await content.evaluate((element) => {
      element.scrollTop = 0;
    });
    const bounds = await content.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(
      bounds!.x + bounds!.width / 2,
      bounds!.y + bounds!.height / 2,
    );
    await page.mouse.wheel(0, 400);
    await expect
      .poll(() => content.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.mouse.wheel(0, 400);
    await expect(content).toHaveCSS("overscroll-behavior-y", "contain");
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  }
}
