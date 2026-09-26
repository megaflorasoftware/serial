import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";
import { signIn } from "../fixtures/auth";
import {
  SELF_HOSTED_APP_PORT,
  SELF_HOSTED_TURSO_PORT,
} from "../fixtures/ports";
import { cleanupUser, seedMultipleArticleData } from "../fixtures/seed-db";

async function observeActionScrolling(container: Locator) {
  await container.evaluate((element) => {
    const scrollTo = element.scrollTo;
    element.dataset.actionScrollCalls = "0";
    element.scrollTo = (
      ...args: [options?: ScrollToOptions] | [x: number, y: number]
    ) => {
      element.dataset.actionScrollCalls = String(
        Number(element.dataset.actionScrollCalls) + 1,
      );
      Reflect.apply(scrollTo, element, args);
    };
  });
}

async function expectActionScrolling(container: Locator, mobile: boolean) {
  // Include the deferred animation frames and 300ms smooth-scroll window.
  // Observe calls, since native clamping after removal can also move the list.
  await container.page().waitForTimeout(500);
  const calls = Number(
    await container.getAttribute("data-action-scroll-calls"),
  );
  if (mobile) {
    expect(calls).toBe(0);
  } else {
    expect(calls).toBeGreaterThan(0);
  }
}

for (const width of [390, 767, 768]) {
  const mobile = width < 768;
  test.describe(`root action scrolling at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, serviceWorkers: "block" });

    let testEmail: string;
    test.afterEach(async () => {
      if (testEmail) await cleanupUser(SELF_HOSTED_TURSO_PORT, testEmail);
    });

    for (const action of ["Archive", "Save"] as const) {
      for (const position of ["middle", "last"] as const) {
        test(`${action} on the ${position} item ${mobile ? "does not scroll" : "still scrolls"}`, async ({
          page,
        }) => {
          const { email, password, feedItemIds } =
            await seedMultipleArticleData(
              SELF_HOSTED_TURSO_PORT,
              SELF_HOSTED_APP_PORT,
              20,
            );
          testEmail = email;
          await signIn({ page, email, password });

          const itemId = feedItemIds[position === "middle" ? 10 : 19]!;
          const item = page.locator(`article[data-item-id="${itemId}"]`);
          await item.scrollIntoViewIfNeeded();
          const actionButton = item.getByRole("button", {
            name: action,
            exact: true,
          });
          await actionButton.scrollIntoViewIfNeeded();
          const container = page.locator('[data-slot="sidebar-inset"]');
          expect(
            await container.evaluate((element) => element.scrollTop),
          ).toBeGreaterThan(200);
          await observeActionScrolling(container);

          await actionButton.click();
          await page.mouse.move(5, 5);
          await expect(item).toHaveCount(0);
          await expectActionScrolling(container, mobile);
          if (mobile && position === "last") {
            expect(
              await container.evaluate((element) => element.scrollTop),
            ).toBeGreaterThan(200);
          }
        });
      }
    }

    test(`bulk mark as read ${mobile ? "does not scroll" : "still scrolls"} after refill`, async ({
      page,
    }) => {
      const { email, password } = await seedMultipleArticleData(
        SELF_HOSTED_TURSO_PORT,
        SELF_HOSTED_APP_PORT,
        40,
      );
      testEmail = email;
      await signIn({ page, email, password });
      await expect(page.locator("article").first()).toBeVisible();
      const originalIds = await page
        .locator("article")
        .evaluateAll((items) =>
          items.map((item) => item.getAttribute("data-item-id")),
        );
      const container = page.locator('[data-slot="sidebar-inset"]');
      await observeActionScrolling(container);
      await page.getByRole("button", { name: "Mark all as read" }).click();
      await expect(page.getByText(/Marked \d+ items as read/)).toBeVisible();
      await expect
        .poll(async () => {
          const firstId = await page
            .locator("article")
            .first()
            .getAttribute("data-item-id");
          return firstId !== null && !originalIds.includes(firstId);
        })
        .toBe(true);
      await expectActionScrolling(container, mobile);
    });
  });
}
