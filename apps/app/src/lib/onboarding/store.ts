import { create } from "zustand";
import {
  createProgressWriter,
  resumeOnboarding,
  savedOnboardingStep,
} from "./progress";
import type { OnboardingProgress, OnboardingStep } from "./progress";

export type OnboardingInstruction =
  | "open-feed-menu"
  | "add-feed"
  | "find-feed"
  | "save-feed"
  | "feed-added"
  | "open-menu"
  | "add-view"
  | "name-view"
  | "choose-feed"
  | "open-display"
  | "explore-display"
  | "view-chips";

type State = {
  run: number;
  activeUserId: string | null;
  step: OnboardingStep | null;
  instruction: OnboardingInstruction | null;
  confirmingSkip: boolean;
  feedId: number | null;
  consentResult: string | null;
  consentResultUserId: string | null;
};
const initial: State = {
  run: 0,
  activeUserId: null,
  step: null,
  instruction: null,
  confirmingSkip: false,
  feedId: null,
  consentResult: null,
  consentResultUserId: null,
};
export const useOnboarding = create<State>(() => initial);
let persist: ReturnType<typeof createProgressWriter> | undefined;

function initialInstruction(
  step: OnboardingStep | null,
): OnboardingInstruction | null {
  if (step === "create-view") return "open-menu";
  if (step === "add-feed") return "open-feed-menu";
  return null;
}

export function startOnboarding(
  progress: OnboardingProgress,
  write: (progress: OnboardingProgress) => Promise<unknown>,
  userId?: string,
) {
  persist?.cancel();
  persist = createProgressWriter(write);
  const step = resumeOnboarding(progress);
  const current = useOnboarding.getState();
  const keepConsentResult =
    step === "atmosphere-sync-setup" &&
    !!current.consentResult &&
    (!current.consentResultUserId || current.consentResultUserId === userId);
  useOnboarding.setState({
    ...initial,
    run: current.run + 1,
    activeUserId: userId ?? null,
    consentResult: keepConsentResult ? current.consentResult : null,
    consentResultUserId: keepConsentResult ? (userId ?? null) : null,
    step,
    instruction: initialInstruction(step),
  });
  if (step === "next-steps") advanceOnboarding(step);
}
export function advanceOnboarding(
  step: OnboardingStep,
  instruction: OnboardingInstruction | null = initialInstruction(step),
) {
  if (!useOnboarding.getState().step) return;
  useOnboarding.setState({ step, instruction });
  persist?.({
    complete: step === "next-steps",
    step: savedOnboardingStep(step),
  });
}
export function guideOnboarding(instruction: OnboardingInstruction) {
  if (useOnboarding.getState().step) useOnboarding.setState({ instruction });
}
export function advanceInstruction(
  from: OnboardingInstruction,
  to: OnboardingInstruction,
) {
  const state = useOnboarding.getState();
  if (state.instruction === from && !state.confirmingSkip) guideOnboarding(to);
}
export function requestOnboardingSkip() {
  if (
    !useOnboarding.getState().step ||
    useOnboarding.getState().step === "next-steps"
  )
    return false;
  useOnboarding.setState({ confirmingSkip: true });
  return true;
}
export function finishOnboarding() {
  persist?.({ complete: true, step: savedOnboardingStep("next-steps") });
  useOnboarding.setState({ ...initial, run: useOnboarding.getState().run + 1 });
}
export function feedCreatedDuringOnboarding(id: number) {
  if (useOnboarding.getState().instruction !== "find-feed") return;
  useOnboarding.setState({ feedId: id, instruction: "save-feed" });
}
export function feedSavedDuringOnboarding() {
  if (useOnboarding.getState().instruction === "save-feed")
    advanceOnboarding("create-view", "feed-added");
}
export function viewSavedDuringOnboarding() {
  if (useOnboarding.getState().instruction === "explore-display")
    advanceOnboarding("atmosphere-sync-setup", "view-chips");
}

export function stopOnboarding() {
  persist?.cancel();
  persist = undefined;
  const current = useOnboarding.getState();
  useOnboarding.setState({
    ...initial,
    run: current.run + 1,
    consentResult: current.consentResult,
    consentResultUserId: current.consentResultUserId,
  });
}

export function recordOnboardingConsentResult(result: string) {
  const current = useOnboarding.getState();
  if (current.activeUserId && current.step !== "atmosphere-sync-setup") return;
  useOnboarding.setState({
    consentResult: result,
    consentResultUserId: current.activeUserId,
  });
}

export function advanceSavedOnboardingStep(
  run: number,
  from: OnboardingStep,
  to: OnboardingStep,
) {
  const current = useOnboarding.getState();
  if (current.run === run && current.step === from) advanceOnboarding(to);
}
export function isOnboardingFeedSelection(id: number) {
  const current = useOnboarding.getState();
  return (
    current.instruction === "choose-feed" &&
    (current.feedId === null || current.feedId === id)
  );
}
