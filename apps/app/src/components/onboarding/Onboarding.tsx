import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CopyIcon, DownloadIcon, ImportIcon } from "lucide-react";
import { toast } from "sonner";
import { Guidance } from "./Guidance";
import type { OnboardingInstruction } from "~/lib/onboarding/store";
import { useAtprotoReconnect } from "~/components/connections/AtprotoConnection";
import { ReconnectBanner } from "~/components/connections/ConnectedAccountRow";
import {
  advanceInstruction,
  advanceOnboarding,
  advanceSavedOnboardingStep,
  finishOnboarding,
  guideOnboarding,
  requestOnboardingSkip,
  startOnboarding,
  stopOnboarding,
  useOnboarding,
} from "~/lib/onboarding/store";
import { orpc, orpcRouterClient } from "~/lib/orpc";
import { ControlledResponsiveDialog } from "~/components/ui/responsive-dropdown";
import { Button } from "~/components/ui/button";
import { useSidebar } from "~/components/ui/sidebar";
import { useDialogStore } from "~/components/feed/dialogStore";
import {
  AtprotoSyncSettingsForm,
  useAtprotoSyncSettingsSave,
} from "~/components/connections/AtprotoSyncSettingsForm";
import { authClient } from "~/lib/auth-client";
import { useCanMutate } from "~/lib/data/offline-mutations";

const INSTRUCTIONS: Record<
  OnboardingInstruction,
  { selector: string; text: string; next?: boolean }
> = {
  "add-feed": {
    selector: '[data-onboarding="add-feed"]',
    text: "Add a Feed to bring its new posts into Serial.",
  },
  "find-feed": {
    selector: '[data-onboarding="find-feed"]',
    text: "Paste www.serial.tube and add Serial Releases.",
  },
  "save-feed": {
    selector: '[data-onboarding="save-feed"]',
    text: "Save your Feed to finish adding it.",
  },
  "feed-added": {
    selector: "[data-onboarding-feed]",
    text: "Your Feed is ready. New posts will appear here.",
    next: true,
  },
  "open-menu": {
    selector: '[data-onboarding="open-menu"]',
    text: "Open the menu to create a View.",
  },
  "add-view": {
    selector: '[data-onboarding="add-view"]',
    text: "Views bring together the Feeds and Bookmarks you choose.",
  },
  "name-view": {
    selector: '[data-onboarding="name-view"]',
    text: "Give your View a name, then choose Next.",
    next: true,
  },
  "choose-feed": {
    selector: 'button[aria-label="Add feeds"]',
    text: "Click + and select Serial Releases to include it in this View.",
  },
  "open-display": {
    selector: '[data-onboarding="open-display"]',
    text: "Open Display to explore how your View looks.",
  },
  "explore-display": {
    selector: '[data-onboarding="explore-display"]',
    text: "Choose a layout, or add sections organized by Feed or Tag. Try the controls, or keep the defaults.",
    next: true,
  },
  "save-view": {
    selector: '[data-onboarding="save-view"]',
    text: "Save your View when you are ready.",
  },
  "view-added": {
    selector: '[data-onboarding="open-menu"]',
    text: "Your View is ready. You can find it in the menu.",
    next: true,
  },
};

const PRESETS = [
  { name: "Rose", hue: 350, saturation: 35 },
  { name: "Amber", hue: 35, saturation: 45 },
  { name: "Olive", hue: 70, saturation: 30 },
  { name: "Forest", hue: 145, saturation: 30 },
  { name: "Teal", hue: 185, saturation: 35 },
  { name: "Blue", hue: 220, saturation: 40 },
  { name: "Violet", hue: 275, saturation: 35 },
  { name: "Slate", hue: 220, saturation: 8 },
];

function ThemePicker() {
  const run = useOnboarding((state) => state.run);
  const [selected, setSelected] = useState(0);
  const save = useMutation(
    orpc.userConfig.setThemePair.mutationOptions({
      onSuccess: () =>
        advanceSavedOnboardingStep(run, "choose-colors", "add-feed"),
      onError: () =>
        toast.error("Couldn't save your colors. Please try again."),
    }),
  );
  const preset = PRESETS[selected]!;
  function choose(index: number) {
    setSelected(index);
    const choice = PRESETS[index]!;
    for (const mode of ["light", "dark"]) {
      document.documentElement.style.setProperty(
        `--${mode}-hue`,
        `${choice.hue}`,
      );
      document.documentElement.style.setProperty(
        `--${mode}-sat`,
        `${choice.saturation}%`,
      );
      document.documentElement.style.setProperty(
        `--${mode}-lgt`,
        mode === "light" ? "96%" : "12%",
      );
    }
  }
  return (
    <div className="grid gap-6">
      <div
        className="grid grid-cols-4 gap-3"
        role="group"
        aria-label="Color themes"
      >
        {PRESETS.map((choice, index) => (
          <button
            key={choice.name}
            type="button"
            aria-label={choice.name}
            aria-pressed={index === selected}
            disabled={save.isPending}
            onClick={() => choose(index)}
            className="focus-visible:ring-ring grid gap-2 rounded-md p-1 text-xs focus-visible:ring-2"
          >
            <span
              className="block aspect-square rounded-md border aria-selected:ring-2"
              aria-selected={index === selected}
              style={{
                background: `linear-gradient(135deg, hsl(${choice.hue} ${choice.saturation}% 96%) 50%, hsl(${choice.hue} ${choice.saturation}% 12%) 50%)`,
                outline:
                  index === selected ? "2px solid currentColor" : undefined,
                outlineOffset: 3,
              }}
            />
            {choice.name}
          </button>
        ))}
      </div>
      <Button
        disabled={save.isPending}
        onClick={() => {
          choose(selected);
          save.mutate({
            light: [preset.hue, preset.saturation, 96],
            dark: [preset.hue, preset.saturation, 12],
          });
        }}
      >
        {save.isPending ? "Saving..." : "Next"}
      </Button>
    </div>
  );
}

function SyncSlide() {
  const run = useOnboarding((state) => state.run);
  const status = useQuery(orpc.atproto.getConnectionStatus.queryOptions());
  const reconnect = useAtprotoReconnect();
  const save = useAtprotoSyncSettingsSave(() =>
    advanceSavedOnboardingStep(run, "atmosphere-sync-setup", "next-steps"),
  );
  useEffect(() => {
    if (status.data && !status.data.isConnected && !status.data.needsReconnect)
      advanceOnboarding("next-steps");
  }, [status.data]);
  if (status.isError)
    return (
      <div className="grid gap-4">
        <p>Couldn&apos;t load your Atmosphere connection.</p>
        <Button onClick={() => void status.refetch()}>Retry</Button>
      </div>
    );
  if (!status.data) return <p>Loading your connection...</p>;
  return (
    <div className="grid gap-6">
      {status.data.needsReconnect && (
        <ReconnectBanner
          disabled={reconnect.isPending}
          reconnecting={reconnect.isPending}
          onReconnect={() => reconnect.mutate(undefined)}
        />
      )}
      <AtprotoSyncSettingsForm
        onboarding
        savedPreferences={status.data.syncPreferences}
        hasWriteScope={status.data.hasWriteScope}
        disabled={status.data.needsReconnect}
        saving={save.busy}
        onSave={save.save}
      />
    </div>
  );
}

export function Onboarding() {
  const { data: session } = authClient.useSession();
  return session?.user.id ? (
    <AccountOnboarding key={session.user.id} userId={session.user.id} />
  ) : null;
}

function AccountOnboarding({ userId }: { userId: string }) {
  useEffect(() => () => stopOnboarding(), []);
  const progress = useQuery({
    ...orpc.onboarding.getProgress.queryOptions(),
    queryKey: [...orpc.onboarding.getProgress.queryKey(), userId],
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const initialized = useRef(false);
  const canMutate = useCanMutate();
  const state = useOnboarding();
  const dialog = useDialogStore((value) => value.dialog);
  const sidebar = useSidebar();
  useEffect(() => {
    if (
      !progress.data ||
      !progress.isFetchedAfterMount ||
      progress.isFetching ||
      initialized.current
    )
      return;
    initialized.current = true;
    startOnboarding(
      progress.data,
      (next) =>
        orpcRouterClient.onboarding.saveProgress({ ...next, step: next.step! }),
      userId,
    );
  }, [
    progress.data,
    progress.isFetchedAfterMount,
    progress.isFetching,
    userId,
  ]);
  useEffect(() => {
    if (state.instruction === "add-feed" && dialog === "add-feed")
      guideOnboarding("find-feed");
    if (state.instruction === "add-view" && dialog === "add-view") {
      sidebar.setOpenLeftMobile(false);
      guideOnboarding("name-view");
    }
    if (
      state.instruction === "open-menu" &&
      (sidebar.isMobile ? sidebar.openLeftMobile : sidebar.open)
    )
      guideOnboarding("add-view");
    if (state.instruction === "feed-added" && sidebar.isMobile)
      sidebar.setOpenRightMobile(true);
  }, [state.instruction, dialog, sidebar]);
  useEffect(() => {
    if (state.step !== "atmosphere-sync-setup" || !state.consentResult) return;
    useDialogStore.getState().closeDialog();
    const result = state.consentResult;
    useOnboarding.setState({ consentResult: null, consentResultUserId: null });
    if (result === "success") advanceOnboarding("next-steps");
  }, [state.step, state.consentResult]);

  if (!state.step || !canMutate) return null;
  const instruction = state.instruction
    ? INSTRUCTIONS[state.instruction]
    : null;
  const nextInstruction = () => {
    switch (state.instruction) {
      case "feed-added":
        sidebar.setOpenRightMobile(false);
        guideOnboarding("open-menu");
        break;
      case "name-view":
        if (
          document
            .querySelector<HTMLInputElement>('[data-onboarding="name-view"]')
            ?.value.trim()
        )
          advanceInstruction("name-view", "choose-feed");
        break;
      case "explore-display":
        guideOnboarding("save-view");
        break;
      case "view-added":
        useOnboarding.setState({ instruction: null });
        break;
    }
  };
  const titles = {
    introduction: "Welcome to Serial",
    "choose-colors": "Make yourself at home",
    "add-feed": "Follow your first Feed",
    "create-view": "Create a View",
    "atmosphere-sync-setup": "Your Atmosphere subscriptions",
    "next-steps": "Ready to explore",
  };
  const close = () => {
    if (state.step === "next-steps") finishOnboarding();
    else requestOnboardingSkip();
  };
  return (
    <>
      <ControlledResponsiveDialog
        open={!instruction}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title={titles[state.step]}
      >
        <div className="grid gap-6 py-2">
          {state.step === "introduction" && (
            <>
              <p className="text-muted-foreground">
                Serial is your reader for the old and new web. Follow RSS Feeds
                and Atmosphere publications, and save Bookmarks from anywhere.
              </p>
              <Button onClick={() => advanceOnboarding("choose-colors")}>
                Get started
              </Button>
            </>
          )}
          {state.step === "choose-colors" && (
            <>
              <p className="text-muted-foreground">
                Choose colors for light and dark mode. You can change them in
                Appearance anytime.
              </p>
              <ThemePicker />
            </>
          )}
          {state.step === "add-feed" && (
            <>
              <p className="text-muted-foreground">
                Let&apos;s follow Serial Releases. Copy the website address,
                then paste it into Add Feed.
              </p>
              <Button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText("www.serial.tube");
                    guideOnboarding("add-feed");
                    if (sidebar.isMobile) sidebar.setOpenRightMobile(true);
                  } catch {
                    toast.error("Couldn't copy the address. Please try again.");
                  }
                }}
              >
                <CopyIcon size={16} />
                <span className="pl-1.5">Copy www.serial.tube</span>
              </Button>
            </>
          )}
          {state.step === "atmosphere-sync-setup" && <SyncSlide />}
          {state.step === "next-steps" && (
            <>
              <p className="text-muted-foreground">
                Bring your favorite Feeds with you, or save something new to
                read.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Button
                  variant="outline"
                  className="h-auto flex-col gap-2 py-4"
                  asChild
                >
                  <Link to="/import" onClick={finishOnboarding}>
                    <ImportIcon size={20} />
                    Import Feeds
                  </Link>
                </Button>
                <Button
                  variant="outline"
                  className="h-auto flex-col gap-2 py-4"
                  asChild
                >
                  <a
                    href="https://www.serial.tube/downloads"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <DownloadIcon size={20} />
                    Get the extension
                  </a>
                </Button>
              </div>
              <Button onClick={finishOnboarding}>Done</Button>
            </>
          )}
        </div>
      </ControlledResponsiveDialog>
      {state.step !== "next-steps" && (
        <Guidance
          instructionKey={state.instruction ?? state.step}
          selector={
            state.instruction === "feed-added" && state.feedId
              ? `[data-onboarding-feed="${state.feedId}"]`
              : instruction?.selector
          }
          next={instruction?.next}
          explanation={
            state.instruction === "feed-added" ||
            state.instruction === "view-added"
          }
          onNext={nextInstruction}
          onSkip={requestOnboardingSkip}
          confirming={state.confirmingSkip}
          onCancelSkip={() => useOnboarding.setState({ confirmingSkip: false })}
          onConfirmSkip={() => {
            finishOnboarding();
            useDialogStore.getState().closeDialog();
          }}
        >
          {instruction?.text}
        </Guidance>
      )}
    </>
  );
}
