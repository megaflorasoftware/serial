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
import { createContext, useContext, useEffect, useRef, useState } from "react";
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
import { useDialogStore } from "~/components/feed/dialogStore";

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

const BILLING_INTERVAL_DISPLAY: Record<BillingInterval, string> = {
  month: "Monthly",
  year: "Annual",
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

export type SwitchPreview = {
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

function CurrentPlanContent({
  summary,
  pendingSwitch,
  onSwitchClick,
  onCancelPending,
  isCancelPending,
}: {
  summary: {
    planId: string;
    planName: string;
    amount: number | null;
    currency: string | null;
    billingInterval: "month" | "year" | null;
    currentPeriodEnd: string | null;
  };
  pendingSwitch:
    | {
        planId: string;
        billingInterval: "month" | "year" | null;
        appliesAt: string;
      }
    | null
    | undefined;
  onSwitchClick: () => void;
  onCancelPending: () => void;
  isCancelPending: boolean;
}) {
  const plan = PLANS[summary.planId as keyof typeof PLANS];
  const features = getPlanFeatures(plan);
  const Icon = PLAN_ICONS[summary.planId as keyof typeof PLAN_ICONS];
  const intervalLabel = summary.billingInterval
    ? INTERVAL_LABELS[summary.billingInterval]
    : null;

  const hasPrice = summary.amount != null && intervalLabel != null;
  const hasRenewalDate = summary.currentPeriodEnd != null;

  const hasPendingPlanChange =
    pendingSwitch != null && pendingSwitch.planId !== summary.planId;
  const hasPendingIntervalChange =
    pendingSwitch != null &&
    pendingSwitch.planId === summary.planId &&
    pendingSwitch.billingInterval != null &&
    pendingSwitch.billingInterval !== summary.billingInterval;
  const hasPendingSwitch = hasPendingPlanChange || hasPendingIntervalChange;
  const pendingPlan = hasPendingSwitch
    ? PLANS[pendingSwitch.planId as keyof typeof PLANS]
    : null;
  const PendingIcon = hasPendingSwitch
    ? PLAN_ICONS[pendingSwitch.planId as keyof typeof PLAN_ICONS]
    : null;
  const pendingFeatures = pendingPlan ? getPlanFeatures(pendingPlan) : [];
  const pendingIntervalLabel =
    hasPendingIntervalChange && pendingSwitch.billingInterval
      ? BILLING_INTERVAL_DISPLAY[pendingSwitch.billingInterval]
      : null;

  return (
    <div className="space-y-4">
      {hasPendingSwitch && pendingPlan && PendingIcon && (
        <>
          <div className="flex items-center gap-3 rounded-lg border border-dashed p-4">
            <PendingIcon size={20} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <h3 className="font-medium">
                {pendingPlan.name} Plan
                {pendingIntervalLabel && ` · ${pendingIntervalLabel}`}
              </h3>
              <p className="text-muted-foreground text-sm">
                Starting {formatDate(pendingSwitch.appliesAt)}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={isCancelPending}
              onClick={onCancelPending}
            >
              {isCancelPending ? "Canceling..." : "Cancel"}
            </Button>
          </div>
          <ul className="space-y-2">
            {pendingFeatures.map((feature) => (
              <li
                key={feature}
                className="text-muted-foreground flex items-center gap-2 text-sm"
              >
                <CheckIcon size={14} className="shrink-0" />
                {feature}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="flex items-center gap-3 rounded-lg border p-4">
        <Icon size={20} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="font-medium">
            {hasPendingSwitch
              ? `${summary.planName} Plan (Current)`
              : `${summary.planName} Plan`}
          </h3>
          <p className="text-muted-foreground text-sm">
            {hasPrice && `${formatPrice(summary.amount!)}/${intervalLabel}`}
            {hasPrice && hasRenewalDate && " · "}
            {hasRenewalDate &&
              (hasPendingSwitch
                ? `Until ${formatDate(summary.currentPeriodEnd!)}`
                : `Renews ${formatDate(summary.currentPeriodEnd!)}`)}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onSwitchClick}>
          Switch
        </Button>
      </div>
      {!hasPendingSwitch && (
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
      )}
    </div>
  );
}

function FreePlanCard() {
  const {
    planId,
    recommendedPlanId,
    chosenPlanId,
    pendingSwitch,
    isSubscribed,
    onSwitchToFreeClick,
    isSwitchToFreeLoading,
  } = useSubscriptionDialogContext();

  const plan = PLANS.free;
  const isCurrent = planId === "free";
  const pendingDate =
    pendingSwitch?.planId === "free" ? pendingSwitch.appliesAt : null;
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
            <span className="bg-foreground text-background rounded-full px-3 py-0.5 text-xs font-medium">
              Current
            </span>
          )}
          {isPending && (
            <span className="bg-background border-foreground/70 text-foreground rounded-full border border-dashed px-3 py-0.5 text-xs font-medium whitespace-nowrap">
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
            size="sm"
            className="w-full"
            disabled={isSwitchToFreeLoading}
            onClick={onSwitchToFreeClick}
          >
            Switch
          </Button>
        </div>
      )}
    </div>
  );
}

function ProPlanCard() {
  const {
    planId,
    recommendedPlanId,
    chosenPlanId,
    products,
    isLoadingProducts,
    isSubscribed,
    currentBillingInterval,
    onBillingCycleSwitch,
    onSubscribeClick,
    checkoutMutation,
    previewMutation,
  } = useSubscriptionDialogContext();
  const plan = PLANS.pro;
  const isCurrent = planId === "pro";
  const isRecommended = recommendedPlanId === "pro";
  const features = getPlanFeatures(plan);
  const Icon = PLAN_ICONS.pro;
  const product = products?.find((p) => p.planId === "pro");
  const monthlyPrice = product?.monthlyPrice ?? null;
  const annualPrice = product?.annualPrice ?? null;
  const hasPrice = monthlyPrice != null || annualPrice != null;

  const showBillingCycleSwitch = isCurrent && currentBillingInterval != null;

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
            <span className="bg-foreground text-background rounded-full px-3 py-0.5 text-xs font-medium">
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
      {showBillingCycleSwitch && (
        <div className="mt-auto pt-3">
          <BillingCycleSwitchButton
            currentInterval={currentBillingInterval}
            onSwitch={onBillingCycleSwitch}
            isPending={previewMutation.isPending}
          />
        </div>
      )}
      {!isCurrent && (
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
      )}
    </div>
  );
}

function PlanSwitchConfirmationContent({
  preview,
  onIntervalChange,
  monthlyPrice,
  annualPrice,
  currentBillingInterval,
}: {
  preview: SwitchPreview;
  onIntervalChange: (interval: BillingInterval) => void;
  monthlyPrice: number | null;
  annualPrice: number | null;
  currentBillingInterval: BillingInterval | null;
}) {
  const [selectedInterval, setSelectedInterval] = useState<BillingInterval>(
    preview.billingInterval,
  );

  const newPlan = PLANS[preview.newPlanId as keyof typeof PLANS];
  const features = getPlanFeatures(newPlan);
  const Icon = PLAN_ICONS[preview.newPlanId as keyof typeof PLAN_ICONS];
  const isFreePlan = preview.newPlanId === "free";
  const intervalLabel = isFreePlan ? null : INTERVAL_LABELS[selectedInterval];

  const isSamePlanSwitch = preview.currentPlanId === preview.newPlanId;
  const hasBothIntervals =
    !isFreePlan && monthlyPrice != null && annualPrice != null;

  const intervalOptions: Array<CardRadioOption<BillingInterval>> = [];
  if (monthlyPrice != null) {
    intervalOptions.push({
      value: "month",
      title: `Monthly — ${formatPrice(monthlyPrice)}/mo`,
      disabled: isSamePlanSwitch && currentBillingInterval === "month",
    });
  }
  if (annualPrice != null) {
    intervalOptions.push({
      value: "year",
      title: `Annual — ${formatPrice(annualPrice)}/yr`,
      description: `${formatPrice(Math.round(annualPrice / 12))}/mo`,
      disabled: isSamePlanSwitch && currentBillingInterval === "year",
    });
  }

  function handleIntervalChange(interval: BillingInterval) {
    setSelectedInterval(interval);
    onIntervalChange(interval);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg border p-4">
        <Icon size={20} className="shrink-0" />
        <div className="flex-1">
          <h3 className="font-medium">{preview.newPlanName} Plan</h3>
          <p className="text-muted-foreground text-sm">
            {isFreePlan
              ? "Free"
              : `${formatPrice(preview.newAmount)}/${intervalLabel}`}
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
            The final amount may differ slightly based on your local tax rates.
          </p>
        </div>
      ) : null}
    </div>
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

type SubscriptionDialogContextValue = {
  planId: string;
  recommendedPlanId: string | null;
  chosenPlanId: string;

  isSubscribed: boolean;
  products:
    | Array<{
        planId: string;
        monthlyPrice: number | null;
        annualPrice: number | null;
      }>
    | undefined;
  isLoadingProducts: boolean;
  pendingSwitch:
    | {
        planId: string;
        billingInterval: "month" | "year" | null;
        appliesAt: string;
      }
    | null
    | undefined;
  onSubscribeClick: (
    id: "standard-small" | "standard-medium" | "standard-large" | "pro",
  ) => void;
  onSwitchToFreeClick: () => void;
  isSwitchToFreeLoading: boolean;
  currentBillingInterval: BillingInterval | null;
  onBillingCycleSwitch: (interval: BillingInterval) => void;
  portalMutation: { isPending: boolean; mutate: (args: object) => void };
  checkoutMutation: { isPending: boolean };
  previewMutation: { isPending: boolean };
};

const SubscriptionDialogContext =
  createContext<SubscriptionDialogContextValue | null>(null);

function useSubscriptionDialogContext() {
  const ctx = useContext(SubscriptionDialogContext);
  if (!ctx) {
    throw new Error(
      "useSubscriptionDialogContext must be used within SubscriptionDialogProvider",
    );
  }
  return ctx;
}

function BillingCycleSwitchButton({
  currentInterval,
  onSwitch,
  isPending,
}: {
  currentInterval: BillingInterval;
  onSwitch: (interval: BillingInterval) => void;
  isPending: boolean;
}) {
  const alternateInterval: BillingInterval =
    currentInterval === "month" ? "year" : "month";

  return (
    <Button
      size="sm"
      disabled={isPending}
      onClick={() => onSwitch(alternateInterval)}
    >
      Switch
    </Button>
  );
}

function StandardPlanCards() {
  const {
    planId,
    recommendedPlanId,
    chosenPlanId,
    isSubscribed,
    products,
    isLoadingProducts,
    pendingSwitch,
    currentBillingInterval,
    onBillingCycleSwitch,
    onSubscribeClick,
    checkoutMutation,
    previewMutation,
  } = useSubscriptionDialogContext();

  return (
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
                    <span className="bg-foreground text-background rounded-full px-3 py-0.5 text-xs font-medium">
                      Current
                    </span>
                  )}
                  {pendingDate && (
                    <span className="bg-background border-foreground/70 text-foreground rounded-full border border-dashed px-3 py-0.5 text-xs font-medium whitespace-nowrap">
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
                <span className="font-medium">{QUOTA_DISPLAY_NAMES[id]}</span>
                <div className="ml-auto flex items-center gap-3">
                  {isLoadingProducts ? (
                    <Skeleton className="h-4 w-20" />
                  ) : hasPrice ? (
                    <span className="text-muted-foreground text-base">
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
                  {isCurrent && currentBillingInterval && (
                    <BillingCycleSwitchButton
                      currentInterval={currentBillingInterval}
                      onSwitch={onBillingCycleSwitch}
                      isPending={previewMutation.isPending}
                    />
                  )}
                  {!isCurrent && (
                    <Button
                      size="sm"
                      disabled={
                        checkoutMutation.isPending || previewMutation.isPending
                      }
                      onClick={() => onSubscribeClick(id)}
                    >
                      {isSubscribed ? "Switch" : "Subscribe"}
                    </Button>
                  )}
                </div>
              </div>
              <p className="text-muted-foreground mt-1 text-sm">{feedsLabel}</p>
            </div>
          );
        })}
      </div>
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
  const queryClient = useQueryClient();
  const [showVerification, setShowVerification] = useState(false);
  const [pendingPlanId, setPendingPlanId] = useState<
    "standard-small" | "standard-medium" | "standard-large" | "pro" | null
  >(null);
  const [switchPreview, setSwitchPreview] = useState<SwitchPreview | null>(
    null,
  );
  const [showPlanPicker, setShowPlanPicker] = useState(false);
  const subscriptionView = useDialogStore((s) => s.subscriptionView);
  const prevOpenRef = useRef(false);

  // Reset dialog state when it opens, respecting the requested view
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setSwitchPreview(null);
      setShowVerification(false);
      setShowPlanPicker(subscriptionView === "picker");
    }
    prevOpenRef.current = open;
  }, [open, subscriptionView]);

  const emailVerified = session?.user?.emailVerified ?? false;
  const isSubscribed = planId !== "free";

  const { data: products, isLoading: isLoadingProducts } = useQuery({
    ...orpc.subscription.getProducts.queryOptions(),
    enabled: open,
  });

  const { data: pendingSwitch } = useQuery({
    ...orpc.subscription.getPendingSwitch.queryOptions(),
    enabled: open,
  });

  const { data: subscriptionSummary, isLoading: isLoadingSummary } = useQuery({
    ...orpc.subscription.getSubscriptionSummary.queryOptions(),
    enabled: open && isSubscribed,
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

  const revertPendingMutation = useMutation(
    orpc.subscription.revertPendingChange.mutationOptions({
      onSuccess: (result) => {
        if (result.success) {
          toast.success("Pending change cancelled.");
          void queryClient.invalidateQueries({
            queryKey:
              orpc.subscription.getPendingSwitch.queryOptions().queryKey,
          });
          void queryClient.invalidateQueries({
            queryKey:
              orpc.subscription.getSubscriptionSummary.queryOptions().queryKey,
          });
          void queryClient.invalidateQueries({
            queryKey: orpc.subscription.getStatus.queryOptions().queryKey,
          });
        }
      },
      onError: () => {
        toast.error("Failed to cancel pending change. Please try again.");
      },
    }),
  );

  const downgradePreviewMutation = useMutation(
    orpc.subscription.previewDowngrade.mutationOptions({
      onSuccess: (result) => {
        if (result) {
          setSwitchPreview({
            currentPlanId: result.currentPlanId,
            currentPlanName: result.currentPlanName,
            currentAmount: 0,
            newPlanId: "free",
            newPlanName: PLANS.free.name,
            newAmount: 0,
            proratedAmount: 0,
            isDowngrade: true,
            periodEnd: result.periodEnd,
            currency: "usd",
            billingInterval: "month",
            subscriptionId: result.subscriptionId,
            newProductId: "",
          });
        } else {
          toast.error("Unable to preview switch");
        }
      },
    }),
  );

  const cancelMutation = useMutation(
    orpc.subscription.cancelSubscription.mutationOptions({
      onSuccess: (result) => {
        if (result.success) {
          setSwitchPreview(null);
          onOpenChange(false);
          toast.success(
            "Your plan will switch at the end of your billing period.",
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

  const feeds = useFeeds();

  // Recommend the smallest plan that fits the user's feed count,
  // but never recommend a lower-tier plan than the user's current plan
  const currentPlanIndex = PLAN_IDS.indexOf(planId);
  const recommendedPlanId = getRecommendedPlanId(
    feeds.length,
    currentPlanIndex,
  );
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

  const contextValue: SubscriptionDialogContextValue = {
    planId,
    recommendedPlanId,
    chosenPlanId,
    isSubscribed,
    products,
    isLoadingProducts,
    pendingSwitch,
    onSubscribeClick: handleSubscribeClick,
    onSwitchToFreeClick: () => downgradePreviewMutation.mutate({}),
    isSwitchToFreeLoading: downgradePreviewMutation.isPending,
    currentBillingInterval:
      (subscriptionSummary?.billingInterval as BillingInterval | null) ?? null,
    onBillingCycleSwitch: (interval: BillingInterval) => {
      if (!subscriptionSummary) return;
      const paidPlanId = subscriptionSummary.planId;
      previewMutation.mutate({ planId: paidPlanId, billingInterval: interval });
    },
    portalMutation,
    checkoutMutation,
    previewMutation,
  };

  // Determine current view
  const showOverview =
    isSubscribed &&
    !showPlanPicker &&
    !switchPreview &&
    (isLoadingSummary || subscriptionSummary != null);
  const isPlanPickerView = !switchPreview && !showOverview;
  const isSwitchToFree = switchPreview?.newPlanId === "free";

  let dialogTitle: string;
  let dialogDescription: string;
  let dialogFooter: React.ReactNode;
  let dialogOnBack: (() => void) | undefined;

  const isBillingCycleSwitch =
    switchPreview != null &&
    switchPreview.currentPlanId === switchPreview.newPlanId;

  if (switchPreview) {
    const billingCycleLabel =
      BILLING_INTERVAL_DISPLAY[switchPreview.billingInterval];
    dialogTitle = "Switch Plan";
    dialogDescription = isBillingCycleSwitch
      ? `Switch to ${billingCycleLabel} plan`
      : `Switch from ${switchPreview.currentPlanName} to ${switchPreview.newPlanName}`;
    dialogOnBack = () => setSwitchPreview(null);
    dialogFooter = isSwitchToFree ? (
      <Button
        className="w-full"
        onClick={() => cancelMutation.mutate({})}
        disabled={cancelMutation.isPending}
      >
        {cancelMutation.isPending
          ? "Switching..."
          : `Confirm Switch to ${switchPreview.newPlanName}`}
      </Button>
    ) : (
      <Button
        className="w-full"
        onClick={() =>
          switchMutation.mutate({
            subscriptionId: switchPreview.subscriptionId,
            newProductId: switchPreview.newProductId,
          })
        }
        disabled={switchMutation.isPending || previewMutation.isPending}
      >
        {switchMutation.isPending
          ? "Switching..."
          : `Confirm Switch to ${switchPreview.newPlanName}`}
      </Button>
    );
  } else if (showOverview) {
    dialogTitle = "Your Plan";
    dialogDescription = "Manage your current subscription.";
    dialogFooter = (
      <Button
        className="w-full"
        disabled={portalMutation.isPending}
        onClick={() => portalMutation.mutate({})}
      >
        {portalMutation.isPending ? "Loading..." : "Open Billing Portal"}
      </Button>
    );
  } else {
    dialogTitle = "Subscribe to Serial";
    dialogDescription = "All prices are taxes-included.";
    dialogOnBack = isSubscribed ? () => setShowPlanPicker(false) : undefined;
    dialogFooter = (
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
    );
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      if (switchPreview) {
        setSwitchPreview(null);
        return;
      }
      if (showPlanPicker && isSubscribed) {
        setShowPlanPicker(false);
        return;
      }
      setShowPlanPicker(false);
      onOpenChange(false);
      return;
    }
    onOpenChange(nextOpen);
  }

  const newPlanProduct = switchPreview
    ? products?.find((p) => p.planId === switchPreview.newPlanId)
    : undefined;

  return (
    <SubscriptionDialogContext.Provider value={contextValue}>
      <ControlledResponsiveDialog
        open={open}
        onOpenChange={handleOpenChange}
        title={dialogTitle}
        description={dialogDescription}
        className={isPlanPickerView ? "lg:max-w-5xl xl:max-w-6xl" : undefined}
        headerClassName={isPlanPickerView ? "lg:text-center" : undefined}
        onBack={dialogOnBack}
        footer={dialogFooter}
      >
        {switchPreview ? (
          <PlanSwitchConfirmationContent
            preview={switchPreview}
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
            currentBillingInterval={
              (subscriptionSummary?.billingInterval as BillingInterval | null) ??
              null
            }
          />
        ) : showOverview ? (
          isLoadingSummary ? (
            <div className="space-y-4">
              <Skeleton className="h-[72px] w-full rounded-lg" />
              <div className="space-y-2">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-5 w-44" />
              </div>
            </div>
          ) : subscriptionSummary ? (
            <CurrentPlanContent
              summary={subscriptionSummary}
              pendingSwitch={pendingSwitch}
              onSwitchClick={() => setShowPlanPicker(true)}
              onCancelPending={() => revertPendingMutation.mutate({})}
              isCancelPending={revertPendingMutation.isPending}
            />
          ) : null
        ) : (
          <div className="mt-2 grid gap-3 lg:grid-cols-[1fr_1.5fr_1fr] lg:gap-5 xl:grid-cols-[1fr_2fr_1fr]">
            {showVerification && !emailVerified && (
              <div className="col-span-full">
                <EmailVerificationBanner onVerified={handleVerified} />
              </div>
            )}

            {/* Free plan */}
            <FreePlanCard />

            {/* Paid plans */}
            <StandardPlanCards />

            {/* Pro plan */}
            <ProPlanCard />
          </div>
        )}
      </ControlledResponsiveDialog>
    </SubscriptionDialogContext.Provider>
  );
}
