import "~/styles/globals.css";

import {
  createFileRoute,
  Outlet,
  redirect,
  useLocation,
  useRouterState,
} from "@tanstack/react-router";
import { useIsRestoring, useQueryClient } from "@tanstack/react-query";
import { CheckIcon } from "lucide-react";
import { Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AppDialogs } from "../components/feed/AppDialogs";
import { Header } from "../components/feed/Header";
import { GlobalImportDropzone } from "../components/feed/import/GlobalImportDropzone";
import type React from "react";
import { PublicationSyncProgress } from "~/components/connections/PublicationSyncProgress";
import { refreshPublicationSyncProgress } from "~/lib/data/publication-sync";
import { Onboarding } from "~/components/onboarding/Onboarding";
import { recordOnboardingConsentResult } from "~/lib/onboarding/store";
import FeedLoading from "~/components/loading";
import { AppLeftSidebar, AppRightSidebar } from "~/components/app-sidebar";
import { Button } from "~/components/ui/button";
import { ControlledResponsiveDialog } from "~/components/ui/responsive-dropdown";
import { useDialogStore } from "~/components/feed/dialogStore";
import { DemoBanner } from "~/components/DemoBanner";
import { ClientPerformanceProfiler } from "~/components/debug/ClientPerformanceProfiler";
import { ImpersonationBanner } from "~/components/ImpersonationBanner";
import { OfflineBanner } from "~/components/OfflineBanner";
import { PageErrorBoundary } from "~/components/PageErrorBoundary";
import { ReaderChunkPreloader } from "~/components/pwa/ReaderChunkPreloader";
import { ReleaseNotifier } from "~/components/releases/ReleaseNotifier";
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";
import { InitialClientQueries } from "~/lib/data/InitialClientQueries";
import { loadingActor } from "~/lib/data/loading-machine";
import { usePlanSuccessStore } from "~/lib/data/plan-success";
import { useSubscription } from "~/lib/data/subscription";
import {
  ATPROTO_CONSENT_RESULT_PARAM,
  ATPROTO_LINK_RESULT_PARAM,
} from "~/lib/auth/atproto";
import { useAltKeyHeld } from "~/lib/hooks/useAltKeyHeld";
import { authMiddleware } from "~/server/auth";
import { orpc, orpcRouterClient } from "~/lib/orpc";
import { PLANS } from "~/server/subscriptions/plans";
import {
  getPlanFeatures,
  PLAN_ICONS,
} from "~/components/feed/subscription-dialog";
import { getPublicConfigKey } from "~/lib/public-config";

export const Route = createFileRoute("/_app")({
  component: RootLayout,
  server: {
    middleware: [authMiddleware],
  },
  beforeLoad: () => {
    if (getPublicConfigKey("PUBLIC_IS_MAINTENANCE_MODE")) {
      throw redirect({
        to: "/maintenance",
      });
    }
  },
});

const MAX_SYNC_ATTEMPTS = 10;
const SYNC_POLL_INTERVAL_MS = 3_000;
const CHECKOUT_SYNC_TIMEOUT_MS = 60_000;

function useCheckoutSuccess() {
  const queryClient = useQueryClient();
  const [awaitingUpgrade, setAwaitingUpgrade] = useState(false);
  const { planId, billingEnabled } = useSubscription();
  const openPlanSuccess = usePlanSuccessStore((s) => s.openDialog);
  const previousPlanIdRef = useRef<string | null>(null);
  const hasProcessedCheckout = useRef(false);

  // Detect checkout_success query param (waits for billingEnabled to resolve)
  useEffect(() => {
    if (!billingEnabled) return;
    if (hasProcessedCheckout.current) return;

    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout_success") !== "true") return;

    hasProcessedCheckout.current = true;

    // Remove the query param from the URL
    params.delete("checkout_success");
    const newUrl =
      window.location.pathname +
      (params.size > 0 ? `?${params.toString()}` : "");
    window.history.replaceState({}, "", newUrl);

    // Snapshot the current plan so we can detect when it changes
    previousPlanIdRef.current = planId;
    setAwaitingUpgrade(true);
  }, [billingEnabled, planId]);

  // Eagerly sync after checkout, then poll if needed
  useEffect(() => {
    if (!awaitingUpgrade) return;

    const previousPlanId = previousPlanIdRef.current;

    // Check if plan has already changed (e.g. webhook arrived fast)
    if (previousPlanId !== null && planId !== previousPlanId) {
      setAwaitingUpgrade(false);
      openPlanSuccess();
      return;
    }

    const controller = new AbortController();
    let attempts = 0;
    let isSyncing = false;

    const sync = async (): Promise<boolean> => {
      try {
        const result = await orpcRouterClient.subscription.syncAfterCheckout();

        if (controller.signal.aborted) return false;

        // Update the getStatus query data with the fresh result
        queryClient.setQueryData(
          orpc.subscription.getStatus.queryOptions().queryKey,
          result,
        );

        const planChanged =
          previousPlanId !== null && result.planId !== previousPlanId;
        if (planChanged) {
          // Clear the stale refresh cooldown so the button re-enables
          // immediately with the new plan's interval.
          loadingActor.send({
            type: "REFRESH_COOLDOWN_UPDATE",
            nextRefreshAt: null,
          });

          setAwaitingUpgrade(false);
          openPlanSuccess();
          return true;
        }
      } catch {
        // Ignore errors, will retry
      }
      return false;
    };

    const poll = async () => {
      if (isSyncing || controller.signal.aborted) return;

      isSyncing = true;
      attempts++;
      const planWasUpdated = await sync();
      isSyncing = false;

      if (controller.signal.aborted) return;
      if (planWasUpdated) {
        clearInterval(interval);
        clearTimeout(overallTimeout);
        return;
      }
      if (attempts >= MAX_SYNC_ATTEMPTS) {
        clearInterval(interval);
        clearTimeout(overallTimeout);
        // Give up gracefully — user will see the upgrade on next load
        setAwaitingUpgrade(false);
      }
    };

    const interval = setInterval(() => {
      void poll();
    }, SYNC_POLL_INTERVAL_MS);
    const overallTimeout = setTimeout(() => {
      controller.abort();
      clearInterval(interval);
      setAwaitingUpgrade(false);
    }, CHECKOUT_SYNC_TIMEOUT_MS);

    // Count only requests that start so slow requests do not consume retries.
    void poll();

    return () => {
      controller.abort();
      clearInterval(interval);
      clearTimeout(overallTimeout);
    };
  }, [awaitingUpgrade, planId, queryClient, openPlanSuccess]);

  return { awaitingUpgrade, billingEnabled };
}

const ATPROTO_LINK_ERROR_MESSAGES: Record<string, string> = {
  conflict: "That Atmosphere account is already connected to another user.",
  exists:
    "You already have an Atmosphere account connected. Disconnect it first.",
};

const ATPROTO_CONSENT_ERROR_MESSAGES: Record<string, string> = {
  denied: "Permissions weren't granted, so your sync settings were not saved.",
  changed: "Your sync settings changed. Review them and save again.",
};

/**
 * Detect a result param an AT Protocol callback redirects back with (the
 * link callback's ?atproto_link=, the Consent upgrade's ?atproto_consent=),
 * toast the outcome, and re-open the Atmosphere subpane so the user sees
 * the connection's state. The two params stay distinct so a consent return
 * can later trigger a subscription sync while a link return never does.
 */
function useAtprotoReturn(
  param: string,
  outcome: {
    successMessage?: string;
    errorMessages: Record<string, string>;
    fallbackErrorMessage: string;
  },
) {
  const launchDialog = useDialogStore((s) => s.launchDialog);
  const queryClient = useQueryClient();
  const isRestoring = useIsRestoring();

  useEffect(() => {
    // Wait for the persisted query cache to restore: dropping the status
    // entry before restoration finishes would be undone by it.
    if (isRestoring) return;

    const params = new URLSearchParams(window.location.search);
    const result = params.get(param);
    if (!result) return;

    // Clean the query param from the URL
    params.delete(param);
    const newUrl =
      window.location.pathname +
      (params.size > 0 ? `?${params.toString()}` : "");
    window.history.replaceState({}, "", newUrl);

    // The persisted cache restores the pre-flight connection status as
    // fresh (the OAuth round trip usually beats staleTime), so the reopened
    // dialog would render stale state and never refetch. Drop the entry
    // outright: the pane shows its loading state, then the live result.
    queryClient.removeQueries({
      queryKey: orpc.atproto.getConnectionStatus.queryKey(),
    });

    if (result === "success") {
      if (outcome.successMessage) toast.success(outcome.successMessage);
      if (param === ATPROTO_CONSENT_RESULT_PARAM)
        void refreshPublicationSyncProgress(queryClient);
    } else {
      // Own-property lookup only: `result` is an unvalidated query param, so
      // a plain `map[result]` would resolve inherited keys ("toString") to a
      // function and defeat the `??` fallback.
      const message = Object.hasOwn(outcome.errorMessages, result)
        ? outcome.errorMessages[result]
        : outcome.fallbackErrorMessage;
      toast.error(message);
    }
    if (param === ATPROTO_CONSENT_RESULT_PARAM)
      recordOnboardingConsentResult(result);
    launchDialog("connections", { connectionsPane: "atproto" });
  }, [launchDialog, queryClient, isRestoring, param, outcome]);
}

const ATPROTO_LINK_RETURN = {
  // Success needs no toast — the reopened pane's connected state says it.
  errorMessages: ATPROTO_LINK_ERROR_MESSAGES,
  fallbackErrorMessage:
    "Couldn't connect your Atmosphere account. Please try again.",
};

const ATPROTO_CONSENT_RETURN = {
  successMessage: "Settings saved",
  errorMessages: ATPROTO_CONSENT_ERROR_MESSAGES,
  fallbackErrorMessage:
    "Couldn't update your Atmosphere permissions. Please try again.",
};

function useAtprotoLinkReturn() {
  useAtprotoReturn(ATPROTO_LINK_RESULT_PARAM, ATPROTO_LINK_RETURN);
}

function useAtprotoConsentReturn() {
  useAtprotoReturn(ATPROTO_CONSENT_RESULT_PARAM, ATPROTO_CONSENT_RETURN);
}

/**
 * Detect ?subscription=open query param (set by the Polar portal return URL)
 * and re-open the subscription dialog.
 */
function usePortalReturn() {
  const launchDialog = useDialogStore((s) => s.launchDialog);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("subscription") !== "open") return;

    // Clean the query param from the URL
    params.delete("subscription");
    const newUrl =
      window.location.pathname +
      (params.size > 0 ? `?${params.toString()}` : "");
    window.history.replaceState({}, "", newUrl);

    launchDialog("subscription");
  }, [launchDialog]);
}

function CheckoutSuccessDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { planId } = useSubscription();
  const plan = PLANS[planId];
  const features = getPlanFeatures(plan);
  const Icon = PLAN_ICONS[planId] ?? PLAN_ICONS.free;

  return (
    <ControlledResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Welcome to Serial"
      description="Your subscription is now active. Thank you for your support!"
      headerClassName="text-center"
    >
      <div className="flex flex-col items-center gap-4 pt-4">
        <div className="bg-primary/10 flex size-12 items-center justify-center rounded-full">
          <Icon size={24} className="text-primary" />
        </div>
        <h3 className="text-lg font-semibold">{plan.name} Plan</h3>
        <ul className="w-full space-y-2">
          {features.map((feature) => (
            <li key={feature} className="flex items-center gap-2 text-sm">
              <CheckIcon size={16} className="text-primary shrink-0" />
              {feature}
            </li>
          ))}
        </ul>
        <Button className="mt-2 w-full" onClick={() => onOpenChange(false)}>
          Get Started
        </Button>
      </div>
    </ControlledResponsiveDialog>
  );
}

function RootLayout() {
  useAltKeyHeld();
  usePortalReturn();
  useAtprotoLinkReturn();
  useAtprotoConsentReturn();
  const { pathname } = useLocation();
  // The location changes before the rendered matches swap, so a reset keyed
  // on the pathname would re-render the failed page once more; the leaf
  // match id changes exactly when the outlet does.
  const renderedMatchId = useRouterState({
    select: (state) => state.matches[state.matches.length - 1]?.id ?? "",
  });
  const { awaitingUpgrade, billingEnabled } = useCheckoutSuccess();
  const showPlanSuccess = usePlanSuccessStore((s) => s.showDialog);
  const closePlanSuccess = usePlanSuccessStore((s) => s.closeDialog);

  if (awaitingUpgrade) {
    return <FeedLoading />;
  }

  return (
    // <ApplyColorTheme>
    <Suspense fallback={<FeedLoading />}>
      <InitialClientQueries>
        <ClientPerformanceProfiler>
          <GlobalImportDropzone />
          <PublicationSyncProgress />
          <div className="flex h-dvh flex-col overflow-hidden">
            <ImpersonationBanner />
            <DemoBanner />
            <OfflineBanner />
            <ReaderChunkPreloader />
            <SidebarProvider
              className="h-auto min-h-0 flex-1"
              style={
                {
                  "--sidebar-width": "calc(var(--spacing) * 72)",
                  "--header-height": "calc(var(--spacing) * 12)",
                } as React.CSSProperties
              }
            >
              <AppLeftSidebar />
              <SidebarInset
                style={
                  pathname.startsWith("/watch/")
                    ? { scrollbarGutter: "auto" }
                    : undefined
                }
              >
                <Header />
                <main className="flex flex-col">
                  <div className="h-full w-full pb-6">
                    <PageErrorBoundary resetKey={renderedMatchId}>
                      <Outlet />
                    </PageErrorBoundary>
                  </div>
                  <AppDialogs />
                  <Onboarding />
                  {billingEnabled && (
                    <CheckoutSuccessDialog
                      open={showPlanSuccess}
                      onOpenChange={closePlanSuccess}
                    />
                  )}
                </main>
                <ReleaseNotifier />
              </SidebarInset>
              <AppRightSidebar />
            </SidebarProvider>
          </div>
        </ClientPerformanceProfiler>
      </InitialClientQueries>
    </Suspense>
    // </ApplyColorTheme>
  );
}
