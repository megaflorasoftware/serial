import { expect, test } from "@playwright/test";
import {
  emulateMobileBrowserControls,
  expectPrimaryMobileScrolling,
} from "../fixtures/mobile-scroll";
import { signIn } from "../fixtures/auth";
import {
  SELF_HOSTED_APP_PORT,
  SELF_HOSTED_TURSO_PORT,
} from "../fixtures/ports";
import { cleanupUser, seedArticleData } from "../fixtures/seed-db";

test("mobile content owns scrolling as browser controls expand and retract", async ({
  page,
}) => {
  const { email, password, feedItemId } = await seedArticleData(
    SELF_HOSTED_TURSO_PORT,
    SELF_HOSTED_APP_PORT,
  );

  try {
    await emulateMobileBrowserControls(page);
    await signIn({ page, email, password });
    await page.goto(`/read/${feedItemId}`);
    await expect(page.getByText("Paragraph 20:")).toBeVisible();
    await expect(page.getByText(/This is a demo instance/i)).toHaveCount(0);
    await expectPrimaryMobileScrolling(page);
  } finally {
    await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
  }
});
