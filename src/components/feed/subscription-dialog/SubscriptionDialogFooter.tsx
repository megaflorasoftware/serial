import { BILLING_INTERVAL_DISPLAY } from "./constants";
import type { SubscriptionDialogController } from "./useSubscriptionDialogController";
import { Button } from "~/components/ui/button";
import { env } from "~/env";

export function SubscriptionDialogFooter({
  controller,
}: {
  controller: SubscriptionDialogController;
}) {
  const { cancelMutation, portalMutation, previewMutation, switchMutation } =
    controller;
  const { switchPreview } = controller;

  if (switchPreview) {
    if (switchPreview.newPlanId === "free") {
      return (
        <Button
          className="w-full"
          onClick={() => cancelMutation.mutate({})}
          disabled={cancelMutation.isPending}
        >
          {cancelMutation.isPending
            ? "Switching..."
            : `Confirm Switch to ${switchPreview.newPlanName}`}
        </Button>
      );
    }
    return (
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
  }

  if (controller.showOverview) {
    return (
      <Button
        className="w-full"
        disabled={portalMutation.isPending}
        onClick={() => portalMutation.mutate({})}
      >
        {portalMutation.isPending ? "Loading..." : "Open Billing Portal"}
      </Button>
    );
  }

  return (
    <p className="text-muted-foreground flex flex-col text-center text-sm">
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
          href="https://github.com/megaflorasoftware/serial?tab=readme-ov-file#self-hosting"
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

export function getSubscriptionDialogCopy(
  controller: SubscriptionDialogController,
) {
  const { showOverview, switchPreview } = controller;
  if (switchPreview) {
    const billingCycleLabel =
      BILLING_INTERVAL_DISPLAY[switchPreview.billingInterval];
    return {
      title: "Switch Plan",
      description:
        switchPreview.currentPlanId === switchPreview.newPlanId
          ? `Switch to ${billingCycleLabel} plan`
          : `Switch from ${switchPreview.currentPlanName} to ${switchPreview.newPlanName}`,
    };
  }
  if (showOverview) {
    return {
      title: "Your Plan",
      description: "Manage your current subscription.",
    };
  }
  return {
    title: "Subscribe to Serial",
    description: "All prices are taxes-included.",
  };
}
