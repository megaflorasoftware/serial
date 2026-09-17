import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CopyIcon, DownloadIcon, ImportIcon } from "lucide-react";
import { toast } from "sonner";
import { Guidance } from "./Guidance";
import { WelcomeDrawing } from "./WelcomeDrawing";
import type { OnboardingInstruction } from "~/lib/onboarding/store";
import { ColorModeToggleGroup } from "~/components/color-theme/ColorModeToggleGroup";
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
import { Input } from "~/components/ui/input";
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
  {
    selector: string;
    anchorSelector?: string;
    hideWhenSelector?: string;
    text: string | string[];
    next?: boolean;
    highlightDialog?: boolean;
    interactiveDialog?: boolean;
  }
> = {
  "open-feed-menu": {
    selector: '[data-onboarding="open-menu"]',
    text: "Let's start by adding your first feed. Open the menu to add one.",
  },
  "add-feed": {
    selector: '[data-onboarding="add-feed"]',
    text: "Here's where you add a feed. Feeds are the parts of the web that you want to bring into Serial.",
  },
  "find-feed": {
    hideWhenSelector:
      '[data-onboarding="find-feed"] [data-onboarding="feed-result"]',
    anchorSelector:
      '[data-onboarding="find-feed"] [cmdk-input], [data-onboarding="find-feed"] [role="option"]',
    selector: '[data-onboarding="find-feed"]',
    text: "Enter a website address, then choose a feed to follow.",
  },
  "save-feed": {
    highlightDialog: true,
    selector: '[data-onboarding="save-feed"]',
    text: "Save your feed to finish adding it.",
  },
  "feed-added": {
    selector: '[data-onboarding="feed-content"]',
    text: "Your feed is added! Your content in Serial is viewable through this main pane.",
    next: true,
  },
  "open-menu": {
    selector: '[data-onboarding="open-menu"]',
    text: "Open the menu to create a view.",
  },
  "add-view": {
    selector: '[data-onboarding="add-view"]',
    text: [
      "Now, let's add a view.",
      "Views enable you to group your feeds in a way that makes sense to you.",
    ],
  },
  "name-view": {
    highlightDialog: true,
    selector: '[data-onboarding="name-view"]',
    text: "Give your view a name, then choose Next.",
    next: true,
  },
  "choose-feed": {
    highlightDialog: true,
    selector: 'button[aria-label="Add feeds"]',
    text: "Click + and select your feed to include it in this view.",
  },
  "open-display": {
    highlightDialog: true,
    selector: '[data-onboarding="open-display"]',
    text: "Open Display to explore how your view looks.",
  },
  "explore-display": {
    highlightDialog: true,
    anchorSelector: '[role="dialog"]:has([data-onboarding="open-display"])',
    interactiveDialog: true,
    selector: '[data-onboarding="open-display"]',
    text: [
      "Here, you can organize your feeds into sections to display them exactly how you want. Each section can have its own layout.",
      'When you\'re ready, click "Add View" to move on.',
    ],
  },
  "view-chips": {
    selector: '[data-onboarding="view-chips"]',
    text: [
      "Your view is added!",
      "You can swap between each of your views here.",
      'Feeds that aren\'t a part of any view will show up in "Uncategorized".',
    ],
    next: true,
  },
};

function SuggestedWebsite() {
  return (
    <>
      <p className="text-muted-foreground">
        Not sure where to start? Try following Serial to stay up-to-date with
        new improvements.
      </p>
      <div className="flex gap-2">
        <Input
          aria-label="Suggested website"
          value="www.serial.tube"
          readOnly
          className="flex-1"
        />
        <Button
          variant="outline"
          size="icon"
          className="shrink-0"
          aria-label="Copy website address"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText("www.serial.tube");
              toast.success("Website address copied.");
            } catch {
              toast.error("Couldn't copy the address. Please try again.");
            }
          }}
        >
          <CopyIcon size={16} />
        </Button>
      </div>
    </>
  );
}

const PRESETS: Array<{
  name: string;
  light: [number, number, number];
  dark: [number, number, number];
}> = [
  { name: "Default", light: [60, 10, 100], dark: [60, 10, 15] },
  ...[
    { name: "Amber", hue: 35, saturation: 45 },
    { name: "Olive", hue: 70, saturation: 30 },
    { name: "Forest", hue: 145, saturation: 30 },
    { name: "Teal", hue: 185, saturation: 35 },
    { name: "Blue", hue: 220, saturation: 40 },
    { name: "Violet", hue: 275, saturation: 35 },
    { name: "Slate", hue: 220, saturation: 8 },
  ].map(({ name, hue, saturation }) => ({
    name,
    light: [hue, saturation, 96] as [number, number, number],
    dark: [hue, saturation, 12] as [number, number, number],
  })),
];

function themeColor([hue, saturation, lightness]: [number, number, number]) {
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

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
    for (const mode of ["light", "dark"] as const) {
      const [hue, saturation, lightness] = choice[mode];
      document.documentElement.style.setProperty(`--${mode}-hue`, `${hue}`);
      document.documentElement.style.setProperty(
        `--${mode}-sat`,
        `${saturation}%`,
      );
      document.documentElement.style.setProperty(
        `--${mode}-lgt`,
        `${lightness}%`,
      );
    }
  }
  return (
    <div className="grid gap-6">
      <div
        className="grid grid-cols-4 gap-3 md:grid-cols-8"
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
              className="block h-12 rounded-md border aria-selected:ring-2"
              aria-selected={index === selected}
              style={{
                background: `linear-gradient(135deg, ${themeColor(choice.light)} 50%, ${themeColor(choice.dark)} 50%)`,
                outline:
                  index === selected ? "2px solid currentColor" : undefined,
                outlineOffset: 3,
              }}
            />
            {choice.name}
          </button>
        ))}
      </div>
      <p className="text-muted-foreground">
        Pick a theme to get started! Don&apos;t worry about getting it perfect
        now, as it&apos;s fully customizable later.
      </p>
      <Button
        disabled={save.isPending}
        onClick={() => {
          choose(selected);
          save.mutate({
            light: preset.light,
            dark: preset.dark,
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
    if (
      state.instruction === "open-feed-menu" &&
      (sidebar.isMobile ? sidebar.openRightMobile : sidebar.open)
    )
      guideOnboarding("add-feed");
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
      sidebar.setOpenRightMobile(false);
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
      case "view-chips":
        useOnboarding.setState({ instruction: null });
        break;
    }
  };
  const titles = {
    introduction: "Welcome to Serial!",
    "choose-colors": "Customize appearance",
    "add-feed": "Follow your first feed",
    "create-view": "Create a view",
    "atmosphere-sync-setup": "Your Atmosphere subscriptions",
    "next-steps": "That's it!",
  };
  const close = () => {
    if (state.step === "next-steps") finishOnboarding();
    else requestOnboardingSkip();
  };
  const bookend = state.step === "introduction" || state.step === "next-steps";
  return (
    <>
      <ControlledResponsiveDialog
        hideClose={bookend}
        titleClassName={bookend ? "text-xl" : undefined}
        headerClassName={bookend ? "text-center sm:text-center" : undefined}
        previewDrawer={state.step === "choose-colors"}
        open={!instruction}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title={titles[state.step]}
        headerRight={
          state.step === "choose-colors" ? (
            <div className="shrink-0">
              <ColorModeToggleGroup />
            </div>
          ) : undefined
        }
      >
        <div className="grid gap-6 py-2">
          {state.step === "introduction" && (
            <>
              <WelcomeDrawing />
              <p className="text-center text-lg">
                Serial lets you follow RSS feeds, subscribe to Atmosphere
                publications, and save bookmarks from anywhere on the web.
              </p>
              <Button onClick={() => advanceOnboarding("choose-colors")}>
                Get started
              </Button>
            </>
          )}
          {state.step === "choose-colors" && <ThemePicker />}
          {state.step === "atmosphere-sync-setup" && <SyncSlide />}
          {state.step === "next-steps" && (
            <>
              <div className="grid grid-cols-2 gap-3">
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
                <Button
                  variant="outline"
                  className="h-auto flex-col gap-2 py-4"
                  asChild
                >
                  <Link to="/import" onClick={finishOnboarding}>
                    <ImportIcon size={20} />
                    Import feeds
                  </Link>
                </Button>
              </div>
              <p className="text-center text-base">
                Next, add our extension to save bookmarks as you browse the web,
                or import feeds from YouTube or your previous RSS reader.
              </p>
              <Button onClick={finishOnboarding}>Done</Button>
            </>
          )}
        </div>
      </ControlledResponsiveDialog>
      {state.step !== "next-steps" && (
        <Guidance
          instructionKey={state.instruction ?? state.step}
          selector={
            state.instruction === "open-feed-menu" && sidebar.isMobile
              ? '[data-onboarding="open-feed-menu"]'
              : instruction?.selector
          }
          anchorSelector={instruction?.anchorSelector}
          hideWhenSelector={instruction?.hideWhenSelector}
          highlightDialog={instruction?.highlightDialog}
          interactiveDialog={instruction?.interactiveDialog}
          dimmed={false}
          next={instruction?.next}
          explanation={
            state.instruction === "feed-added" ||
            state.instruction === "view-chips"
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
          {instruction && (
            <>
              <div className="grid gap-3">
                {(Array.isArray(instruction.text)
                  ? instruction.text
                  : [instruction.text]
                ).map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
              {state.instruction === "find-feed" && <SuggestedWebsite />}
            </>
          )}
        </Guidance>
      )}
    </>
  );
}
