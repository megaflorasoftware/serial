import { expect, test } from "@playwright/test";
import { signIn } from "../fixtures/auth";
import { indexedDbKeys } from "../fixtures/indexed-db";
import {
  MIXED_VIEW_SECTION_CASES,
  mixedViewSectionCaseName,
} from "../fixtures/mixed-view-section-matrix";
import {
  SELF_HOSTED_APP_PORT,
  SELF_HOSTED_TURSO_PORT,
} from "../fixtures/ports";
import {
  archiveMixedViewItems,
  cleanupUser,
  matchBookmarkToFeedItem,
  seedMixedViewSectionCase,
  seedSavedViewClientStateData,
} from "../fixtures/seed-db";
import type { Locator, Page } from "@playwright/test";

const caseNames = MIXED_VIEW_SECTION_CASES.map(mixedViewSectionCaseName);
if (
  MIXED_VIEW_SECTION_CASES.length !== 32 ||
  new Set(caseNames).size !== MIXED_VIEW_SECTION_CASES.length
) {
  throw new Error("Mixed View section matrix must contain 32 unique cases");
}

async function renderedItemIdsInOrder(locator: Locator) {
  return locator.evaluateAll((elements) =>
    elements.flatMap((element) => {
      const itemId = element.getAttribute("data-item-id");
      return itemId ? [itemId] : [];
    }),
  );
}

async function renderedItemIds(locator: Locator) {
  return (await renderedItemIdsInOrder(locator)).sort();
}

function contentStatusTab(page: Page, name: string) {
  const isSaveStatus = name === "Inbox" || name === "Saved";
  const accessibleName = isSaveStatus
    ? name
    : `Switch to ${name.toLowerCase()} content`;
  const axisAnchor = isSaveStatus ? "Inbox" : "Switch to unread content";

  return page
    .locator('[data-slot="tabs-list"]')
    .filter({ has: page.getByRole("tab", { name: axisAnchor, exact: true }) })
    .getByRole("tab", { name: accessibleName, exact: true });
}

async function beginSkeletonObservation(locator: Locator) {
  await locator.evaluate((root) => {
    const state = window as typeof window & {
      __serialMatrixSkeletonSeen?: boolean;
      __serialMatrixSkeletonObserver?: MutationObserver;
    };
    state.__serialMatrixSkeletonSeen = Boolean(
      root.querySelector(".animate-pulse"),
    );
    state.__serialMatrixSkeletonObserver = new MutationObserver(() => {
      if (root.querySelector(".animate-pulse")) {
        state.__serialMatrixSkeletonSeen = true;
      }
    });
    state.__serialMatrixSkeletonObserver.observe(root, {
      childList: true,
      subtree: true,
    });
  });
}

async function finishSkeletonObservation(page: Page) {
  return page.evaluate(() => {
    const state = window as typeof window & {
      __serialMatrixSkeletonSeen?: boolean;
      __serialMatrixSkeletonObserver?: MutationObserver;
    };
    state.__serialMatrixSkeletonObserver?.disconnect();
    return state.__serialMatrixSkeletonSeen ?? false;
  });
}

test.describe("exhaustive mixed-content View section matrix", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  let testEmail: string;

  test.afterEach(async () => {
    if (testEmail) await cleanupUser(SELF_HOSTED_TURSO_PORT, testEmail);
    testEmail = "";
  });

  for (const testCase of MIXED_VIEW_SECTION_CASES) {
    test(mixedViewSectionCaseName(testCase), async ({ page }) => {
      test.setTimeout(45_000);
      const fixture = await seedMixedViewSectionCase(
        SELF_HOSTED_TURSO_PORT,
        SELF_HOSTED_APP_PORT,
        testCase,
      );
      testEmail = fixture.email;

      const expectedSectionByItemId = new Map<string, number | null>([
        [
          fixture.items.feedSectionFeedItem,
          testCase.feedSectionFeedItem ? 0 : null,
        ],
        [
          fixture.items.tagSectionFeedItem,
          testCase.tagSectionFeedItem ? 1 : null,
        ],
        [
          fixture.items.tagSectionBookmark,
          testCase.tagSectionBookmark ? 1 : null,
        ],
        [
          fixture.items.uncategorizedFeedItem,
          testCase.uncategorizedFeedItem ? 2 : null,
        ],
        [
          fixture.items.uncategorizedBookmark,
          testCase.uncategorizedBookmark ? 2 : null,
        ],
        [fixture.items.outsideFeedItem, null],
        [fixture.items.outsideBookmark, null],
      ]);
      const expectedItemIds = [...expectedSectionByItemId.entries()]
        .flatMap(([itemId, sectionIndex]) =>
          sectionIndex === null ? [] : [itemId],
        )
        .sort();

      await signIn({
        page,
        email: fixture.email,
        password: fixture.password,
      });
      await contentStatusTab(page, "Saved").click();

      const feedMain = page
        .locator("main")
        .filter({
          has: page.getByRole("heading", { name: "Serial", exact: true }),
        })
        .last();
      const viewChip = feedMain.getByRole("radio", {
        name: fixture.viewName,
        exact: true,
      });
      await expect(viewChip).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(() =>
          viewChip.evaluate((element) =>
            element.classList.contains("opacity-50"),
          ),
        )
        .toBe(expectedItemIds.length === 0);

      const retainedScopeKey =
        `serial-mixed-content-store-v2::normalized:v1::record:scopes:` +
        encodeURIComponent(`view:${fixture.viewId}:saved:unread`);
      await expect
        .poll(
          async () => (await indexedDbKeys(page)).includes(retainedScopeKey),
          { timeout: 30_000 },
        )
        .toBe(true);

      await beginSkeletonObservation(feedMain);
      await viewChip.click();

      const renderedItems = feedMain.locator("article[data-item-id]");
      await expect
        .poll(() => renderedItemIds(renderedItems), { timeout: 30_000 })
        .toEqual(expectedItemIds);

      const sections = [0, 1, 2].map((sectionIndex) =>
        feedMain.locator(`#section-${sectionIndex}`),
      );

      for (const [itemId, expectedSectionIndex] of expectedSectionByItemId) {
        const globalItem = feedMain.locator(`[data-item-id="${itemId}"]`);
        await expect(globalItem).toHaveCount(
          expectedSectionIndex === null ? 0 : 1,
        );

        for (const [sectionIndex, section] of sections.entries()) {
          await expect(
            section.locator(`[data-item-id="${itemId}"]`),
          ).toHaveCount(sectionIndex === expectedSectionIndex ? 1 : 0);
        }
      }

      const expectedSectionItemIds = [0, 1, 2].map((sectionIndex) =>
        [...expectedSectionByItemId.entries()]
          .flatMap(([itemId, expectedSection]) =>
            expectedSection === sectionIndex ? [itemId] : [],
          )
          .sort(),
      );
      await expect(feedMain.locator('[id^="section-"]')).toHaveCount(
        expectedItemIds.length === 0 ? 0 : 3,
      );
      for (const [sectionIndex, section] of sections.entries()) {
        await expect
          .poll(() => renderedItemIds(section.locator("[data-item-id]")))
          .toEqual(expectedSectionItemIds[sectionIndex]);

        const heading = section.getByRole("heading", {
          name: ["Test Blog", fixture.tagName, "Uncategorized"][sectionIndex],
          exact: true,
        });
        if (expectedSectionItemIds[sectionIndex]?.length) {
          await expect(section).toBeVisible();
          await expect(heading).toBeVisible();
        } else {
          await expect(heading).toHaveCount(0);
        }
      }

      expect(await finishSkeletonObservation(page)).toBe(false);
    });
  }

  for (const contentStatus of [
    { saveStatus: "inbox", archiveStatus: "unread" },
    { saveStatus: "inbox", archiveStatus: "archived" },
    { saveStatus: "saved", archiveStatus: "unread" },
    { saveStatus: "saved", archiveStatus: "archived" },
  ] as const) {
    const statusName = `${contentStatus.saveStatus} + ${contentStatus.archiveStatus}`;

    test(`visibly renders configured content in ${statusName}`, async ({
      page,
    }) => {
      test.setTimeout(45_000);
      const fixture = await seedMixedViewSectionCase(
        SELF_HOSTED_TURSO_PORT,
        SELF_HOSTED_APP_PORT,
        {
          feedSectionFeedItem: true,
          tagSectionFeedItem: true,
          tagSectionBookmark: true,
          uncategorizedFeedItem: true,
          uncategorizedBookmark: true,
        },
        contentStatus,
      );
      testEmail = fixture.email;

      await signIn({
        page,
        email: fixture.email,
        password: fixture.password,
      });
      await contentStatusTab(
        page,
        contentStatus.saveStatus === "saved" ? "Saved" : "Inbox",
      ).click();
      await contentStatusTab(
        page,
        contentStatus.archiveStatus === "archived" ? "Archived" : "Unread",
      ).click();

      const feedMain = page
        .locator("main")
        .filter({
          has: page.getByRole("heading", { name: "Serial", exact: true }),
        })
        .last();
      await feedMain
        .getByRole("radio", { name: fixture.viewName, exact: true })
        .click();

      const expectedSections = [
        {
          name: "Test Blog",
          itemIds: [fixture.items.feedSectionFeedItem],
        },
        {
          name: fixture.tagName,
          itemIds: [
            fixture.items.tagSectionFeedItem,
            fixture.items.tagSectionBookmark,
          ],
        },
        {
          name: "Uncategorized",
          itemIds: [
            fixture.items.uncategorizedFeedItem,
            fixture.items.uncategorizedBookmark,
          ],
        },
      ];

      if (contentStatus.archiveStatus === "archived") {
        const section = feedMain.locator("#section-0");
        await expect(section).toBeVisible({ timeout: 30_000 });
        await expect(feedMain.locator('[id^="section-"]')).toHaveCount(1);
        await expect(
          section.getByRole("heading", {
            name: fixture.viewName,
            exact: true,
          }),
        ).toBeVisible();
        await expect
          .poll(() => renderedItemIdsInOrder(section.locator("[data-item-id]")))
          .toEqual([
            fixture.items.feedSectionFeedItem,
            fixture.items.uncategorizedBookmark,
            fixture.items.tagSectionFeedItem,
            fixture.items.tagSectionBookmark,
            fixture.items.uncategorizedFeedItem,
          ]);
        return;
      }

      for (const [
        sectionIndex,
        expectedSection,
      ] of expectedSections.entries()) {
        const section = feedMain.locator(`#section-${sectionIndex}`);
        await expect(section).toBeVisible({ timeout: 30_000 });
        await expect(
          section.getByRole("heading", {
            name: expectedSection.name,
            exact: true,
          }),
        ).toBeVisible();
        await expect
          .poll(() => renderedItemIds(section.locator("[data-item-id]")))
          .toEqual([...expectedSection.itemIds].sort());
      }
    });
  }

  for (const contentStatus of [
    { saveStatus: "inbox", archiveStatus: "unread" },
    { saveStatus: "inbox", archiveStatus: "archived" },
    { saveStatus: "saved", archiveStatus: "unread" },
    { saveStatus: "saved", archiveStatus: "archived" },
  ] as const) {
    test(`keeps matching Bookmark and Feed rows independent across View, Tag, and Feed in ${contentStatus.saveStatus} + ${contentStatus.archiveStatus}`, async ({
      page,
    }) => {
      test.setTimeout(60_000);
      const fixture = await seedMixedViewSectionCase(
        SELF_HOSTED_TURSO_PORT,
        SELF_HOSTED_APP_PORT,
        {
          feedSectionFeedItem: false,
          tagSectionFeedItem: true,
          tagSectionBookmark: true,
          uncategorizedFeedItem: false,
          uncategorizedBookmark: false,
        },
        contentStatus,
      );
      testEmail = fixture.email;
      await matchBookmarkToFeedItem(
        SELF_HOSTED_TURSO_PORT,
        fixture.items.tagSectionBookmark,
        fixture.items.tagSectionFeedItem,
      );
      await signIn({
        page,
        email: fixture.email,
        password: fixture.password,
      });
      await contentStatusTab(
        page,
        contentStatus.saveStatus === "saved" ? "Saved" : "Inbox",
      ).click();
      await contentStatusTab(
        page,
        contentStatus.archiveStatus === "archived" ? "Archived" : "Unread",
      ).click();

      const feedMain = page
        .locator("main")
        .filter({
          has: page.getByRole("heading", { name: "Serial", exact: true }),
        })
        .last();
      const feedItem = feedMain.locator(
        `article[data-item-id="${fixture.items.tagSectionFeedItem}"]`,
      );
      const bookmark = feedMain.locator(
        `article[data-item-id="${fixture.items.tagSectionBookmark}"]`,
      );

      await feedMain
        .getByRole("radio", { name: fixture.viewName, exact: true })
        .click();
      await expect(feedItem).toBeVisible({ timeout: 30_000 });
      await expect(bookmark).toBeVisible();

      const tagButton = page
        .locator('[data-sidebar="group"]')
        .filter({
          has: page.locator('[data-sidebar="group-label"]', {
            hasText: "Tags",
          }),
        })
        .locator('[data-sidebar="menu-button"]')
        .filter({ hasText: fixture.tagName });
      // The exhaustive fixture can push this control below the nested
      // sidebar viewport. Dispatching through the located control exercises
      // the same React handler without making pointer scrolling part of the
      // data-topology assertion.
      await tagButton.dispatchEvent("click");
      await expect(feedItem).toBeVisible({ timeout: 30_000 });
      await expect(bookmark).toBeVisible();

      if (
        contentStatus.saveStatus === "saved" &&
        contentStatus.archiveStatus === "unread"
      ) {
        await bookmark.getByRole("link").hover();
        await page.keyboard.press("s");
        await expect(bookmark).toHaveCount(0);
        await expect(feedItem).toBeVisible();
      }

      const feedButton = page
        .locator('[data-sidebar="group"]')
        .filter({
          has: page.locator('[data-sidebar="group-label"]', {
            hasText: "Feeds",
          }),
        })
        .locator('[data-sidebar="menu-button"]')
        .filter({ hasText: fixture.feeds.tagSection.name });
      await feedButton.dispatchEvent("click");
      await expect(feedItem).toBeVisible({ timeout: 30_000 });
      await expect(bookmark).toHaveCount(0);
    });
  }

  test("advances while retaining Saved Unread items until status navigation", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const fixture = await seedMixedViewSectionCase(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
      {
        feedSectionFeedItem: true,
        tagSectionFeedItem: true,
        tagSectionBookmark: true,
        uncategorizedFeedItem: true,
        uncategorizedBookmark: true,
      },
      { saveStatus: "saved", archiveStatus: "unread" },
    );
    testEmail = fixture.email;

    await signIn({
      page,
      email: fixture.email,
      password: fixture.password,
    });
    await contentStatusTab(page, "Saved").click();

    const feedMain = page
      .locator("main")
      .filter({
        has: page.getByRole("heading", { name: "Serial", exact: true }),
      })
      .last();
    await feedMain
      .getByRole("radio", { name: fixture.viewName, exact: true })
      .click();

    const feedItem = feedMain.locator(
      `article[data-item-id="${fixture.items.feedSectionFeedItem}"]`,
    );
    const nextFeedItem = feedMain.locator(
      `article[data-item-id="${fixture.items.tagSectionFeedItem}"]`,
    );
    await expect(feedItem).toBeVisible({ timeout: 30_000 });

    const initialOrder = await renderedItemIdsInOrder(
      feedMain.locator("article[data-item-id]"),
    );

    await feedItem.getByRole("link").hover();
    await page.keyboard.press("e");
    await expect(feedItem).toHaveCSS("opacity", "0.75");
    expect(
      await renderedItemIdsInOrder(feedMain.locator("article[data-item-id]")),
    ).toEqual(initialOrder);
    await expect(nextFeedItem.getByRole("link")).toHaveClass(/md:bg-muted/);
    await expect(
      feedMain.getByRole("heading", { name: "Test Blog", exact: true }),
    ).toBeVisible();

    await contentStatusTab(page, "Archived").click();
    await expect(feedItem).toBeVisible();
    await contentStatusTab(page, "Unread").click();
    await expect(feedItem).toHaveCount(0);
  });

  test("collapses Saved Archived into one View section", async ({ page }) => {
    test.setTimeout(45_000);
    const fixture = await seedMixedViewSectionCase(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
      {
        feedSectionFeedItem: true,
        tagSectionFeedItem: true,
        tagSectionBookmark: true,
        uncategorizedFeedItem: false,
        uncategorizedBookmark: false,
      },
      { saveStatus: "saved", archiveStatus: "unread" },
    );
    await archiveMixedViewItems(SELF_HOSTED_TURSO_PORT, {
      feedItemIds: [fixture.items.feedSectionFeedItem],
      bookmarkIds: [fixture.items.tagSectionBookmark],
    });
    testEmail = fixture.email;

    await signIn({
      page,
      email: fixture.email,
      password: fixture.password,
    });
    await contentStatusTab(page, "Saved").click();
    await contentStatusTab(page, "Archived").click();

    const feedMain = page
      .locator("main")
      .filter({
        has: page.getByRole("heading", { name: "Serial", exact: true }),
      })
      .last();
    await feedMain
      .getByRole("radio", { name: fixture.viewName, exact: true })
      .click();

    const section = feedMain.locator("#section-0");
    await expect(section).toBeVisible({ timeout: 10_000 });
    await expect(feedMain.locator('[id^="section-"]')).toHaveCount(1);
    await expect(
      section.getByRole("heading", { name: fixture.viewName, exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => renderedItemIdsInOrder(section.locator("[data-item-id]")))
      .toEqual(
        [
          fixture.items.feedSectionFeedItem,
          fixture.items.tagSectionBookmark,
        ].sort((leftId, rightId) => rightId.localeCompare(leftId)),
      );
  });

  test("shows a feed item immediately after saving it and entering its View", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    const fixture = await seedMixedViewSectionCase(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
      {
        feedSectionFeedItem: true,
        tagSectionFeedItem: false,
        tagSectionBookmark: false,
        uncategorizedFeedItem: false,
        uncategorizedBookmark: false,
      },
      { saveStatus: "inbox", archiveStatus: "unread" },
    );
    testEmail = fixture.email;

    await signIn({
      page,
      email: fixture.email,
      password: fixture.password,
    });
    const feedMain = page
      .locator("main")
      .filter({
        has: page.getByRole("heading", { name: "Serial", exact: true }),
      })
      .last();
    await feedMain.getByRole("radio", { name: "All", exact: true }).click();

    const item = feedMain.locator(
      `article[data-item-id="${fixture.items.feedSectionFeedItem}"]`,
    );
    await expect(item).toBeVisible({ timeout: 30_000 });
    await item.getByRole("link").hover();
    await page.keyboard.press("s");

    await contentStatusTab(page, "Saved").click();
    await feedMain
      .getByRole("radio", { name: fixture.viewName, exact: true })
      .click();
    await expect(item).toBeVisible({ timeout: 5_000 });
  });

  test("refreshes a loaded View when a newly saved item enters its content status", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const fixture = await seedSavedViewClientStateData(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
    );
    testEmail = fixture.email;

    await signIn({
      page,
      email: fixture.email,
      password: fixture.password,
    });
    const feedMain = page
      .locator("main")
      .filter({
        has: page.getByRole("heading", { name: "Serial", exact: true }),
      })
      .last();
    const targetViewChip = feedMain.getByRole("radio", {
      name: fixture.viewName,
      exact: true,
    });

    await contentStatusTab(page, "Saved").click();
    await targetViewChip.click();
    await expect(feedMain.locator("article[data-item-id]").first()).toBeVisible(
      {
        timeout: 30_000,
      },
    );
    await page.mouse.wheel(0, 10_000);

    const loadedScopeKey =
      `serial-mixed-content-store-v2::normalized:v1::record:scopes:` +
      encodeURIComponent(`view:${fixture.targetViewId}:saved:unread`);
    await expect
      .poll(
        async () => {
          const keys = await indexedDbKeys(page);
          return keys.includes(loadedScopeKey);
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    await contentStatusTab(page, "Inbox").click();
    const targetItem = feedMain.locator(
      `article[data-item-id="${fixture.targetItemId}"]`,
    );
    await expect(targetItem).toBeVisible({ timeout: 30_000 });
    await targetItem.getByRole("link").hover();
    await page.keyboard.press("s");

    await contentStatusTab(page, "Saved").click();
    await expect(targetItem).toBeVisible({ timeout: 5_000 });
  });

  test("renders mixed Feed items and Bookmarks in one View section in Archived", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    const fullyMixedCase = {
      feedSectionFeedItem: true,
      tagSectionFeedItem: true,
      tagSectionBookmark: true,
      uncategorizedFeedItem: true,
      uncategorizedBookmark: true,
    };
    const fixture = await seedMixedViewSectionCase(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
      fullyMixedCase,
      { saveStatus: "inbox", archiveStatus: "archived" },
    );
    testEmail = fixture.email;

    await signIn({
      page,
      email: fixture.email,
      password: fixture.password,
    });
    await contentStatusTab(page, "Archived").click();

    const feedMain = page
      .locator("main")
      .filter({
        has: page.getByRole("heading", { name: "Serial", exact: true }),
      })
      .last();
    await feedMain
      .getByRole("radio", { name: fixture.viewName, exact: true })
      .click();

    const section = feedMain.locator("#section-0");
    await expect(section).toBeVisible({ timeout: 30_000 });
    await expect(feedMain.locator('[id^="section-"]')).toHaveCount(1);
    await expect(
      section.getByRole("heading", { name: fixture.viewName, exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => renderedItemIdsInOrder(section.locator("[data-item-id]")))
      .toEqual([
        fixture.items.feedSectionFeedItem,
        fixture.items.uncategorizedBookmark,
        fixture.items.tagSectionFeedItem,
        fixture.items.tagSectionBookmark,
        fixture.items.uncategorizedFeedItem,
      ]);
    await expect(
      feedMain.locator(`[data-item-id="${fixture.items.outsideFeedItem}"]`),
    ).toHaveCount(0);
    await expect(
      feedMain.locator(`[data-item-id="${fixture.items.outsideBookmark}"]`),
    ).toHaveCount(0);

    const emptyViewChip = feedMain.getByRole("radio", {
      name: fixture.emptyViewName,
      exact: true,
    });
    await expect(emptyViewChip).toHaveClass(/opacity-50/);
    await emptyViewChip.click();
    await expect(feedMain.locator("article[data-item-id]")).toHaveCount(0);
  });
});
