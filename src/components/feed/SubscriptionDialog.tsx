"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  CrownIcon,
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
import { usePlanSuccessStore } from "~/lib/data/plan-success";
import { useSubscription } from "~/lib/data/subscription";
import { orpc } from "~/lib/orpc";
import { authClient, useSession } from "~/lib/auth-client";
import { env } from "~/env";

export const PLAN_ICONS = {
  free: SproutIcon,
  standard: TreeDeciduousIcon,
  daily: TreesIcon,
  pro: CrownIcon,
} as const;

function formatPrice(cents: number): string {
  const dollars = cents / 100;
  return cents % 100 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

export function getPlanFeatures(plan: PlanConfig): string[] {
  const features: string[] = [];

  if (plan.maxActiveFeeds === Infinity) {
    features.push("Unlimited active feeds");
  } else {
    features.push(`Up to ${plan.maxActiveFeeds.toLocaleString()} active feeds`);
  }

  if (plan.id === "free") {
    features.push("Refresh up to once an hour");
    features.push("Manual refresh only");
  } else if (plan.id === "standard") {
    features.push("Refreshes once every 15 min");
    features.push("Refresh in background");
  } else if (plan.id === "daily") {
    features.push("Refreshes once every 5 min");
    features.push("Refresh in background");
  } else if (plan.id === "pro") {
    features.push("Refreshes every minute");
    features.push("Refresh in background");
    features.push("Priority support");
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

type SwitchPreview = {
  currentPlanId: string;
  currentPlanName: string;
  currentAmount: number;
  newPlanId: string;
  newPlanName: string;
  newAmount: number;
  proratedAmount: number;
  currency: string;
  billingInterval: "month" | "year";
  subscriptionId: string;
  newProductId: string;
};

function PlanSwitchConfirmation({
  preview,
  onBack,
  onConfirm,
  isPending,
}: {
  preview: SwitchPreview;
  onBack: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  const newPlan = PLANS[preview.newPlanId as keyof typeof PLANS];
  const features = getPlanFeatures(newPlan);
  const Icon = PLAN_ICONS[preview.newPlanId as keyof typeof PLAN_ICONS];
  const intervalLabel = preview.billingInterval === "month" ? "mo" : "yr";

  return (
    <ControlledResponsiveDialog
      open
      onOpenChange={() => onBack()}
      title="Switch Plan"
      description={`Switch from ${preview.currentPlanName} to ${preview.newPlanName}`}
      onBack={onBack}
      footer={
        <Button className="w-full" onClick={onConfirm} disabled={isPending}>
          {isPending
            ? "Switching..."
            : `Confirm Switch to ${preview.newPlanName}`}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-lg border p-4">
          <Icon size={20} className="shrink-0" />
          <div className="flex-1">
            <h3 className="font-medium">{preview.newPlanName} Plan</h3>
            <p className="text-muted-foreground text-sm">
              {formatPrice(preview.newAmount)}/{intervalLabel}
            </p>
          </div>
        </div>
        <ul className="space-y-2">
          {features.map((feature) => (
            <li
              key={feature}
              className="text-muted-foreground flex items-center gap-2 text-sm"
            >
              <CheckIcon size={14} className="shrink-0" />
              {feature}
            </li>
          ))}
        </ul>
        {preview.proratedAmount > 0 && (
          <div className="rounded-lg border p-4">
            <p className="text-sm">
              <span className="text-muted-foreground">
                Due today (prorated):
              </span>{" "}
              <span className="font-medium">
                {formatPrice(preview.proratedAmount)}
              </span>
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              You&apos;ll be credited for the unused time on your current plan.
            </p>
          </div>
        )}
      </div>
    </ControlledResponsiveDialog>
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
  const queryClient = useQueryClient();
  const [showVerification, setShowVerification] = useState(false);
  const [pendingPlanId, setPendingPlanId] = useState<
    "standard" | "daily" | "pro" | null
  >(null);
  const [switchPreview, setSwitchPreview] = useState<SwitchPreview | null>(
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

  const previewMutation = useMutation(
    orpc.subscription.previewPlanSwitch.mutationOptions({
      onSuccess: (result) => {
        if (result) {
          setSwitchPreview(result);
        } else {
          toast.error("Unable to preview plan switch");
        }
      },
    }),
  );

  const openPlanSuccess = usePlanSuccessStore((s) => s.openDialog);

  const switchMutation = useMutation(
    orpc.subscription.switchPlan.mutationOptions({
      onSuccess: (result) => {
        if (result.success) {
          setSwitchPreview(null);
          onOpenChange(false);
          // Invalidate and then show success dialog
          void queryClient
            .invalidateQueries({
              queryKey: orpc.subscription.getStatus.queryOptions().queryKey,
            })
            .then(() => {
              openPlanSuccess();
            });
        }
      },
      onError: () => {
        toast.error("Failed to switch plan. Please try again.");
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

  // Only show paid plans that have products configured (or are the user's current plan)
  const visiblePlanIds = PLAN_IDS.filter((id) => {
    if (id === "free") return true;
    if (id === planId) return true;
    if (isLoadingProducts) return true;
    return products?.some((p) => p.planId === id);
  });

  function handleSubscribeClick(id: "standard" | "daily" | "pro") {
    setPendingPlanId(id);
    if (isSubscribed) {
      // Already subscribed — show switch confirmation
      previewMutation.mutate({ planId: id });
    } else {
      checkoutMutation.mutate({
        planId: id,
        returnPath: window.location.pathname,
      });
    }
  }

  async function handleVerified() {
    await refetchSession();
    setShowVerification(false);
    if (pendingPlanId) {
      if (isSubscribed) {
        previewMutation.mutate({ planId: pendingPlanId });
      } else {
        checkoutMutation.mutate({
          planId: pendingPlanId,
          returnPath: window.location.pathname,
        });
      }
    }
  }

  if (switchPreview) {
    return (
      <PlanSwitchConfirmation
        preview={switchPreview}
        onBack={() => setSwitchPreview(null)}
        onConfirm={() =>
          switchMutation.mutate({
            subscriptionId: switchPreview.subscriptionId,
            newProductId: switchPreview.newProductId,
          })
        }
        isPending={switchMutation.isPending}
      />
    );
  }

  return (
    <ControlledResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Subscription"
      description="Choose a plan that fits your needs."
      className="md:max-w-2xl xl:max-w-6xl"
      headerClassName="lg:text-center"
    >
      <div className="mt-2 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {showVerification && !emailVerified && (
          <div className="col-span-full">
            <EmailVerificationBanner onVerified={handleVerified} />
          </div>
        )}
        {visiblePlanIds.map((id) => {
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
              className={`relative flex flex-col rounded-lg border p-4 ${
                isCurrent ? "border-primary bg-primary/5" : "border-border"
              }`}
            >
              {isCurrent && (
                <span className="bg-foreground text-background absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-0.5 text-xs font-medium">
                  Current
                </span>
              )}
              <div className="flex flex-col gap-1 xl:flex-row xl:items-center xl:justify-between xl:gap-2">
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
                <div className="mt-auto pt-3">
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
                <div className="mt-auto pt-3">
                  <Button
                    size="sm"
                    className="w-full"
                    disabled={
                      checkoutMutation.isPending || previewMutation.isPending
                    }
                    onClick={() => handleSubscribeClick(id)}
                  >
                    {isSubscribed ? "Switch" : "Subscribe"}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-muted-foreground flex flex-col pt-5 text-center lg:text-center">
        Price too high or need higher limits?{" "}
        <span>
          <a
            href={`mailto:${env.VITE_PUBLIC_SUPPORT_EMAIL_ADDRESS}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Let us know
          </a>{" "}
          or{" "}
          <a
            href="https://github.com/hfellerhoff/serial?tab=readme-ov-file#self-hosting"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            learn how to self-host
          </a>{" "}
          Serial
        </span>
      </p>
    </ControlledResponsiveDialog>
  );
}
