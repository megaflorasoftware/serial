import { render } from "@react-email/components";
import sendgrid from "@sendgrid/mail";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { redirect } from "@tanstack/react-router";
import { asc, count, eq } from "drizzle-orm";
import { Polar } from "@polar-sh/sdk";
import { checkout, polar, portal, webhooks } from "@polar-sh/better-auth";
import { db } from "../db";
import { appConfig, feeds, user } from "../db/schema";
import { determinePlanFromProductId, PLANS } from "../subscriptions/plans";
import { deactivateExcessFeeds } from "../subscriptions/helpers";
import ResetPasswordEmail from "~/emails/reset-password";
import {
  BASE_SIGNED_OUT_URL,
  IS_MAIN_INSTANCE,
  isPublicSignupEnabled,
} from "~/lib/constants";

export const authMiddleware = createMiddleware().server(
  async ({ pathname, next }) => {
    const headers = getRequestHeaders() as Headers;
    const session = await auth.api.getSession({ headers });
    if (!session) {
      if (!pathname.includes("auth")) {
        throw redirect({ to: BASE_SIGNED_OUT_URL });
      }
    }
    return await next();
  },
);

export const adminMiddleware = createMiddleware().server(async ({ next }) => {
  const headers = getRequestHeaders() as Headers;
  const session = await auth.api.getSession({ headers });

  if (session?.user.role !== "admin") {
    throw redirect({ to: "/" });
  }

  return await next();
});

const polarClient = IS_MAIN_INSTANCE
  ? new Polar({
      accessToken: process.env.POLAR_ACCESS_TOKEN ?? "",
      server: process.env.NODE_ENV === "production" ? "production" : "sandbox",
    })
  : null;

function buildPolarPlugin() {
  if (!polarClient) return [];

  const products = [
    process.env.POLAR_STANDARD_MONTHLY_PRODUCT_ID
      ? {
          productId: process.env.POLAR_STANDARD_MONTHLY_PRODUCT_ID,
          slug: "standard-monthly",
        }
      : null,
    process.env.POLAR_STANDARD_ANNUAL_PRODUCT_ID
      ? {
          productId: process.env.POLAR_STANDARD_ANNUAL_PRODUCT_ID,
          slug: "standard-annual",
        }
      : null,
    process.env.POLAR_PRO_MONTHLY_PRODUCT_ID
      ? {
          productId: process.env.POLAR_PRO_MONTHLY_PRODUCT_ID,
          slug: "pro-monthly",
        }
      : null,
    process.env.POLAR_PRO_ANNUAL_PRODUCT_ID
      ? {
          productId: process.env.POLAR_PRO_ANNUAL_PRODUCT_ID,
          slug: "pro-annual",
        }
      : null,
  ].filter(Boolean);

  return [
    polar({
      client: polarClient,
      createCustomerOnSignUp: false,
      use: [
        checkout({
          products,
          successUrl: "/?checkout_success=true",
          authenticatedUsersOnly: true,
        }),
        portal(),
        webhooks({
          secret: process.env.POLAR_WEBHOOK_SECRET ?? "",
          onSubscriptionActive: async (payload) => {
            const externalId = payload.data.customer?.externalId;
            if (!externalId) return;

            const productId = payload.data.productId;
            const planId = determinePlanFromProductId(productId);
            if (!planId) return;

            const config = PLANS[planId];
            if (config.backgroundRefreshIntervalMs) {
              const nextFetchAt = new Date(
                Date.now() + config.backgroundRefreshIntervalMs,
              );
              await db
                .update(feeds)
                .set({ nextFetchAt })
                .where(eq(feeds.userId, externalId));
            }
          },
          onSubscriptionCanceled: async (payload) => {
            const externalId = payload.data.customer?.externalId;
            if (!externalId) return;

            await deactivateExcessFeeds(
              db,
              externalId,
              PLANS.free.maxActiveFeeds,
            );
            await db
              .update(feeds)
              .set({ nextFetchAt: null })
              .where(eq(feeds.userId, externalId));
          },
          onSubscriptionRevoked: async (payload) => {
            const externalId = payload.data.customer?.externalId;
            if (!externalId) return;

            await deactivateExcessFeeds(
              db,
              externalId,
              PLANS.free.maxActiveFeeds,
            );
            await db
              .update(feeds)
              .set({ nextFetchAt: null })
              .where(eq(feeds.userId, externalId));
          },
        }),
      ],
    }),
  ];
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
  }),
  emailAndPassword: {
    enabled: true,
    maxPasswordLength: 64,
    async sendResetPassword(data) {
      sendgrid.setApiKey(import.meta.env.SENDGRID_API_KEY ?? "");

      const forgotPasswordEmailHtml = await render(
        <ResetPasswordEmail resetUrl={data.url} />,
      );

      const options = {
        from: "hey@serial.tube",
        to: data.user.email,
        subject: "Reset your password for Serial",
        html: forgotPasswordEmailHtml,
      };

      await sendgrid.send(options);
    },
  },
  plugins: [admin(), tanstackStartCookies(), ...buildPolarPlugin()],

  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // Block sign-up endpoints if public signups are disabled
      if (ctx.path.startsWith("/sign-up")) {
        const config = await db
          .select()
          .from(appConfig)
          .where(eq(appConfig.key, "public-signup-enabled"))
          .get();

        if (!isPublicSignupEnabled(config?.value)) {
          // Allow signup if no users exist (first user scenario)
          const userCount = await db
            .select({ count: count() })
            .from(user)
            .get();
          if ((userCount?.count ?? 0) > 0) {
            throw new APIError("BAD_REQUEST", {
              message: "Sign ups are currently disabled",
            });
          }
        }
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      // After successful sign-up, check if this is the first user
      if (
        ctx.path.startsWith("/sign-up") &&
        ctx.context?.newSession?.user?.id
      ) {
        const userId = ctx.context.newSession.user.id;

        // Check if this user is the first user by creation time
        const firstUser = await db
          .select({ id: user.id })
          .from(user)
          .orderBy(asc(user.createdAt))
          .limit(1)
          .get();

        if (firstUser?.id === userId) {
          await db
            .update(user)
            .set({ role: "admin" })
            .where(eq(user.id, userId));
        }
      }
    }),
  },

  /** if no database is provided, the user data will be stored in memory.
   * Make sure to provide a database to persist user data **/
});

export async function getServerAuth(headers: Headers) {
  return await auth.api.getSession({
    headers,
  });
}

export async function isServerAuthed(headers: Headers) {
  const authResult = await auth.api.getSession({
    headers,
  });

  return !!authResult?.session.id && !!authResult.user.id;
}
