import { createClient } from "@libsql/client";
import { expect, test } from "@playwright/test";
import { signIn } from "../fixtures/auth";
import { cleanupUser, seedArticleData } from "../fixtures/seed-db";
import {
  SELF_HOSTED_APP_PORT,
  SELF_HOSTED_RSS_SERVER_PORT,
  SELF_HOSTED_TURSO_PORT,
} from "../fixtures/ports";

test.use({ serviceWorkers: "block" });

let email = "";

test.afterEach(async () => {
  if (email) await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
});

test("returns to feed discovery after organizing a bookmark during onboarding", async ({
  page,
}) => {
  const fixture = await seedArticleData(
    SELF_HOSTED_TURSO_PORT,
    SELF_HOSTED_APP_PORT,
    SELF_HOSTED_RSS_SERVER_PORT,
  );
  email = fixture.email;
  await signIn({
    page,
    email,
    password: fixture.password,
    onboarding: true,
  });

  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const guide = page.getByRole("region", { name: "Onboarding guidance" });
  await expect(guide).toContainText("adding your first feed", {
    timeout: 30_000,
  });
  await page
    .locator('[data-onboarding="add-feed"]')
    .filter({ visible: true })
    .click();

  const dialog = page.getByRole("dialog");
  const bookmarkUrl = `http://127.0.0.1:${SELF_HOSTED_RSS_SERVER_PORT}/bookmark/success`;
  await dialog
    .getByPlaceholder("Paste a URL or search for a feed...")
    .fill(bookmarkUrl);
  const bookmarkOption = dialog.getByRole("option", {
    name: /Bookmark page to read later/,
  });
  await expect(bookmarkOption).toBeVisible({ timeout: 10_000 });
  await bookmarkOption.click();
  await expect(
    dialog.getByRole("heading", { name: "Organize Bookmark", exact: true }),
  ).toBeVisible({ timeout: 20_000 });

  await dialog.getByRole("button", { name: "Done", exact: true }).click();

  await expect(
    dialog.getByPlaceholder("Paste a URL or search for a feed..."),
  ).toBeVisible();
  await expect(guide).toContainText("Enter a website URL");
  await expect(
    page.getByRole("button", { name: "Skip Tutorial", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  const db = createClient({
    url: `http://127.0.0.1:${SELF_HOSTED_TURSO_PORT}`,
  });
  try {
    const bookmarkCount = async () => {
      const result = await db.execute({
        sql: "SELECT COUNT(*) AS count FROM serial_bookmark WHERE user_id = (SELECT id FROM serial_user WHERE email = ?) AND source_url = ?",
        args: [email, bookmarkUrl],
      });
      return Number(result.rows[0]?.count ?? 0);
    };
    await expect.poll(bookmarkCount).toBe(1);

    await dialog
      .getByPlaceholder("Paste a URL or search for a feed...")
      .fill(bookmarkUrl);
    await expect(bookmarkOption).toBeVisible({ timeout: 10_000 });
    await bookmarkOption.click();
    await expect(
      dialog.getByRole("heading", { name: "Organize Bookmark", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole("button", { name: "Delete Bookmark" }).click();
    await expect(
      dialog.getByPlaceholder("Paste a URL or search for a feed..."),
    ).toBeVisible();
    await expect(guide).toContainText("Enter a website URL");
    await expect.poll(bookmarkCount).toBe(0);
  } finally {
    db.close();
  }

  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toBeVisible();
});
