"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  CircleHelpIcon,
  ShrubIcon,
  SproutIcon,
  TreeDeciduousIcon,
  TreePineIcon,
  TreesIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { PlanConfig } from "~/server/subscriptions/plans";
import type { CardRadioOption } from "~/components/ui/card-radio-group";
import { Button } from "~/components/ui/button";
import { CardRadioGroup } from "~/components/ui/card-radio-group";
import { Input } from "~/components/ui/input";
import { ControlledResponsiveDialog } from "~/components/ui/responsive-dropdown";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { authClient, useSession } from "~/lib/auth-client";
import { useFeeds } from "~/lib/data/feeds/store";
import { usePlanSuccessStore } from "~/lib/data/plan-success";
import { useSubscription } from "~/lib/data/subscription";
import { orpc } from "~/lib/orpc";
import { PLAN_IDS, PLANS } from "~/server/subscriptions/plans";

export const PLAN_ICONS = {
  free: SproutIcon,
  "standard-small": ShrubIcon,
  "standard-medium": TreeDeciduousIcon,
  "standard-large": TreePineIcon,
  pro: TreesIcon,
} as const;

const QUOTA_DISPLAY_NAMES = {
  "standard-small": "Small",
  "standard-medium": "Medium",
  "standard-large": "Large",
} as const;

const STANDARD_FEATURES = [
  "Refreshes once every 15 min",
  "Refresh in background",
] as const;

const STANDARD_PLAN_IDS = [
  "standard-small",
  "standard-medium",
  "standard-large",
] as const;

const RECOMMENDATION_MESSAGES = {
  currentFree:
    "You're just getting started with Serial, so no need to give us money just yet! Consider upgrading later when you have more feeds, or if you want feeds to refresh while you're away.",
  currentPaid:
    "This plan is just right for the number of feeds you have. Good choice!",
  upgrade:
    "We think this plan is right for you, as it will allow you to keep all your feeds active.",
} as const;

type BillingInterval = "month" | "year";

const INTERVAL_LABELS: Record<BillingInterval, string> = {
  month: "mo",
  year: "yr",
};

function formatPrice(cents: number): string {
  const dollars = cents / 100;
  return cents % 100 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
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
  } else if (
    plan.id === "standard-small" ||
    plan.id === "standard-medium" ||
    plan.id === "standard-large"
  ) {
    features.push("Refreshes once every 15 min");
    features.push("Refresh in background");
  } else if (plan.id === "pro") {
    features.push("Refreshes every minute");
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

type SwitchPreview = {
  currentPlanId: string;
  currentPlanName: string;
  currentAmount: number;
  newPlanId: string;
  newPlanName: string;
  newAmount: number;
  proratedAmount: number;
  isDowngrade: boolean;
  periodEnd: string;
  currency: string;
  billingInterval: "month" | "year";
  subscriptionId: string;
  newProductId: string;
};

type DowngradePreview = {
  currentPlanId: string;
  currentPlanName: string;
  periodEnd: string;
  subscriptionId: string;
};

function DowngradeConfirmation({
  preview,
  onBack,
  onConfirm,
  isPending,
}: {
  preview: DowngradePreview;
  onBack: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  const freePlan = PLANS.free;
  const features = getPlanFeatures(freePlan);
  const Icon = PLAN_ICONS.free;

  return (
    <ControlledResponsiveDialog
      open
      onOpenChange={() => onBack()}
      title="Downgrade Plan"
      description={`Downgrade from ${preview.currentPlanName} to Free`}
      onBack={onBack}
      footer={
        <Button className="w-full" onClick={onConfirm} disabled={isPending}>
          {isPending ? "Downgrading..." : "Confirm Downgrade to Free"}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-lg border p-4">
          <Icon size={20} className="shrink-0" />
          <div className="flex-1">
            <h3 className="font-medium">{freePlan.name} Plan</h3>
            <p className="text-muted-foreground text-sm">Free</p>
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
        <div className="rounded-lg border p-4">
          <p className="text-sm font-medium">
            Your plan will change on {formatDate(preview.periodEnd)}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            You&apos;ll keep your current {preview.currentPlanName} plan
            features until the end of your billing period. After that,
            you&apos;ll be switched to the Free plan automatically.
          </p>
        </div>
      </div>
    </ControlledResponsiveDialog>
  );
}

function FreePlanCard({
  planId,
  recommendedPlanId,
  chosenPlanId,
  pendingDate,
  hasAnyPending,
  isSubscribed,
  onDowngradeClick,
  isDowngradeLoading,
}: {
  planId: string;
  recommendedPlanId: string | null;
  chosenPlanId: string;
  pendingDate: string | null;
  hasAnyPending: boolean;
  isSubscribed: boolean;
  onDowngradeClick: () => void;
  isDowngradeLoading: boolean;
}) {
  const plan = PLANS.free;
  const isCurrent = planId === "free";
  const isPending = pendingDate != null;
  const isRecommended = recommendedPlanId === "free";
  const features = getPlanFeatures(plan);
  const Icon = PLAN_ICONS.free;

  return (
    <div
      className={`relative flex flex-col rounded-lg border p-4 ${
        isCurrent && isRecommended
          ? "border-sidebar-accent bg-sidebar-accent/5"
          : isCurrent
            ? "border-foreground bg-foreground/5"
            : isRecommended
              ? "border-sidebar-accent bg-sidebar-accent/5"
              : "border-border"
      }`}
    >
      {(isCurrent || isRecommended || isPending) && (
        <div className="absolute -top-3 left-1/2 flex -translate-x-1/2 gap-1.5">
          {isCurrent && (
            <span
              className={
                hasAnyPending
                  ? "bg-background border-foreground/70 text-foreground rounded-full border border-dashed px-3 py-0.5 text-xs font-medium"
                  : "bg-foreground text-background rounded-full px-3 py-0.5 text-xs font-medium"
              }
            >
              Current
            </span>
          )}
          {isPending && (
            <span className="bg-foreground text-background rounded-full px-3 py-0.5 text-xs font-medium whitespace-nowrap">
              Starting {formatDate(pendingDate)}
            </span>
          )}
          {isRecommended && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="bg-background border-sidebar-accent text-sidebar-accent-foreground inline-flex cursor-default items-center gap-1 rounded-full border px-3 py-0.5 text-xs font-medium">
                  Recommended
                  <CircleHelpIcon size={12} />
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">
                {chosenPlanId === "free"
                  ? RECOMMENDATION_MESSAGES.currentFree
                  : RECOMMENDATION_MESSAGES.upgrade}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Icon size={20} className="shrink-0" />
        <h3 className="font-medium">{plan.name}</h3>
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
      {!isCurrent && isSubscribed && (
        <div className="mt-auto pt-3">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={isDowngradeLoading}
            onClick={onDowngradeClick}
          >
            Downgrade
          </Button>
        </div>
      )}
    </div>
  );
}

function ProPlanCard({
  planId,
  recommendedPlanId,
  chosenPlanId,
  hasAnyPending,
  products,
  isLoadingProducts,
  isSubscribed,
  onSubscribeClick,
  portalMutation,
  checkoutMutation,
  previewMutation,
}: {
  planId: string;
  recommendedPlanId: string | null;
  chosenPlanId: string;
  hasAnyPending: boolean;
  products:
    | Array<{
        planId: string;
        monthlyPrice: number | null;
        annualPrice: number | null;
      }>
    | undefined;
  isLoadingProducts: boolean;
  isSubscribed: boolean;
  onSubscribeClick: (id: "pro") => void;
  portalMutation: { isPending: boolean; mutate: (args: object) => void };
  checkoutMutation: { isPending: boolean };
  previewMutation: { isPending: boolean };
}) {
  const plan = PLANS.pro;
  const isCurrent = planId === "pro";
  const isRecommended = recommendedPlanId === "pro";
  const features = getPlanFeatures(plan);
  const Icon = PLAN_ICONS.pro;
  const product = products?.find((p) => p.planId === "pro");
  const monthlyPrice = product?.monthlyPrice ?? null;
  const annualPrice = product?.annualPrice ?? null;
  const hasPrice = monthlyPrice != null || annualPrice != null;

  return (
    <div
      className={`relative flex flex-col rounded-lg border p-4 ${
        isCurrent && isRecommended
          ? "border-sidebar-accent bg-sidebar-accent/5"
          : isCurrent
            ? "border-foreground bg-foreground/5"
            : isRecommended
              ? "border-sidebar-accent bg-sidebar-accent/5"
              : "border-border"
      }`}
    >
      {(isCurrent || isRecommended) && (
        <div className="absolute -top-3 left-1/2 flex -translate-x-1/2 gap-1.5">
          {isCurrent && (
            <span
              className={
                hasAnyPending
                  ? "bg-background border-foreground/70 text-foreground rounded-full border border-dashed px-3 py-0.5 text-xs font-medium"
                  : "bg-foreground text-background rounded-full px-3 py-0.5 text-xs font-medium"
              }
            >
              Current
            </span>
          )}
          {isRecommended && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="bg-background border-sidebar-accent text-sidebar-accent-foreground inline-flex cursor-default items-center gap-1 rounded-full border px-3 py-0.5 text-xs font-medium">
                  Recommended
                  <CircleHelpIcon size={12} />
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">
                {chosenPlanId === "pro"
                  ? RECOMMENDATION_MESSAGES.currentPaid
                  : RECOMMENDATION_MESSAGES.upgrade}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon size={20} className="shrink-0" />
          <h3 className="font-medium">{plan.name}</h3>
        </div>
        {isLoadingProducts ? (
          <Skeleton className="h-4 w-28" />
        ) : hasPrice ? (
          <p className="text-muted-foreground text-base">
            {monthlyPrice != null && `${formatPrice(monthlyPrice)}/mo`}
            {monthlyPrice != null && annualPrice != null && " · "}
            {annualPrice != null && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-default underline decoration-dotted underline-offset-4">
                    {formatPrice(annualPrice)}/yr
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {formatPrice(Math.round(annualPrice / 12))}/mo
                </TooltipContent>
              </Tooltip>
            )}
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
      {isCurrent && isSubscribed ? (
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
      ) : !isCurrent ? (
        <div className="mt-auto pt-3">
          <Button
            size="sm"
            className="w-full"
            disabled={checkoutMutation.isPending || previewMutation.isPending}
            onClick={() => onSubscribeClick("pro")}
          >
            {isSubscribed ? "Switch" : "Subscribe"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PlanSwitchConfirmation({
  preview,
  onBack,
  onConfirm,
  isPending,
  onIntervalChange,
  isLoadingPreview,
  monthlyPrice,
  annualPrice,
}: {
  preview: SwitchPreview;
  onBack: () => void;
  onConfirm: () => void;
  isPending: boolean;
  onIntervalChange: (interval: BillingInterval) => void;
  isLoadingPreview: boolean;
  monthlyPrice: number | null;
  annualPrice: number | null;
}) {
  const [selectedInterval, setSelectedInterval] = useState<BillingInterval>(
    preview.billingInterval,
  );

  const newPlan = PLANS[preview.newPlanId as keyof typeof PLANS];
  const features = getPlanFeatures(newPlan);
  const Icon = PLAN_ICONS[preview.newPlanId as keyof typeof PLAN_ICONS];
  const intervalLabel = INTERVAL_LABELS[selectedInterval];

  const hasBothIntervals = monthlyPrice != null && annualPrice != null;

  const intervalOptions: Array<CardRadioOption<BillingInterval>> = [];
  if (monthlyPrice != null) {
    intervalOptions.push({
      value: "month",
      title: `Monthly — ${formatPrice(monthlyPrice)}/mo`,
    });
  }
  if (annualPrice != null) {
    intervalOptions.push({
      value: "year",
      title: `Annual — ${formatPrice(annualPrice)}/yr`,
      description: `${formatPrice(Math.round(annualPrice / 12))}/mo`,
    });
  }

  function handleIntervalChange(interval: BillingInterval) {
    setSelectedInterval(interval);
    onIntervalChange(interval);
  }

  return (
    <ControlledResponsiveDialog
      open
      onOpenChange={() => onBack()}
      title="Switch Plan"
      description={`Switch from ${preview.currentPlanName} to ${preview.newPlanName}`}
      onBack={onBack}
      footer={
        <Button
          className="w-full"
          onClick={onConfirm}
          disabled={isPending || isLoadingPreview}
        >
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
        {hasBothIntervals && (
          <CardRadioGroup
            value={selectedInterval}
            onValueChange={handleIntervalChange}
            options={intervalOptions}
            orientation="vertical"
          />
        )}
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
        {preview.isDowngrade ? (
          <div className="rounded-lg border p-4">
            <p className="text-sm font-medium">
              Your plan will change on {formatDate(preview.periodEnd)}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              You&apos;ll keep your current {preview.currentPlanName} plan
              features until the end of your billing period. After that,
              you&apos;ll be switched to the {preview.newPlanName} plan
              automatically.
            </p>
          </div>
        ) : preview.proratedAmount > 0 ? (
          <div className="rounded-lg border p-4">
            <p className="text-sm">
              <span className="text-muted-foreground">
                Estimated charge today:
              </span>{" "}
              <span className="font-medium">
                {formatPrice(preview.proratedAmount)}
              </span>
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              You&apos;ll be credited for the unused time on your current plan.
              The final amount may differ slightly based on your local tax
              rates.
            </p>
          </div>
        ) : null}
      </div>
    </ControlledResponsiveDialog>
  );
}

function getRecommendedPlanId(
  totalFeeds: number,
  currentPlanIndex: number,
): string | null {
  const bestFit = PLAN_IDS.find((id) => PLANS[id].maxActiveFeeds >= totalFeeds);
  if (!bestFit) return null;
  const bestFitIndex = PLAN_IDS.indexOf(bestFit);
  if (bestFitIndex < currentPlanIndex) return null;
  return bestFit;
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
    "standard-small" | "standard-medium" | "standard-large" | "pro" | null
  >(null);
  const [switchPreview, setSwitchPreview] = useState<SwitchPreview | null>(
    null,
  );
  const [downgradePreview, setDowngradePreview] =
    useState<DowngradePreview | null>(null);

  const emailVerified = session?.user?.emailVerified ?? false;

  const { data: products, isLoading: isLoadingProducts } = useQuery({
    ...orpc.subscription.getProducts.queryOptions(),
    enabled: open,
  });

  const { data: pendingSwitch } = useQuery({
    ...orpc.subscription.getPendingSwitch.queryOptions(),
    enabled: open,
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

  const downgradePreviewMutation = useMutation(
    orpc.subscription.previewDowngrade.mutationOptions({
      onSuccess: (result) => {
        if (result) {
          setDowngradePreview(result);
        } else {
          toast.error("Unable to preview downgrade");
        }
      },
    }),
  );

  const cancelMutation = useMutation(
    orpc.subscription.cancelSubscription.mutationOptions({
      onSuccess: (result) => {
        if (result.success) {
          setDowngradePreview(null);
          onOpenChange(false);
          toast.success(
            "Your subscription will be cancelled at the end of your billing period.",
          );
          void queryClient.invalidateQueries({
            queryKey: orpc.subscription.getStatus.queryOptions().queryKey,
          });
          void queryClient.invalidateQueries({
            queryKey:
              orpc.subscription.getPendingSwitch.queryOptions().queryKey,
          });
        }
      },
      onError: () => {
        toast.error("Failed to cancel subscription. Please try again.");
      },
    }),
  );

  const isSubscribed = planId !== "free";
  const feeds = useFeeds();

  // Recommend the smallest plan that fits the user's feed count,
  // but never recommend a lower-tier plan than the user's current plan
  const currentPlanIndex = PLAN_IDS.indexOf(planId);
  const recommendedPlanId = getRecommendedPlanId(
    feeds.length,
    currentPlanIndex,
  );
  const hasAnyPending = pendingSwitch != null;
  const chosenPlanId = pendingSwitch?.planId ?? planId;

  function handleSubscribeClick(
    id: "standard-small" | "standard-medium" | "standard-large" | "pro",
  ) {
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

  if (downgradePreview) {
    return (
      <DowngradeConfirmation
        preview={downgradePreview}
        onBack={() => setDowngradePreview(null)}
        onConfirm={() => cancelMutation.mutate({})}
        isPending={cancelMutation.isPending}
      />
    );
  }

  if (switchPreview) {
    const newPlanProduct = products?.find(
      (p) => p.planId === switchPreview.newPlanId,
    );

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
        isLoadingPreview={previewMutation.isPending}
        onIntervalChange={(interval) =>
          previewMutation.mutate({
            planId: switchPreview.newPlanId as
              | "standard-small"
              | "standard-medium"
              | "standard-large"
              | "pro",
            billingInterval: interval,
          })
        }
        monthlyPrice={newPlanProduct?.monthlyPrice ?? null}
        annualPrice={newPlanProduct?.annualPrice ?? null}
      />
    );
  }

  return (
    <ControlledResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Subscribe to Serial"
      description="All prices are taxes-included."
      className="lg:max-w-5xl xl:max-w-6xl"
      headerClassName="lg:text-center"
      footerBorder={false}
      footer={
        <p className="text-muted-foreground flex flex-col text-center text-sm">
          Price too high or need higher limits?{" "}
          <span>
            <a
              href={`mailto:${import.meta.env.VITE_PUBLIC_SUPPORT_EMAIL_ADDRESS}`}
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
      }
    >
      <div className="mt-2 grid gap-3 lg:grid-cols-[1fr_1.5fr_1fr] lg:gap-5 xl:grid-cols-[1fr_2fr_1fr]">
        {showVerification && !emailVerified && (
          <div className="col-span-full">
            <EmailVerificationBanner onVerified={handleVerified} />
          </div>
        )}

        {/* Free plan */}
        <FreePlanCard
          planId={planId}
          recommendedPlanId={recommendedPlanId}
          chosenPlanId={chosenPlanId}
          pendingDate={
            pendingSwitch?.planId === "free" ? pendingSwitch.appliesAt : null
          }
          hasAnyPending={hasAnyPending}
          isSubscribed={isSubscribed}
          onDowngradeClick={() => downgradePreviewMutation.mutate({})}
          isDowngradeLoading={downgradePreviewMutation.isPending}
        />

        {/* Paid plans */}
        <div className="border-border rounded-lg border p-4">
          <div className="flex items-center gap-2">
            <TreeDeciduousIcon size={20} className="shrink-0" />
            <h3 className="font-medium">Standard</h3>
          </div>
          <ul className="mt-2 space-y-1">
            {STANDARD_FEATURES.map((feature) => (
              <li
                key={feature}
                className="text-muted-foreground flex items-center gap-2 text-sm"
              >
                <CheckIcon size={12} />
                {feature}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-col gap-4">
            {STANDARD_PLAN_IDS.map((id) => {
              const plan = PLANS[id];
              const isCurrent = id === planId;
              const isPending = pendingSwitch?.planId === id;
              const pendingDate = isPending ? pendingSwitch.appliesAt : null;
              const isRecommended = id === recommendedPlanId;
              const product = products?.find((p) => p.planId === id);
              const monthlyPrice = product?.monthlyPrice ?? null;
              const annualPrice = product?.annualPrice ?? null;
              const hasPrice = monthlyPrice != null || annualPrice != null;
              const feedsLabel = `Up to ${plan.maxActiveFeeds.toLocaleString()} active feeds`;

              return (
                <div
                  key={id}
                  className={`relative rounded-lg border p-3 ${
                    isCurrent && isRecommended
                      ? "border-sidebar-accent bg-sidebar-accent/5"
                      : isCurrent
                        ? "border-foreground bg-foreground/5"
                        : isRecommended
                          ? "border-sidebar-accent bg-sidebar-accent/5"
                          : "border-border"
                  }`}
                >
                  {(isCurrent || isPending || isRecommended) && (
                    <div className="absolute -top-3 left-4 flex gap-1.5">
                      {isCurrent && (
                        <span
                          className={
                            hasAnyPending
                              ? "bg-background border-foreground/70 text-foreground rounded-full border border-dashed px-3 py-0.5 text-xs font-medium"
                              : "bg-foreground text-background rounded-full px-3 py-0.5 text-xs font-medium"
                          }
                        >
                          Current
                        </span>
                      )}
                      {pendingDate && (
                        <span className="bg-foreground text-background rounded-full px-3 py-0.5 text-xs font-medium whitespace-nowrap">
                          Starting {formatDate(pendingDate)}
                        </span>
                      )}
                      {isRecommended && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="bg-background border-sidebar-accent text-sidebar-accent-foreground inline-flex cursor-default items-center gap-1 rounded-full border px-3 py-0.5 text-xs font-medium">
                              Recommended
                              <CircleHelpIcon size={12} />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-64">
                            {chosenPlanId === id
                              ? RECOMMENDATION_MESSAGES.currentPaid
                              : RECOMMENDATION_MESSAGES.upgrade}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {QUOTA_DISPLAY_NAMES[id]}
                    </span>
                    <div className="ml-auto flex items-center gap-3">
                      {isLoadingProducts ? (
                        <Skeleton className="h-4 w-20" />
                      ) : hasPrice ? (
                        <span className="text-muted-foreground text-sm">
                          {monthlyPrice != null &&
                            `${formatPrice(monthlyPrice)}/mo`}
                          {monthlyPrice != null && annualPrice != null && " · "}
                          {annualPrice != null && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="cursor-default underline decoration-dotted underline-offset-4">
                                  {formatPrice(annualPrice)}/yr
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                {formatPrice(Math.round(annualPrice / 12))}
                                /mo
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </span>
                      ) : null}
                      {isCurrent && isSubscribed ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={portalMutation.isPending}
                          onClick={() => portalMutation.mutate({})}
                        >
                          Manage
                        </Button>
                      ) : !isCurrent ? (
                        <Button
                          size="sm"
                          disabled={
                            checkoutMutation.isPending ||
                            previewMutation.isPending
                          }
                          onClick={() => handleSubscribeClick(id)}
                        >
                          {isSubscribed ? "Switch" : "Subscribe"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <p className="text-muted-foreground mt-1 text-sm">
                    {feedsLabel}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Pro plan */}
        <ProPlanCard
          planId={planId}
          recommendedPlanId={recommendedPlanId}
          chosenPlanId={chosenPlanId}
          hasAnyPending={hasAnyPending}
          products={products}
          isLoadingProducts={isLoadingProducts}
          isSubscribed={isSubscribed}
          onSubscribeClick={handleSubscribeClick}
          portalMutation={portalMutation}
          checkoutMutation={checkoutMutation}
          previewMutation={previewMutation}
        />
      </div>
    </ControlledResponsiveDialog>
  );
}
