// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Toaster } from "~/components/ui/sonner";
import {
  advanceOnboarding,
  finishOnboarding,
  requestOnboardingSkip,
  startOnboarding,
  stopOnboarding,
} from "~/lib/onboarding/store";

vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("~/hooks/use-mobile", () => ({ useIsMobile: () => false }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  stopOnboarding();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(createElement(Toaster)));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  stopOnboarding();
  toast.dismiss();
  vi.useRealTimers();
});

async function flushNotifications() {
  await act(() => vi.advanceTimersByTimeAsync(30));
}
function startTutorial() {
  act(() =>
    startOnboarding({ complete: false, step: null }, () => Promise.resolve()),
  );
}

it("drops existing and tutorial notifications through the final slide, then resumes", async () => {
  toast.success("Before tutorial");
  await flushNotifications();
  expect(container.textContent).toContain("Before tutorial");

  startTutorial();
  toast.success("Feed added");
  toast.error("Tutorial error");
  toast.loading("Tutorial loading");
  toast.promise(Promise.resolve(), {
    loading: "Saving",
    success: "Saved during tutorial",
    error: "Failed",
  });
  await flushNotifications();
  expect(container.querySelector("[data-sonner-toaster]")).toBeNull();

  act(() => advanceOnboarding("next-steps"));
  await flushNotifications();
  expect(container.querySelector("[data-sonner-toaster]")).toBeNull();

  act(() => finishOnboarding());
  await flushNotifications();
  expect(container.querySelectorAll("[data-sonner-toast]")).toHaveLength(0);
  toast.success("After tutorial");
  await flushNotifications();
  expect(container.textContent).toContain("After tutorial");
});

it("keeps skip confirmation quiet and allows results emitted after the confirmed skip", async () => {
  startTutorial();
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  toast.promise(pending, {
    loading: "Pending during tutorial",
    success: "Finished after skip",
    error: "Failed",
  });
  act(() => requestOnboardingSkip());
  await flushNotifications();
  expect(container.querySelector("[data-sonner-toaster]")).toBeNull();

  act(() => finishOnboarding());
  await flushNotifications();
  expect(container.querySelectorAll("[data-sonner-toast]")).toHaveLength(0);
  resolve();
  await flushNotifications();
  expect(container.textContent).toContain("Finished after skip");
});

it("keeps notifications enabled for accounts that already completed onboarding", async () => {
  act(() =>
    startOnboarding({ complete: true, step: null }, () => Promise.resolve()),
  );
  toast.error("Ordinary error");
  await flushNotifications();
  expect(container.textContent).toContain("Ordinary error");
});
