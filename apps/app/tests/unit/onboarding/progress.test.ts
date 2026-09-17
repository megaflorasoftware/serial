import { describe, expect, it, vi } from "vitest";
import {
  createProgressWriter,
  resumeOnboarding,
  savedOnboardingStep,
} from "~/lib/onboarding/progress";
import {
  advanceInstruction,
  advanceOnboarding,
  advanceSavedOnboardingStep,
  feedCreatedDuringOnboarding,
  feedSavedDuringOnboarding,
  finishOnboarding,
  isOnboardingFeedSelection,
  recordOnboardingConsentResult,
  startOnboarding,
  stopOnboarding,
  useOnboarding,
  viewSavedDuringOnboarding,
} from "~/lib/onboarding/store";

describe("onboarding progress", () => {
  it("resumes only current-version major steps and keeps completed accounts complete", () => {
    expect(
      resumeOnboarding({
        complete: false,
        step: savedOnboardingStep("create-view"),
      }),
    ).toBe("create-view");
    expect(
      resumeOnboarding({ complete: false, step: "2026-09-15-create-view" }),
    ).toBe("introduction");
    expect(resumeOnboarding({ complete: false, step: null })).toBe(
      "introduction",
    );
    expect(resumeOnboarding({ complete: true, step: "old" })).toBeNull();
  });
  it("advances immediately while writes wait, coalesces them, and continues after failure", async () => {
    let reject!: (reason?: unknown) => void;
    const write = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(undefined);
    const queue = createProgressWriter(write);
    queue({ complete: false, step: "first" });
    queue({ complete: false, step: "second" });
    queue({ complete: true, step: "last" });
    expect(write).toHaveBeenCalledTimes(1);
    reject(new Error("offline"));
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write).toHaveBeenLastCalledWith({ complete: true, step: "last" });
  });
  it("persists save boundaries before explanatory Next and keeps transient artifacts out of recovery", () => {
    const write = vi.fn().mockReturnValue(new Promise(() => {}));
    startOnboarding(
      { complete: false, step: savedOnboardingStep("add-feed") },
      write,
    );
    useOnboarding.setState({ instruction: "find-feed" });
    feedCreatedDuringOnboarding(123);
    expect(write).not.toHaveBeenCalled();
    feedSavedDuringOnboarding();
    expect(useOnboarding.getState()).toMatchObject({
      step: "create-view",
      instruction: "feed-added",
      feedId: 123,
    });
    expect(write).toHaveBeenCalledWith({
      complete: false,
      step: savedOnboardingStep("create-view"),
    });
    startOnboarding(
      { complete: false, step: savedOnboardingStep("create-view") },
      write,
    );
    expect(useOnboarding.getState()).toMatchObject({
      instruction: "open-menu",
      feedId: null,
    });
    useOnboarding.setState({ instruction: "explore-display" });
    viewSavedDuringOnboarding();
    expect(useOnboarding.getState()).toMatchObject({
      step: "atmosphere-sync-setup",
      instruction: "view-chips",
    });
  });
  it("pauses blur advancement during skip confirmation and advances a helper exactly once", () => {
    startOnboarding(
      { complete: false, step: savedOnboardingStep("create-view") },
      vi.fn().mockResolvedValue(undefined),
    );
    useOnboarding.setState({ instruction: "name-view", confirmingSkip: true });
    advanceInstruction("name-view", "choose-feed");
    expect(useOnboarding.getState().instruction).toBe("name-view");
    useOnboarding.setState({ confirmingSkip: false });
    advanceInstruction("name-view", "choose-feed");
    advanceInstruction("name-view", "choose-feed");
    expect(useOnboarding.getState().instruction).toBe("choose-feed");
  });
  it("completes locally at final-screen arrival or confirmed skip without waiting for storage", () => {
    startOnboarding(
      { complete: false, step: null },
      () => new Promise(() => {}),
    );
    advanceOnboarding("next-steps");
    expect(useOnboarding.getState().step).toBe("next-steps");
    finishOnboarding();
    expect(useOnboarding.getState().step).toBeNull();
  });
  it("keeps an auth return for the same account and drops it on account change", () => {
    recordOnboardingConsentResult("success");
    startOnboarding(
      {
        complete: false,
        step: savedOnboardingStep("atmosphere-sync-setup"),
      },
      vi.fn().mockResolvedValue(undefined),
      "one",
    );
    stopOnboarding();
    expect(useOnboarding.getState().consentResult).toBe("success");

    startOnboarding(
      {
        complete: false,
        step: savedOnboardingStep("atmosphere-sync-setup"),
      },
      vi.fn().mockResolvedValue(undefined),
      "two",
    );
    expect(useOnboarding.getState().consentResult).toBeNull();

    recordOnboardingConsentResult("success");
    stopOnboarding();
    startOnboarding(
      {
        complete: false,
        step: savedOnboardingStep("atmosphere-sync-setup"),
      },
      vi.fn().mockResolvedValue(undefined),
      "three",
    );
    expect(useOnboarding.getState().consentResult).toBeNull();
  });
  it("ignores a consent result outside the saved sync step", () => {
    startOnboarding(
      { complete: false, step: savedOnboardingStep("create-view") },
      vi.fn().mockResolvedValue(undefined),
      "one",
    );
    recordOnboardingConsentResult("success");
    expect(useOnboarding.getState().consentResult).toBeNull();
  });
});

it("ignores a late artifact save after skip or a new onboarding run", () => {
  const write = vi.fn().mockResolvedValue(undefined);
  startOnboarding(
    { complete: false, step: savedOnboardingStep("choose-colors") },
    write,
  );
  const originalRun = useOnboarding.getState().run;
  finishOnboarding();
  advanceSavedOnboardingStep(originalRun, "choose-colors", "add-feed");
  expect(useOnboarding.getState().step).toBeNull();
  startOnboarding(
    { complete: false, step: savedOnboardingStep("choose-colors") },
    write,
  );
  advanceSavedOnboardingStep(originalRun, "choose-colors", "add-feed");
  expect(useOnboarding.getState().step).toBe("choose-colors");
});
it("requires the current journey's Feed but never searches for artifacts on resume", () => {
  startOnboarding(
    { complete: false, step: savedOnboardingStep("create-view") },
    vi.fn().mockResolvedValue(undefined),
  );
  useOnboarding.setState({ instruction: "choose-feed", feedId: 123 });
  expect(isOnboardingFeedSelection(123)).toBe(true);
  expect(isOnboardingFeedSelection(456)).toBe(false);
  startOnboarding(
    { complete: false, step: savedOnboardingStep("create-view") },
    vi.fn().mockResolvedValue(undefined),
  );
  useOnboarding.setState({ instruction: "choose-feed" });
  expect(isOnboardingFeedSelection(456)).toBe(true);
});
