import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckIcon,
  SproutIcon,
  TreeDeciduousIcon,
  TreesIcon,
} from "lucide-react";
import {
  QUOTA_DISPLAY_NAMES,
  STANDARD_PLAN_IDS,
} from "~/components/feed/subscription-dialog/constants";
import {
  formatPrice,
  getPlanFeatures,
} from "~/components/feed/subscription-dialog/utils";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { BASE_SIGNED_OUT_URL, IS_MAIN_INSTANCE } from "~/lib/constants";
import { AUTH_PAGE_URL } from "~/server/auth/constants";
import { fetchProductsServerFn } from "~/server/subscriptions/fetchProducts";
import { PLANS } from "~/server/subscriptions/plans";

export const Route = createFileRoute("/pricing")({
  beforeLoad: () => {
    if (!IS_MAIN_INSTANCE) {
      throw redirect({ to: BASE_SIGNED_OUT_URL });
    }
  },
  component: RouteComponent,
  loader: async () => {
    const products = await fetchProductsServerFn();
    return { products };
  },
  staleTime: 1000 * 60 * 60,
});

function RouteComponent() {
  const { products } = Route.useLoaderData();
  const supportEmail = import.meta.env.VITE_PUBLIC_SUPPORT_EMAIL_ADDRESS;

  return (
    <main className="bg-background p-4 text-pretty md:p-8">
      <div className="flex items-center justify-center pt-4 pb-4 md:pt-8 md:pb-8">
        <Link to="/welcome">
          <Button variant="outline" size="lg" className="gap-2">
            <ArrowLeftIcon size={16} /> Back to Home
          </Button>
        </Link>
      </div>
      <div className="relative overflow-clip pb-4 md:pb-8">
        <section className="mx-auto max-w-2xl px-6 pt-16 text-center">
          <img
            src="/icon-256.png"
            className="mx-auto size-16 rounded-xl shadow-lg md:size-20"
            alt="Serial logo"
          />
          <h1 className="mt-6 text-3xl font-bold text-balance md:mt-8 md:text-4xl">
            Pricing
          </h1>
          <p className="mt-3 mb-6 text-lg text-pretty md:text-xl">
            All prices are fee and taxes included – what you see is what you
            pay. This pricing is for the main, hosted instance of Serial.
          </p>
        </section>
      </div>

      <section className="relative mx-auto max-w-7xl px-6">
        <div className="flex flex-col gap-6 lg:flex-row">
          <Card className="flex-2 p-6">
            <div className="flex items-center gap-2">
              <SproutIcon size={20} />
              <h3 className="text-xl font-bold">{PLANS.free.name}</h3>
            </div>
            <ul className="space-y-2">
              {getPlanFeatures(PLANS.free).map((feature) => (
                <li key={feature} className="flex items-center gap-2">
                  <CheckIcon size={16} />
                  {feature}
                </li>
              ))}
            </ul>
          </Card>

          <Card className="flex-3 p-6">
            <div className="flex items-center gap-2">
              <TreeDeciduousIcon size={20} />
              <h3 className="text-xl font-bold">Standard</h3>
            </div>
            <ul className="space-y-2">
              {getPlanFeatures(PLANS["standard-small"])
                .filter((f) => !f.startsWith("Up to"))
                .map((feature) => (
                  <li key={feature} className="flex items-center gap-2">
                    <CheckIcon size={16} />
                    {feature}
                  </li>
                ))}
            </ul>
            <div className="space-y-4">
              {STANDARD_PLAN_IDS.map((id) => {
                const plan = PLANS[id];
                const product = products.find((p) => p.planId === id);
                return (
                  <div key={id} className="rounded border p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-bold">
                        {QUOTA_DISPLAY_NAMES[id]}
                      </span>
                      <span className="text-md font-bold">
                        {product?.monthlyPrice != null &&
                          `${formatPrice(product.monthlyPrice)}/mo`}
                        {product?.monthlyPrice != null &&
                          product?.annualPrice != null &&
                          " · "}
                        {product?.annualPrice != null &&
                          `${formatPrice(product.annualPrice)}/yr`}
                      </span>
                    </div>
                    <p className="text-muted-foreground text-sm">
                      Up to {plan.maxActiveFeeds.toLocaleString()} active feeds
                    </p>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="flex-2 p-6">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <TreesIcon size={20} />
                <h3 className="text-xl font-bold">{PLANS.pro.name}</h3>
              </div>
              <div className="text-md font-bold lg:text-lg">
                {(() => {
                  const product = products.find((p) => p.planId === "pro");
                  if (!product) return null;
                  return (
                    <>
                      {product.monthlyPrice != null &&
                        `${formatPrice(product.monthlyPrice)}/mo`}
                      {product.monthlyPrice != null &&
                        product.annualPrice != null &&
                        " · "}
                      {product.annualPrice != null &&
                        `${formatPrice(product.annualPrice)}/yr`}
                    </>
                  );
                })()}
              </div>
            </div>
            <ul className="space-y-2">
              {getPlanFeatures(PLANS.pro).map((feature) => (
                <li key={feature} className="flex items-center gap-2">
                  <CheckIcon size={16} />
                  {feature}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </section>

      <section className="mx-auto max-w-xl space-y-6 px-6 py-12 text-xl text-pretty md:py-24">
        <p>
          If the cost of Serial is too much for you, anyone can run an instance
          of Serial for themselves. You won&apos;t need to pay us anything, but
          you will need to have a dedicated computer to run it on, which can be
          as cheap as $3-4 a month.
        </p>
        <p>
          This can be a great option for users who are very privacy-conscious,
          or for those looking to provide Serial as a service for their friends
          or family.
        </p>
        <p>
          <a
            className="underline"
            href="https://github.com/megaflorasoftware/serial?tab=readme-ov-file#self-hosting"
          >
            Here is the step-by-step guide
          </a>{" "}
          on how to host your own Serial instance.
        </p>
      </section>
      <div className="border-foreground mx-auto max-w-4xl border-4 border-x-0 border-dashed px-6 py-16 md:border-x-4">
        <section className="relative mx-auto max-w-xl space-y-6 text-center text-2xl text-pretty md:py-16 md:text-3xl">
          <p>Ready to take back control of your content?</p>
          <div className="space-x-2">
            <Link to={AUTH_PAGE_URL}>
              <Button size="lg" className="text-base">
                Get Started
              </Button>
            </Link>
            <a
              href="https://github.com/megaflorasoftware/serial"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button size="lg" className="text-base" variant="outline">
                GitHub
              </Button>
            </a>
          </div>
        </section>
      </div>
      {supportEmail && (
        <section className="space-y-2 px-6 py-16 text-center">
          <p className="text-lg">
            Have a question? Reach us at{" "}
            <a href={`mailto:${supportEmail}`} className="underline">
              {supportEmail}
            </a>
          </p>
        </section>
      )}
    </main>
  );
}
