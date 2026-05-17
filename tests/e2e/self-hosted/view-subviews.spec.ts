import { expect, test } from "@playwright/test";
import {
  SELF_HOSTED_APP_PORT,
  SELF_HOSTED_RSS_SERVER_PORT,
  SELF_HOSTED_TURSO_PORT,
} from "../fixtures/ports";
import { cleanupUser, seedViewLayoutData } from "../fixtures/seed-db";
import { signIn } from "../fixtures/auth";

test.describe.configure({ mode: "serial" });

test.describe("view subview sections", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  let testEmail: string;

  test.afterEach(async () => {
    if (testEmail) {
      await cleanupUser(SELF_HOSTED_TURSO_PORT, testEmail);
    }
  });

  test("create view with feeds and tags, configure layout sections, verify rendering and keyboard navigation", async ({
    page,
  }) => {
    test.setTimeout(120000);

    // ── 1. Seed user with 3 feeds, 2 tags, and articles ─────────────
    const { email, password } = await seedViewLayoutData(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
      SELF_HOSTED_RSS_SERVER_PORT,
    );
    testEmail = email;

    await signIn({ page, email, password });
    await expect(page.locator("article").first()).toBeVisible({
      timeout: 30000,
    });

    // ── 2. Create a view with all 3 feeds and 2 tags ───────────────
    const viewsSection = page.locator('[data-sidebar="group"]').filter({
      hasText: "Views",
    });
    await expect(viewsSection).toBeVisible({ timeout: 10000 });
    const addViewBtn = viewsSection
      .locator('[data-sidebar="group-label"] [data-sidebar="menu-button"]')
      .nth(1);
    await addViewBtn.evaluate((el: HTMLElement) => el.click());

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.getByRole("heading", { name: "Add View" })).toBeVisible(
      { timeout: 5000 },
    );

    // Name the view
    await dialog
      .locator('input[placeholder="My View"]')
      .pressSequentially("Layout Test View", { delay: 30 });

    // Add all 3 feeds by name (single dropdown session)
    const feedsLabel = dialog.getByText("Feeds", { exact: true });
    await expect(feedsLabel).toBeVisible({ timeout: 3000 });
    const feedsPlusBtn = feedsLabel.locator("..").locator("button").first();

    await feedsPlusBtn.click();
    await page.waitForTimeout(500);

    const feedNames = ["Tech Feed", "News Feed", "Mixed Feed"];
    for (const feedName of feedNames) {
      const feedOption = page.getByRole("option").filter({
        hasText: feedName,
      });
      await expect(feedOption).toBeVisible({ timeout: 3000 });
      await feedOption.click({ force: true });
      await page.waitForTimeout(300);
    }

    // Close feed popover
    await dialog.getByRole("heading", { name: "Add View" }).click();

    // Add all 2 tags by name (single dropdown session)
    const tagsLabel = dialog.getByText("Tags", { exact: true });
    await expect(tagsLabel).toBeVisible({ timeout: 3000 });
    const tagsPlusBtn = tagsLabel.locator("..").locator("button").first();

    await tagsPlusBtn.click();
    await page.waitForTimeout(500);

    const tagNames = ["Tech", "News"];
    for (const tagName of tagNames) {
      const tagOption = page.getByRole("option").filter({
        hasText: tagName,
      });
      await expect(tagOption).toBeVisible({ timeout: 3000 });
      await tagOption.click({ force: true });
      await page.waitForTimeout(300);
    }

    // Close tag popover
    await dialog.getByRole("heading", { name: "Add View" }).click();

    // ── 3. Switch to Display tab ─────────────────────────────────────
    const displayTab = dialog.getByRole("tab", { name: "Display" });
    await displayTab.click();
    await page.waitForTimeout(300);

    // ── 4. Add 2 feeds and 1 tag to the display ───────────────────────
    const addSubviewBtn = dialog.getByRole("button", {
      name: /add subview/i,
    });
    await expect(addSubviewBtn).toBeVisible({ timeout: 3000 });

    // Add first feed (Tech Feed)
    await addSubviewBtn.click();
    await page.waitForTimeout(500);
    const subviewFeedOption0 = page.getByRole("option").filter({
      hasText: /Tech Feed/i,
    });
    await expect(subviewFeedOption0).toBeVisible({ timeout: 3000 });
    await subviewFeedOption0.click({ force: true });
    await page.waitForTimeout(300);

    // Add second feed (News Feed)
    await addSubviewBtn.click();
    await page.waitForTimeout(500);
    const subviewFeedOption1 = page.getByRole("option").filter({
      hasText: /News Feed/i,
    });
    await expect(subviewFeedOption1).toBeVisible({ timeout: 3000 });
    await subviewFeedOption1.click({ force: true });
    await page.waitForTimeout(300);

    // Add first tag (#Tech)
    await addSubviewBtn.click();
    await page.waitForTimeout(500);
    const subviewTagOption0 = page.getByRole("option").filter({
      hasText: /#Tech/i,
    });
    await expect(subviewTagOption0).toBeVisible({ timeout: 3000 });
    await subviewTagOption0.click({ force: true });
    await page.waitForTimeout(300);

    // ── 5. Assign layouts ────────────────────────────────────────────
    // 1st item (Tech Feed) -> Large List
    const viewSectionRows = dialog.locator("[data-view-section-row]");
    await expect(viewSectionRows).toHaveCount(4, { timeout: 5000 }); // 3 view sections + Uncategorized

    const firstRowSelect = viewSectionRows
      .nth(0)
      .locator('[data-slot="select-trigger"]');
    await firstRowSelect.click();
    await page.waitForTimeout(300);
    await page.getByRole("option", { name: "Large List", exact: true }).click();
    await page.waitForTimeout(300);

    // 2nd item (News Feed) -> Default (already default, no change needed)

    // 3rd item (#Tech) -> List
    const thirdRowSelect = viewSectionRows
      .nth(2)
      .locator('[data-slot="select-trigger"]');
    await thirdRowSelect.click();
    await page.waitForTimeout(300);
    await page.getByRole("option", { name: "List", exact: true }).click();
    await page.waitForTimeout(300);

    // Uncategorized -> Grid
    const uncategorizedRowSelect = viewSectionRows
      .nth(3)
      .locator('[data-slot="select-trigger"]');
    await uncategorizedRowSelect.click();
    await page.waitForTimeout(300);
    await page.getByRole("option", { name: "Grid", exact: true }).click();
    await page.waitForTimeout(300);

    // ── 6. Save the view ─────────────────────────────────────────────
    await dialog.getByRole("button", { name: /add view/i }).click();
    await expect(page.getByText("View added!")).toBeVisible({
      timeout: 10000,
    });

    // ── 7. Verify view appears in sidebar ───────────────────────────
    const sidebarView = viewsSection.getByText("Layout Test View");
    await expect(sidebarView).toBeVisible({ timeout: 10000 });
    await sidebarView.click();

    // ── 8. Verify sectioned rendering ──────────────────────────────
    // Wait for items to render
    await page.waitForTimeout(1000);

    // Should see "Tech Feed" heading with large list layout items
    await expect(
      page.locator("h2").filter({ hasText: "Tech Feed" }),
    ).toBeVisible({ timeout: 10000 });

    // Should see "News Feed" heading
    await expect(
      page.locator("h2").filter({ hasText: "News Feed" }),
    ).toBeVisible({ timeout: 10000 });

    // Should see "#Tech" heading
    await expect(page.locator("h2").filter({ hasText: "#Tech" })).toBeVisible({
      timeout: 10000,
    });

    // Should see "Uncategorized" heading (but without label text since it
    // always shows "Uncategorized")
    await expect(
      page.locator("h2").filter({ hasText: "Uncategorized" }),
    ).toBeVisible({ timeout: 10000 });

    // ── 9. Verify keyboard navigation across sections ──────────────
    // Reset focus to body for keyboard shortcuts
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.focus();
    });
    await page.waitForTimeout(150);

    // Press arrow down to select first item
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);

    // All items in the Tech Feed section should be in large-list layout.
    // The first large-list item should now have the data-selected attribute.
    const firstItem = page.locator("[data-item-id]").first();
    await expect(firstItem).toHaveAttribute("data-selected", "true", {
      timeout: 5000,
    });

    // Navigate through Tech Feed items (2 items), then jump to News Feed
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);

    // After 3 downs, we should be at the first item of News Feed section
    // (the selection moved from last Tech Feed item to first News Feed item)
    const selectedAfterJump = page.locator('[data-selected="true"]');
    await expect(selectedAfterJump).toBeVisible({ timeout: 5000 });

    // ── 10. Edit view and delete a feed from Content tab ─────────────
    // Navigate to /views page to edit
    await page.goto("/views");
    await expect(
      page.getByRole("tab", { name: /views/i, selected: true }),
    ).toBeVisible({ timeout: 10000 });

    const mainContent = page.locator("main main");
    const viewRow = mainContent
      .locator("button[type='button']")
      .filter({ hasText: "Layout Test View" });
    await viewRow.locator("button").last().click(); // pencil button

    const editDialog = page.locator('[role="dialog"]');
    await expect(
      editDialog.getByRole("heading", { name: "Edit View" }),
    ).toBeVisible({ timeout: 5000 });

    // Switch to Content tab
    const contentTab = editDialog.getByRole("tab", { name: "Content" });
    await contentTab.click();
    await page.waitForTimeout(300);

    // Remove "Tech Feed" from the feeds list by clicking its chip X
    const techFeedBadge = editDialog
      .locator('[data-slot="badge"]')
      .filter({ hasText: /Tech Feed/i });
    await expect(techFeedBadge).toBeVisible({ timeout: 3000 });
    await techFeedBadge.locator("button").click();
    await expect(techFeedBadge).toHaveCount(0, { timeout: 3000 });

    // Switch back to Display tab and verify Tech Feed is gone
    const displayTabEdit = editDialog.getByRole("tab", { name: "Display" });
    await displayTabEdit.click();
    await page.waitForTimeout(300);

    const viewSectionRowsAfterDelete = editDialog.locator(
      "[data-view-section-row]",
    );
    // Should be 3 rows now: News Feed, #Tech, Uncategorized
    await expect(viewSectionRowsAfterDelete).toHaveCount(3, { timeout: 5000 });
    await expect(
      editDialog.getByText("Tech Feed", { exact: false }),
    ).toHaveCount(0, { timeout: 3000 });

    // Save the edit
    await editDialog.getByRole("button", { name: /save/i }).click();
    await expect(page.getByText("View updated!")).toBeVisible({
      timeout: 10000,
    });
  });
});
