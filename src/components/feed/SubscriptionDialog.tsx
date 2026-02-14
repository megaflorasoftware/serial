"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckIcon } from "lucide-react";
import { useState } from "react";
import type { PlanId } from "~/server/subscriptions/plans";
import { Button } from "~/components/ui/button";
import { ControlledResponsiveDialog } from "~/components/ui/responsive-dropdown";
import { authClient } from "~/lib/auth-client";
import { useSubscription } from "~/lib/data/subscription";
import { orpc } from "~/lib/orpc";

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const PLAN_FEATURES: Record<PlanId, string[]> = {
  free: ["Up to 100 active feeds", "Manual refresh only"],
  standard: [
    "Up to 500 active feeds",
    "Background refresh every 60 min",
    "Priority support",
  ],
  pro: [
    "Up to 2,500 active feeds",
    "Background refresh every 5 min",
    "Priority support",
  ],
};

export function SubscriptionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { planId } = useSubscription();
  const [billingInterval, setBillingInterval] = useState<"monthly" | "annual">(
    "monthly",
  );

  const { data: products } = useQuery({
    ...orpc.subscription.getProducts.queryOptions(),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });

  const handleCheckout = async (slug: string) => {
    try {
      const result = await (authClient as any).checkout({ slug });
      if (result?.data?.url) {
        window.location.assign(result.data.url);
      }
    } catch {
      // Checkout failed
    }
  };

  const handleManage = async () => {
    try {
      const result = await (authClient as any).customer.portal();
      if (result?.data?.url) {
        window.location.assign(result.data.url);
      }
    } catch {
      // Portal failed
    }
  };

  const allPlans: Array<{
    id: PlanId;
    name: string;
    features: string[];
    monthlyPrice: number | null;
    annualPrice: number | null;
    monthlySlug: string | null;
    annualSlug: string | null;
  }> = [
    {
      id: "free",
      name: "Free",
      features: PLAN_FEATURES.free,
      monthlyPrice: null,
      annualPrice: null,
      monthlySlug: null,
      annualSlug: null,
    },
    {
      id: "standard",
      name: "Standard",
      features: PLAN_FEATURES.standard,
      monthlyPrice:
        products?.find((p) => p.planId === "standard")?.monthlyPrice ?? null,
      annualPrice:
        products?.find((p) => p.planId === "standard")?.annualPrice ?? null,
      monthlySlug: "standard-monthly",
      annualSlug: "standard-annual",
    },
    {
      id: "pro",
      name: "Pro",
      features: PLAN_FEATURES.pro,
      monthlyPrice:
        products?.find((p) => p.planId === "pro")?.monthlyPrice ?? null,
      annualPrice:
        products?.find((p) => p.planId === "pro")?.annualPrice ?? null,
      monthlySlug: "pro-monthly",
      annualSlug: "pro-annual",
    },
  ];

  const isSubscribed = planId !== "free";

  return (
    <ControlledResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Subscription"
      description="Choose a plan that fits your needs."
    >
      <div className="grid gap-4">
        <div className="flex justify-center gap-2">
          <Button
            variant={billingInterval === "monthly" ? "default" : "outline"}
            size="sm"
            onClick={() => setBillingInterval("monthly")}
          >
            Monthly
          </Button>
          <Button
            variant={billingInterval === "annual" ? "default" : "outline"}
            size="sm"
            onClick={() => setBillingInterval("annual")}
          >
            Annual
          </Button>
        </div>

        <div className="grid gap-3">
          {allPlans.map((plan) => {
            const isCurrent = plan.id === planId;
            const price =
              billingInterval === "monthly"
                ? plan.monthlyPrice
                : plan.annualPrice;
            const slug =
              billingInterval === "monthly"
                ? plan.monthlySlug
                : plan.annualSlug;

            return (
              <div
                key={plan.id}
                className={`rounded-lg border p-4 ${
                  isCurrent ? "border-primary bg-primary/5" : "border-border"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-medium">
                      {plan.name}
                      {isCurrent && (
                        <span className="text-muted-foreground ml-2 text-xs">
                          Current
                        </span>
                      )}
                    </h3>
                    {price != null ? (
                      <p className="text-muted-foreground text-sm">
                        {formatPrice(price)}/
                        {billingInterval === "monthly" ? "mo" : "yr"}
                      </p>
                    ) : (
                      <p className="text-muted-foreground text-sm">Free</p>
                    )}
                  </div>
                  {isCurrent && isSubscribed ? (
                    <Button variant="outline" size="sm" onClick={handleManage}>
                      Manage
                    </Button>
                  ) : !isCurrent && slug ? (
                    <Button size="sm" onClick={() => handleCheckout(slug)}>
                      Subscribe
                    </Button>
                  ) : null}
                </div>
                <ul className="mt-2 space-y-1">
                  {plan.features.map((feature) => (
                    <li
                      key={feature}
                      className="text-muted-foreground flex items-center gap-2 text-xs"
                    >
                      <CheckIcon size={12} />
                      {feature}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </ControlledResponsiveDialog>
  );
}
