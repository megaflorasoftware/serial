"use client";

import { createContext, useContext } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { SwitchPreview } from "./SubscriptionDialog";

type MutationResult<T> = UseMutationResult<T, Error, any, unknown>;

interface SubscriptionDialogContextValue {
  // Plan state
  planId: string;
  recommendedPlanId: string | null;
  chosenPlanId: string;
  hasAnyPending: boolean;
  isSubscribed: boolean;
  emailVerified: boolean;
  showVerification: boolean;

  // Products
  products:
    | Array<{
        planId: string;
        monthlyPrice: number | null;
        annualPrice: number | null;
      }>
    | undefined;
  isLoadingProducts: boolean;

  // Preview states
  switchPreview: SwitchPreview | null;
  downgradePreview: SwitchPreview | null;
  pendingSwitch: {
    planId: string;
    billingInterval: "month" | "year" | null;
    appliesAt: string;
  } | null;
  pendingPlanId:
    | "standard-small"
    | "standard-medium"
    | "standard-large"
    | "pro"
    | null;

  // Mutations
  checkoutMutation: MutationResult<{ error?: string; url?: string }>;
  previewMutation: MutationResult<SwitchPreview | null>;
  switchMutation: MutationResult<{ success: boolean }>;
  portalMutation: MutationResult<{ url?: string }>;
  downgradePreviewMutation: MutationResult<SwitchPreview | null>;
  cancelMutation: MutationResult<{ success: boolean }>;

  // Actions
  setShowVerification: (show: boolean) => void;
  setSwitchPreview: (preview: SwitchPreview | null) => void;
  setDowngradePreview: (preview: SwitchPreview | null) => void;
  setPendingPlanId: (
    id: "standard-small" | "standard-medium" | "standard-large" | "pro" | null,
  ) => void;

  // Handlers
  handleSubscribeClick: (
    id: "standard-small" | "standard-medium" | "standard-large" | "pro",
  ) => void;
  handleVerified: () => Promise<void>;
  handleDowngradeClick: () => void;
}

const SubscriptionDialogContext = createContext<
  SubscriptionDialogContextValue | undefined
>(undefined);

export function SubscriptionDialogProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: SubscriptionDialogContextValue;
}) {
  return (
    <SubscriptionDialogContext.Provider value={value}>
      {children}
    </SubscriptionDialogContext.Provider>
  );
}

export function useSubscriptionDialog() {
  const context = useContext(SubscriptionDialogContext);
  if (!context) {
    throw new Error(
      "useSubscriptionDialog must be used within SubscriptionDialogProvider",
    );
  }
  return context;
}
