import "~/styles/globals.css";

import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { AppDialogs } from "../components/feed/AppDialogs";
import { Header } from "../components/feed/Header";
import type React from "react";
import FeedLoading from "~/components/loading";
import { AppLeftSidebar, AppRightSidebar } from "~/components/app-sidebar";
import { Button } from "~/components/ui/button";
import { ControlledResponsiveDialog } from "~/components/ui/responsive-dropdown";
import { ImpersonationBanner } from "~/components/ImpersonationBanner";
import { ReleaseNotifier } from "~/components/releases/ReleaseNotifier";
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";
import { InitialClientQueries } from "~/lib/data/InitialClientQueries";
import { usePlanSuccessStore } from "~/lib/data/plan-success";
import { useSubscription } from "~/lib/data/subscription";
import { useAltKeyHeld } from "~/lib/hooks/useAltKeyHeld";
import { authMiddleware } from "~/server/auth";
import { getMostRecentRelease } from "~/lib/markdown/loaders";
import { orpc } from "~/lib/orpc";
import { PLANS } from "~/server/subscriptions/plans";
import {
  getPlanFeatures,
  PLAN_ICONS,
} from "~/components/feed/SubscriptionDialog";

export const Route = createFileRoute("/_app")({
  component: RootLayout,
  server: {
    middleware: [authMiddleware],
  },
  loader: () => {
    const mostRecentRelease = getMostRecentRelease();
    return { mostRecentRelease };
  },
});

function useCheckoutSuccess() {
  const queryClient = useQueryClient();
  const [awaitingUpgrade, setAwaitingUpgrade] = useState(false);
  const { planId } = useSubscription();
  const openPlanSuccess = usePlanSuccessStore((s) => s.openDialog);

  // Detect checkout_success query param on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout_success") !== "true") return;

    // Remove the query param from the URL
    params.delete("checkout_success");
    const newUrl =
      window.location.pathname +
      (params.size > 0 ? `?${params.toString()}` : "");
    window.history.replaceState({}, "", newUrl);

    setAwaitingUpgrade(true);
  }, []);

  // Poll subscription status until the plan upgrades
  useEffect(() => {
    if (!awaitingUpgrade) return;

    if (planId !== "free") {
      // Webhook has been processed — plan is upgraded
      setAwaitingUpgrade(false);
      openPlanSuccess();
      return;
    }

    // Plan still shows free — keep polling
    const interval = setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: orpc.subscription.getStatus.queryOptions().queryKey,
      });
    }, 2000);

    return () => clearInterval(interval);
  }, [awaitingUpgrade, planId, queryClient, openPlanSuccess]);
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
  const Icon = PLAN_ICONS[planId];

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
  const { mostRecentRelease } = Route.useLoaderData();
  useAltKeyHeld();
  useCheckoutSuccess();
  const showPlanSuccess = usePlanSuccessStore((s) => s.showDialog);
  const closePlanSuccess = usePlanSuccessStore((s) => s.closeDialog);

  return (
    // <ApplyColorTheme>
    <Suspense fallback={<FeedLoading />}>
      <InitialClientQueries>
        <ImpersonationBanner />
        <SidebarProvider
          style={
            {
              "--sidebar-width": "calc(var(--spacing) * 72)",
              "--header-height": "calc(var(--spacing) * 12)",
            } as React.CSSProperties
          }
        >
          <AppLeftSidebar />
          <SidebarInset>
            <Header />
            <main className="flex flex-col">
              <div className="h-full w-full pb-6">
                <Outlet />
              </div>
              <AppDialogs />
              <CheckoutSuccessDialog
                open={showPlanSuccess}
                onOpenChange={closePlanSuccess}
              />
            </main>
            <ReleaseNotifier mostRecentRelease={mostRecentRelease} />
          </SidebarInset>
          <AppRightSidebar />
        </SidebarProvider>
      </InitialClientQueries>
    </Suspense>
    // </ApplyColorTheme>
  );
}
