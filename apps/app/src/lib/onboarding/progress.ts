export const ONBOARDING_VERSION = "2026-09-16";
export const ONBOARDING_STEPS = [
  "introduction",
  "choose-colors",
  "add-feed",
  "create-view",
  "atmosphere-sync-setup",
  "next-steps",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type OnboardingProgress = { complete: boolean; step: string | null };

export function savedOnboardingStep(step: OnboardingStep) {
  return `${ONBOARDING_VERSION}-${step}`;
}
export function resumeOnboarding(
  progress: OnboardingProgress,
): OnboardingStep | null {
  if (progress.complete) return null;
  return (
    ONBOARDING_STEPS.find(
      (step) => savedOnboardingStep(step) === progress.step,
    ) ?? "introduction"
  );
}

/** Ordered, coalesced writes never hold up the local journey. Failure leaves the last saved step intact. */
export function createProgressWriter(
  write: (progress: OnboardingProgress) => Promise<unknown>,
) {
  let pending: OnboardingProgress | undefined;
  let writing = false;
  async function flush() {
    if (writing) return;
    writing = true;
    while (pending) {
      const next = pending;
      pending = undefined;
      try {
        await write(next);
      } catch {
        /* A later visit resumes the last successful write. */
      }
    }
    writing = false;
  }
  return Object.assign(
    (progress: OnboardingProgress) => {
      pending = progress;
      void flush();
    },
    {
      cancel: () => {
        pending = undefined;
      },
    },
  );
}
