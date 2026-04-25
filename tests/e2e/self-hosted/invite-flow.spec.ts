import { expect, test } from "@playwright/test";
import { signUp } from "../fixtures/auth";
import { SELF_HOSTED_TURSO_PORT } from "../fixtures/ports";
import { cleanupUser, generateTestEmail } from "../fixtures/seed-db";

test.describe("invite flow", () => {
  let adminEmail: string;
  let invitedEmail: string;

  test.afterEach(async () => {
    if (invitedEmail) {
      await cleanupUser(SELF_HOSTED_TURSO_PORT, invitedEmail);
    }
    if (adminEmail) {
      await cleanupUser(SELF_HOSTED_TURSO_PORT, adminEmail);
    }
  });

  test("admin creates invite link, invited user signs up with it", async ({
    page,
  }) => {
    test.setTimeout(120000);
    adminEmail = generateTestEmail();
    invitedEmail = generateTestEmail();
    const password = "testpassword123";

    // ── 1. Sign up as the first user (becomes admin) ────────────────
    await signUp({
      page,
      name: "Admin User",
      email: adminEmail,
      password,
    });

    // ── 2. Navigate to admin invites page ─────────────────────────────
    await page.goto("/admin/invites");
    await expect(page.getByText("Invites")).toBeVisible({ timeout: 10000 });

    // ── 3. Public signup should be off by default; click create invite button
    const createInviteButton = page.getByRole("button", {
      name: /create invite link/i,
    });
    await expect(createInviteButton).toBeVisible({ timeout: 10000 });
    await createInviteButton.click();
    await expect(page.getByText("Invite User")).toBeVisible();

    // ── 4. Click to create the invite link inside the dialog ────────
    const dialogCreateButton = page
      .locator("[role=dialog], [data-vaul-drawer]")
      .getByRole("button", { name: /create invite link/i });
    await dialogCreateButton.click();

    // ── 5. Wait for the invite URL to appear in the <code> block ────
    const codeBlock = page.locator("pre code");
    await expect(codeBlock).toBeVisible({ timeout: 10000 });
    const inviteUrl = await codeBlock.textContent();
    expect(inviteUrl).toBeTruthy();
    expect(inviteUrl).toContain("/auth/sign-up?token=");

    // ── 6. Extract the relative path from the invite URL ────────────
    const url = new URL(inviteUrl!.trim());
    const invitePath = `${url.pathname}${url.search}`;

    // ── 7. Sign out the admin ───────────────────────────────────────
    // Close the dialog first
    const closeButton = page.locator(
      "[role=dialog] button:has(svg), [data-vaul-drawer] button:has(svg)",
    );
    if (await closeButton.first().isVisible()) {
      await closeButton.first().click();
    }

    // Sign out via the API to ensure clean state
    await page.goto("/api/auth/sign-out", { waitUntil: "networkidle" });

    // ── 8. Visit the invite link as a new user ──────────────────────
    await page.goto(invitePath);

    // The sign-up form should be visible even though public signup is off
    await expect(
      page.getByRole("button", { name: /create an account/i }),
    ).toBeVisible({ timeout: 10000 });

    // ── 9. Fill in the sign-up form and create the account ──────────
    await page
      .locator("#first-name")
      .pressSequentially("Invited User", { delay: 50 });
    await page.locator("#email").pressSequentially(invitedEmail, { delay: 50 });
    await page.locator("#password").pressSequentially(password, { delay: 50 });
    await page
      .locator("#password_confirmation")
      .pressSequentially(password, { delay: 50 });

    await page.getByRole("button", { name: /create an account/i }).click();
    await expect(page).toHaveURL("/", { timeout: 30000 });

    // ── 10. Verify the invite link is now single-use ────────────────
    // Sign out the invited user
    await page.goto("/api/auth/sign-out", { waitUntil: "networkidle" });

    // Try visiting the same invite link again
    await page.goto(invitePath);

    // Should see "Sign ups are currently disabled" since the token is used
    await expect(
      page.getByText(/sign ups are currently disabled/i),
    ).toBeVisible({ timeout: 10000 });
  });
});
