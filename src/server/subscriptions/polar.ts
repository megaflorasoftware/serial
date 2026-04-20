import { Polar } from "@polar-sh/sdk";
import { IS_MAIN_INSTANCE } from "~/lib/constants";
import { env } from "~/env";

function hasAllPolarCredentials(): boolean {
  return !!(
    env.POLAR_ACCESS_TOKEN &&
    env.POLAR_WEBHOOK_SECRET &&
    env.POLAR_STANDARD_SMALL_QUOTA_MONTHLY_PRODUCT_ID &&
    env.POLAR_STANDARD_SMALL_QUOTA_ANNUAL_PRODUCT_ID &&
    env.POLAR_STANDARD_MEDIUM_QUOTA_MONTHLY_PRODUCT_ID &&
    env.POLAR_STANDARD_MEDIUM_QUOTA_ANNUAL_PRODUCT_ID &&
    env.POLAR_STANDARD_LARGE_QUOTA_MONTHLY_PRODUCT_ID &&
    env.POLAR_STANDARD_LARGE_QUOTA_ANNUAL_PRODUCT_ID &&
    env.POLAR_PRO_MONTHLY_PRODUCT_ID &&
    env.POLAR_PRO_ANNUAL_PRODUCT_ID
  );
}

export const polarClient =
  IS_MAIN_INSTANCE && hasAllPolarCredentials()
    ? new Polar({
        accessToken: env.POLAR_ACCESS_TOKEN!,
        server: env.NODE_ENV === "production" ? "production" : "sandbox",
      })
    : null;

/** True only when running as the main instance with all Polar credentials configured. */
export const IS_BILLING_ENABLED = polarClient !== null;
