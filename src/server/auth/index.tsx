import { render } from "@react-email/components";
import sendgrid from "@sendgrid/mail";
import { betterAuth } from "better-auth";
import { admin, emailOTP, genericOAuth } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { redirect } from "@tanstack/react-router";
import { and, asc, count, eq } from "drizzle-orm";
import { checkout, polar, portal, webhooks } from "@polar-sh/better-auth";
import { db } from "../db";
import { appConfig, feeds, user } from "../db/schema";
import { determinePlanFromProductId, PLANS } from "../subscriptions/plans";
import {
  deactivateExcessFeeds,
  invalidatePlanCache,
} from "../subscriptions/helpers";
import { polarClient } from "../subscriptions/polar";
import ResetPasswordEmail from "~/emails/reset-password";
import VerifyEmailEmail from "~/emails/verify-email";
import {
  BASE_SIGNED_OUT_URL,
  getEnabledAuthProviders,
  isOAuthConfigured,
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

async function handleSubscriptionEnd(payload: {
  data: { customer?: { externalId?: string | null } | null };
}) {
  const externalId = payload.data.customer?.externalId;
  if (!externalId) return;

  invalidatePlanCache(externalId);
  await deactivateExcessFeeds(db, externalId, PLANS.free.maxActiveFeeds);
  await db
    .update(feeds)
    .set({ nextFetchAt: null })
    .where(eq(feeds.userId, externalId));
}

function buildPolarPlugin() {
  if (!polarClient) return [];
  if (!process.env.POLAR_WEBHOOK_SECRET) return [];

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

            invalidatePlanCache(externalId);

            const productId = payload.data.productId;
            const planId = determinePlanFromProductId(productId);
            if (!planId) {
              console.warn(`[polar webhook] Unknown product ID: ${productId}`);
              return;
            }

            const config = PLANS[planId];
            if (config.backgroundRefreshIntervalMs) {
              // Stagger nextFetchAt across the refresh interval so feeds
              // don't all become due at the same instant (thundering herd).
              const activeFeeds = await db
                .select({ id: feeds.id })
                .from(feeds)
                .where(
                  and(eq(feeds.userId, externalId), eq(feeds.isActive, true)),
                )
                .all();

              const interval = config.backgroundRefreshIntervalMs;
              const feedCount = activeFeeds.length;
              for (let i = 0; i < feedCount; i++) {
                const offset =
                  feedCount > 1 ? Math.round((interval / feedCount) * i) : 0;
                await db
                  .update(feeds)
                  .set({ nextFetchAt: new Date(Date.now() + offset) })
                  .where(eq(feeds.id, activeFeeds[i]!.id));
              }
            }
          },
          onSubscriptionCanceled: async (payload) => {
            await handleSubscriptionEnd(payload);
          },
          onSubscriptionRevoked: async (payload) => {
            await handleSubscriptionEnd(payload);
          },
        }),
      ],
    }),
  ];
}

function buildGenericOAuthPlugin() {
  if (!isOAuthConfigured()) return [];

  return [
    genericOAuth({
      config: [
        {
          providerId: process.env.OAUTH_PROVIDER_ID!,
          clientId: process.env.OAUTH_CLIENT_ID!,
          clientSecret: process.env.OAUTH_CLIENT_SECRET!,
          discoveryUrl: process.env.OAUTH_DISCOVERY_URL,
          authorizationUrl: process.env.OAUTH_AUTHORIZATION_URL,
          tokenUrl: process.env.OAUTH_TOKEN_URL,
          userInfoUrl: process.env.OAUTH_USER_INFO_URL,
          scopes: (process.env.OAUTH_SCOPES ?? "openid email profile").split(
            " ",
          ),
          pkce: process.env.OAUTH_PKCE === "true",
        },
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
  plugins: [
    admin(),
    tanstackStartCookies(),
    ...buildPolarPlugin(),
    ...buildGenericOAuthPlugin(),
    ...(import.meta.env.SENDGRID_API_KEY
      ? [
          emailOTP({
            async sendVerificationOTP({ email, otp, type }) {
              if (type === "email-verification") {
                sendgrid.setApiKey(import.meta.env.SENDGRID_API_KEY ?? "");
                const html = await render(<VerifyEmailEmail otp={otp} />);
                await sendgrid.send({
                  from: "hey@serial.tube",
                  to: email,
                  subject: "Verify your email for Serial",
                  html,
                });
              }
            },
            sendVerificationOnSignUp: true,
          }),
        ]
      : []),
  ],

  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      const isEmailSignUp = ctx.path.startsWith("/sign-up");
      const isEmailSignIn = ctx.path.startsWith("/sign-in/email");
      const isOAuth =
        ctx.path.startsWith("/sign-in/oauth2") ||
        ctx.path.startsWith("/oauth2/callback/");

      if (!isEmailSignUp && !isEmailSignIn && !isOAuth) return;

      // Allow first user to use any available method
      const userCount = await db.select({ count: count() }).from(user).get();
      if ((userCount?.count ?? 0) === 0) return;

      const configs = await db.select().from(appConfig).all();
      const signinConfig = configs.find(
        (c) => c.key === "enabled-signin-providers",
      );
      const signupConfig = configs.find(
        (c) => c.key === "enabled-signup-providers",
      );
      const publicSignupConfig = configs.find(
        (c) => c.key === "public-signup-enabled",
      );
      const signinProviders = getEnabledAuthProviders(signinConfig?.value);
      const signupProviders = getEnabledAuthProviders(signupConfig?.value);

      // Sign-in gating
      if (isEmailSignIn && !signinProviders.includes("email")) {
        throw new APIError("BAD_REQUEST", {
          message: "Email sign in is currently disabled",
        });
      }

      if (isOAuth && !signinProviders.includes("oauth")) {
        throw new APIError("BAD_REQUEST", {
          message: "OAuth is currently disabled",
        });
      }

      // Sign-up gating
      if (isEmailSignUp) {
        if (
          !isPublicSignupEnabled(publicSignupConfig?.value) ||
          !signupProviders.includes("email")
        ) {
          throw new APIError("BAD_REQUEST", {
            message: "Sign ups are currently disabled",
          });
        }
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      // After successful sign-up (email or OAuth), check if this is the first user
      const isSignUp =
        ctx.path.startsWith("/sign-up") ||
        ctx.path.startsWith("/oauth2/callback/");
      if (isSignUp && ctx.context?.newSession?.user?.id) {
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

          // Set sign-in and sign-up methods to match how the first user signed up
          const method: string = ctx.path.startsWith("/sign-up")
            ? "email"
            : "oauth";
          const providers = JSON.stringify([method]);
          await db
            .insert(appConfig)
            .values({
              key: "enabled-signin-providers",
              value: providers,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: appConfig.key,
              set: { value: providers, updatedAt: new Date() },
            });
          await db
            .insert(appConfig)
            .values({
              key: "enabled-signup-providers",
              value: providers,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: appConfig.key,
              set: { value: providers, updatedAt: new Date() },
            });
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
