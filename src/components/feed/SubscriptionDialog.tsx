"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CheckIcon,
  SproutIcon,
  TreeDeciduousIcon,
  TreesIcon,
} from "lucide-react";
import { toast } from "sonner";
import type { PlanConfig } from "~/server/subscriptions/plans";
import { PLAN_IDS, PLANS } from "~/server/subscriptions/plans";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ControlledResponsiveDialog } from "~/components/ui/responsive-dropdown";
import { Skeleton } from "~/components/ui/skeleton";
import { useSubscription } from "~/lib/data/subscription";
import { orpc } from "~/lib/orpc";
import { authClient, useSession } from "~/lib/auth-client";

export const PLAN_ICONS = {
  free: SproutIcon,
  standard: TreeDeciduousIcon,
  pro: TreesIcon,
} as const;

function formatPrice(cents: number): string {
  const dollars = cents / 100;
  return cents % 100 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

export function getPlanFeatures(plan: PlanConfig): string[] {
  const features: string[] = [];
  features.push(`Up to ${plan.maxActiveFeeds.toLocaleString()} active feeds`);

  if (plan.id === "free") {
    features.push("Refresh up to once an hour");
    features.push("Manual refresh only");
  } else {
    features.push(
      plan.id === "pro"
        ? "Refreshes once every 5 min"
        : "Refreshes once every 15 min",
    );
    features.push("Refresh in background");
  }

  return features;
}

function EmailVerificationBanner({ onVerified }: { onVerified: () => void }) {
  const { data: session } = useSession();
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const email = session?.user?.email;

  async function handleSendOtp() {
    if (!email) return;
    setSending(true);
    try {
      await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "email-verification",
      });
      setOtpSent(true);
      toast.success("Verification code sent to your email");
    } catch {
      toast.error("Failed to send verification code");
    } finally {
      setSending(false);
    }
  }

  async function handleVerify() {
    if (!email || !otp) return;
    setVerifying(true);
    try {
      await authClient.emailOtp.verifyEmail({
        email,
        otp,
      });
      toast.success("Email verified!");
      onVerified();
    } catch {
      toast.error("Invalid verification code");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-3">
      <p className="text-sm font-medium">Verify your email to subscribe</p>
      <p className="text-muted-foreground mt-1 text-xs">
        You need to verify your email address before upgrading your plan.
      </p>
      {!otpSent ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          disabled={sending}
          onClick={handleSendOtp}
        >
          {sending ? "Sending..." : "Send verification code"}
        </Button>
      ) : (
        <div className="mt-2 flex gap-2">
          <Input
            type="text"
            inputMode="numeric"
            placeholder="Enter code"
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
            className="h-8 w-32"
          />
          <Button
            size="sm"
            disabled={verifying || otp.length === 0}
            onClick={handleVerify}
          >
            {verifying ? "Verifying..." : "Verify"}
          </Button>
        </div>
      )}
    </div>
  );
}

export function SubscriptionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { planId } = useSubscription();
  const { data: session, refetch: refetchSession } = useSession();
  const [showVerification, setShowVerification] = useState(false);
  const [pendingPlanId, setPendingPlanId] = useState<"standard" | "pro" | null>(
    null,
  );

  const emailVerified = session?.user?.emailVerified ?? false;

  const { data: products, isLoading: isLoadingProducts } = useQuery({
    ...orpc.subscription.getProducts.queryOptions(),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });

  const checkoutMutation = useMutation(
    orpc.subscription.createCheckout.mutationOptions({
      onSuccess: (result) => {
        if (result.error === "email-not-verified") {
          setShowVerification(true);
          toast.error("Please verify your email before subscribing");
          return;
        }
        if (result.url) {
          window.location.assign(result.url);
        }
      },
    }),
  );

  const portalMutation = useMutation(
    orpc.subscription.createPortalSession.mutationOptions({
      onSuccess: (result) => {
        if (result.url) {
          window.location.assign(result.url);
        }
      },
    }),
  );

  const isSubscribed = planId !== "free";

  function handleSubscribeClick(id: "standard" | "pro") {
    setPendingPlanId(id);
    checkoutMutation.mutate({ planId: id });
  }

  async function handleVerified() {
    await refetchSession();
    setShowVerification(false);
    if (pendingPlanId) {
      checkoutMutation.mutate({ planId: pendingPlanId });
    }
  }

  return (
    <ControlledResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Subscription"
      description="Choose a plan that fits your needs."
      className="lg:max-w-4xl"
      headerClassName="lg:text-center"
    >
      <div className="mt-2 grid gap-3 lg:grid-cols-3">
        {showVerification && !emailVerified && (
          <div className="lg:col-span-3">
            <EmailVerificationBanner onVerified={handleVerified} />
          </div>
        )}
        {PLAN_IDS.map((id) => {
          const plan = PLANS[id];
          const isCurrent = id === planId;
          const isPaid = id !== "free";
          const product = products?.find((p) => p.planId === id);
          const monthlyPrice = product?.monthlyPrice ?? null;
          const annualPrice = product?.annualPrice ?? null;
          const hasPrice = monthlyPrice != null || annualPrice != null;
          const features = getPlanFeatures(plan);

          return (
            <div
              key={id}
              className={`relative rounded-lg border p-4 ${
                isCurrent ? "border-primary bg-primary/5" : "border-border"
              }`}
            >
              {isCurrent && (
                <span className="bg-foreground text-background absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-0.5 text-xs font-medium">
                  Current
                </span>
              )}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {(() => {
                    const Icon = PLAN_ICONS[id];
                    return <Icon size={20} className="shrink-0" />;
                  })()}
                  <h3 className="font-medium">{plan.name}</h3>
                </div>
                {isPaid && isLoadingProducts ? (
                  <Skeleton className="h-4 w-28" />
                ) : hasPrice ? (
                  <p className="text-muted-foreground text-base">
                    {monthlyPrice != null && `${formatPrice(monthlyPrice)}/mo`}
                    {monthlyPrice != null && annualPrice != null && " · "}
                    {annualPrice != null && `${formatPrice(annualPrice)}/yr`}
                  </p>
                ) : null}
              </div>
              <ul className="mt-2 space-y-1">
                {features.map((feature) => (
                  <li
                    key={feature}
                    className="text-muted-foreground flex items-center gap-2 text-sm"
                  >
                    <CheckIcon size={12} />
                    {feature}
                  </li>
                ))}
              </ul>
              {isCurrent && isSubscribed && (
                <div className="mt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled={portalMutation.isPending}
                    onClick={() => portalMutation.mutate({})}
                  >
                    Manage
                  </Button>
                </div>
              )}
              {!isCurrent && id !== "free" && (
                <div className="mt-3">
                  <Button
                    size="sm"
                    className="w-full"
                    disabled={checkoutMutation.isPending}
                    onClick={() => handleSubscribeClick(id)}
                  >
                    Subscribe
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-muted-foreground pt-5 text-base lg:text-center">
        Price too high?{" "}
        <a
          href="https://github.com/hfellerhoff/serial?tab=readme-ov-file#self-hosting"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          Learn how to self-host Serial
        </a>
      </p>
    </ControlledResponsiveDialog>
  );
}
