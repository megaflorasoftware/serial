import { test, expect } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OPML_PATH = path.join(__dirname, "../fixtures/subscriptions.opml");

test.describe("import flow", () => {
  test("completes full import workflow", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveURL(/auth\/sign-in/);

    await page.goto("/auth/sign-up");

    await expect(page).toHaveURL(/auth\/sign-up/);

    await expect(page.getByText(/admin account creation|sign up/i)).toBeVisible(
      { timeout: 10000 },
    );

    await page.locator("#first-name").click();
    await page.locator("#first-name").pressSequentially("Test User");
    await page.locator("#email").click();
    await page.locator("#email").pressSequentially("test@example.com");
    await page.locator("#password").click();
    await page.locator("#password").pressSequentially("testpassword123");
    await page.locator("#password_confirmation").click();
    await page.locator("#password_confirmation").pressSequentially("testpassword123");

    await page.getByRole("button", { name: /create an account/i }).click();

    await expect(page).toHaveURL("/", { timeout: 30000 });

    await page.goto("/import");
    await expect(page.getByText("Import Feeds")).toBeVisible();

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByText(/drag and drop/i).click();
    const fileChooser = await fileChooserPromise;
    const opmlContent = fs.readFileSync(OPML_PATH);
    await fileChooser.setFiles({
      name: "subscriptions.opml",
      mimeType: "application/xml",
      buffer: opmlContent,
    });

    await expect(page.getByText("Feeds To Import")).toBeVisible({
      timeout: 10000,
    });

    const importButton = page.getByRole("button", {
      name: /import \d+ feeds/i,
    });
    await expect(importButton).toBeEnabled({ timeout: 10000 });
    await importButton.click();

    await expect(page.getByText("Import finished")).toBeVisible({
      timeout: 60000,
    });

    await page.getByRole("link", { name: /back to feeds/i }).click();
    await expect(page).toHaveURL("/");

    await expect(
      page.getByRole("button", { name: "Scary Pockets" }).first(),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByRole("button", { name: "Fireship" }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "CGP Grey" }).first(),
    ).toBeVisible();
  });
});
