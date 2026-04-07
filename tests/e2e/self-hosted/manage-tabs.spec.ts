import { expect, test } from "@playwright/test";
import {
  SELF_HOSTED_APP_PORT,
  SELF_HOSTED_RSS_SERVER_PORT,
  SELF_HOSTED_TURSO_PORT,
} from "../fixtures/ports";
import { cleanupUser, seedArticleData } from "../fixtures/seed-db";
import { signIn } from "../fixtures/auth";

test.describe("manage feeds/views/tags tabs", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  let testEmail: string;

  test.afterEach(async () => {
    if (testEmail) {
      await cleanupUser(SELF_HOSTED_TURSO_PORT, testEmail);
    }
  });

  test("tabs navigate between /feeds, /views, /tags via click and 1/2/3 keys", async ({
    page,
  }) => {
    test.setTimeout(120000);

    const { email, password } = await seedArticleData(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
      SELF_HOSTED_RSS_SERVER_PORT,
    );
    testEmail = email;

    await signIn({ page, email, password });
    await expect(page.locator("article").first()).toBeVisible({
      timeout: 30000,
    });

    // Start at /feeds
    await page.goto("/feeds");
    const feedsTab = page.getByRole("tab", { name: /feeds/i });
    const viewsTab = page.getByRole("tab", { name: /views/i });
    const tagsTab = page.getByRole("tab", { name: /tags/i });
    await expect(feedsTab).toBeVisible({ timeout: 10000 });
    await expect(feedsTab).toHaveAttribute("data-state", "active");

    // Click navigates to /views
    await viewsTab.click();
    await expect(page).toHaveURL(/\/views$/);
    await expect(viewsTab).toHaveAttribute("data-state", "active");

    // Click navigates to /tags
    await tagsTab.click();
    await expect(page).toHaveURL(/\/tags$/);
    await expect(tagsTab).toHaveAttribute("data-state", "active");

    // Press "1" to go to /feeds
    await page.keyboard.press("1");
    await expect(page).toHaveURL(/\/feeds$/);

    // Press "2" to go to /views
    await page.keyboard.press("2");
    await expect(page).toHaveURL(/\/views$/);

    // Press "3" to go to /tags
    await page.keyboard.press("3");
    await expect(page).toHaveURL(/\/tags$/);
  });

  test("create, edit, and bulk delete views via /views", async ({ page }) => {
    test.setTimeout(120000);

    const { email, password } = await seedArticleData(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
      SELF_HOSTED_RSS_SERVER_PORT,
    );
    testEmail = email;

    await signIn({ page, email, password });
    await expect(page.locator("article").first()).toBeVisible({
      timeout: 30000,
    });

    await page.goto("/views");
    await expect(
      page.getByRole("tab", { name: /views/i, selected: true }),
    ).toBeVisible({ timeout: 10000 });

    // Click + to add a view
    const addBtn = page
      .locator("button")
      .filter({ has: page.locator("svg.lucide-plus") })
      .first();
    await addBtn.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.getByRole("heading", { name: "Add View" })).toBeVisible(
      { timeout: 5000 },
    );

    await dialog
      .locator('input[placeholder="My View"]')
      .pressSequentially("Bulk View A", { delay: 30 });
    await dialog.getByRole("button", { name: /add view/i }).click();
    await expect(page.getByText("View added!")).toBeVisible({ timeout: 10000 });

    // Add a second view
    await addBtn.click();
    await expect(dialog.getByRole("heading", { name: "Add View" })).toBeVisible(
      { timeout: 5000 },
    );
    await dialog
      .locator('input[placeholder="My View"]')
      .pressSequentially("Bulk View B", { delay: 30 });
    await dialog.getByRole("button", { name: /add view/i }).click();
    await expect(page.getByText("View added!")).toBeVisible({ timeout: 10000 });

    // Both views should be visible in the list
    await expect(page.getByText("Bulk View A")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Bulk View B")).toBeVisible({ timeout: 5000 });

    // Edit single view via pencil button
    const rowA = page
      .locator("button[type='button']")
      .filter({ hasText: "Bulk View A" });
    await rowA.locator("button").last().click(); // pencil button
    await expect(
      page.locator('[role="dialog"]').getByRole("heading", {
        name: "Edit View",
      }),
    ).toBeVisible({ timeout: 5000 });
    // Close the dialog
    await page.keyboard.press("Escape");

    // Select All via "s" shortcut, then bulk delete via "d"
    await page.keyboard.press("s");
    // Bulk Edit dialog button should be visible
    await expect(
      page.getByRole("button", { name: /^edit/i }).first(),
    ).toBeVisible({ timeout: 5000 });

    // Open bulk edit dialog with "e"
    await page.keyboard.press("e");
    await expect(
      page.locator('[role="dialog"]').getByRole("heading", {
        name: "Edit Views",
      }),
    ).toBeVisible({ timeout: 5000 });
    // Cancel
    await page
      .locator('[role="dialog"]')
      .getByRole("button", { name: /cancel/i })
      .click();

    // Re-select all and delete
    await page.keyboard.press("s");
    await page.keyboard.press("d");
    const deleteDialog = page.locator('[role="dialog"]').filter({
      hasText: "Delete Views",
    });
    await expect(deleteDialog).toBeVisible({ timeout: 5000 });
    await deleteDialog.getByRole("button", { name: /^delete$/i }).click();
    await expect(page.getByText(/deleted .* view/i)).toBeVisible({
      timeout: 10000,
    });

    // Both views should be gone
    await expect(page.getByText("Bulk View A")).toHaveCount(0, {
      timeout: 10000,
    });
    await expect(page.getByText("Bulk View B")).toHaveCount(0, {
      timeout: 10000,
    });
  });

  test("create tag with feed assignment via dialog and verify on /feeds", async ({
    page,
  }) => {
    test.setTimeout(120000);

    const { email, password } = await seedArticleData(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
      SELF_HOSTED_RSS_SERVER_PORT,
    );
    testEmail = email;

    await signIn({ page, email, password });
    await expect(page.locator("article").first()).toBeVisible({
      timeout: 30000,
    });

    await page.goto("/tags");
    await expect(
      page.getByRole("tab", { name: /tags/i, selected: true }),
    ).toBeVisible({ timeout: 10000 });

    // Click + to add a tag
    const addBtn = page
      .locator("button")
      .filter({ has: page.locator("svg.lucide-plus") })
      .first();
    await addBtn.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.getByRole("heading", { name: "Add Tag" })).toBeVisible({
      timeout: 5000,
    });

    await dialog
      .locator('input[placeholder="My Tag"]')
      .pressSequentially("Tag With Feed", { delay: 30 });

    // Open the Feeds combobox
    const feedsLabel = dialog.getByText("Feeds", { exact: true });
    await expect(feedsLabel).toBeVisible({ timeout: 3000 });
    const feedsPlusBtn = feedsLabel.locator("..").locator("button").first();
    await feedsPlusBtn.click();
    await page.waitForTimeout(500);

    const feedOption = page.getByRole("option").first();
    await expect(feedOption).toBeVisible({ timeout: 3000 });
    await feedOption.click({ force: true });
    await page.waitForTimeout(300);

    // Close the popover
    await dialog.getByRole("heading", { name: "Add Tag" }).click();

    await dialog.getByRole("button", { name: /add tag/i }).click();
    await expect(page.getByText("Tag created!")).toBeVisible({
      timeout: 10000,
    });

    // The tag row should now show the assigned feed badge ("Test Blog")
    await expect(
      page.locator("button[type='button']").filter({
        hasText: "Tag With Feed",
      }),
    ).toBeVisible({ timeout: 5000 });

    // Navigate to /feeds and verify the tag chip on the feed row
    await page.keyboard.press("1");
    await expect(page).toHaveURL(/\/feeds$/);

    await expect(
      page.locator("main").locator('[data-slot="badge"]').filter({
        hasText: "Tag With Feed",
      }),
    ).toBeVisible({ timeout: 10000 });
  });

  test("bulk assign feeds to multiple tags from /tags", async ({ page }) => {
    test.setTimeout(120000);

    const { email, password } = await seedArticleData(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
      SELF_HOSTED_RSS_SERVER_PORT,
    );
    testEmail = email;

    await signIn({ page, email, password });
    await expect(page.locator("article").first()).toBeVisible({
      timeout: 30000,
    });

    await page.goto("/tags");
    await expect(
      page.getByRole("tab", { name: /tags/i, selected: true }),
    ).toBeVisible({ timeout: 10000 });

    // Create two tags (without feeds)
    const addBtn = page
      .locator("button")
      .filter({ has: page.locator("svg.lucide-plus") })
      .first();
    const dialog = page.locator('[role="dialog"]');

    for (const tagName of ["Tag Alpha", "Tag Beta"]) {
      await addBtn.click();
      await expect(
        dialog.getByRole("heading", { name: "Add Tag" }),
      ).toBeVisible({ timeout: 5000 });
      await dialog
        .locator('input[placeholder="My Tag"]')
        .pressSequentially(tagName, { delay: 30 });
      await dialog.getByRole("button", { name: /add tag/i }).click();
      await expect(page.getByText("Tag created!")).toBeVisible({
        timeout: 10000,
      });
    }

    // Select all tags and use Assign Feeds bulk action
    await page.keyboard.press("s");
    await page.keyboard.press("e"); // opens "Assign Feeds" bulk dialog

    const assignDialog = page.locator('[role="dialog"]').filter({
      hasText: "Assign Feeds",
    });
    await expect(assignDialog).toBeVisible({ timeout: 5000 });

    // Open feeds combobox in the assign dialog
    const feedsLabel = assignDialog.getByText("Feeds", { exact: true });
    const feedsPlusBtn = feedsLabel.locator("..").locator("button").first();
    await feedsPlusBtn.click();
    await page.waitForTimeout(500);

    const feedOption = page.getByRole("option").first();
    await expect(feedOption).toBeVisible({ timeout: 3000 });
    await feedOption.click({ force: true });
    await page.waitForTimeout(300);

    // Close popover and submit
    await assignDialog.getByRole("heading", { name: "Assign Feeds" }).click();
    await assignDialog.getByRole("button", { name: /^assign$/i }).click();
    await expect(page.getByText(/assigned feeds to/i)).toBeVisible({
      timeout: 10000,
    });

    // Both tag rows should now show the feed name as a badge
    const alphaRow = page
      .locator("button[type='button']")
      .filter({ hasText: "Tag Alpha" });
    const betaRow = page
      .locator("button[type='button']")
      .filter({ hasText: "Tag Beta" });
    await expect(alphaRow.locator('[data-slot="badge"]')).toBeVisible({
      timeout: 5000,
    });
    await expect(betaRow.locator('[data-slot="badge"]')).toBeVisible({
      timeout: 5000,
    });

    // Verify on /feeds: the feed row should show both tag chips
    await page.keyboard.press("1");
    await expect(page).toHaveURL(/\/feeds$/);
    await expect(
      page.locator("main").locator('[data-slot="badge"]').filter({
        hasText: "Tag Alpha",
      }),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.locator("main").locator('[data-slot="badge"]').filter({
        hasText: "Tag Beta",
      }),
    ).toBeVisible({ timeout: 10000 });
  });
});
