// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBulkFeedEditing } from "~/components/feed/manage/useBulkFeedEditing";

const { revalidation, idle } = vi.hoisted(() => ({
  revalidation: {
    mutateAsync: vi.fn(() => Promise.resolve()),
    isPending: false,
  },
  idle: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("sonner", () => ({ toast: { promise: vi.fn() } }));
vi.mock("~/lib/data/feeds/mutations", () => ({
  useBulkDeleteFeedsMutation: idle,
  useBulkSetActiveMutation: idle,
  useBulkRevalidateFeedsMutation: () => revalidation,
}));
vi.mock("~/lib/data/feed-categories/mutations", () => ({
  useBulkAssignFeedCategoryMutation: idle,
  useBulkRemoveFeedCategoryMutation: idle,
}));
vi.mock("~/lib/data/view-feeds/mutations", () => ({
  useBulkAssignViewFeedMutation: idle,
  useBulkRemoveViewFeedMutation: idle,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot>;
function revalidateSelection() {
  let editing: ReturnType<typeof useBulkFeedEditing> | undefined;
  function Harness() {
    editing = useBulkFeedEditing({
      canMutate: true,
      feeds: [],
      selectedFeedIds: new Set([1, 2]),
      setSelectedFeedIds: vi.fn(),
      feedCategoriesMap: new Map(),
      feedViewsMap: new Map(),
      activeFeeds: 0,
      maxActiveFeeds: 10,
      launchDialog: vi.fn(),
    });
    return null;
  }
  const container = document.createElement("div");
  root = createRoot(container);
  act(() => root.render(createElement(Harness)));
  act(() => editing!.handleRevalidate());
}

beforeEach(() => {
  vi.clearAllMocks();
  revalidation.isPending = false;
});
afterEach(() => act(() => root.unmount()));

it("queues the selection with one toast and keeps the selection", () => {
  revalidateSelection();
  expect(revalidation.mutateAsync).toHaveBeenCalledExactlyOnceWith({
    feedIds: [1, 2],
  });
  expect(toast.promise).toHaveBeenCalledExactlyOnceWith(expect.any(Promise), {
    success: "Revalidating 2 feeds in the background",
    error: "Failed to revalidate feeds",
  });
});

it("sends nothing and shows no toast while a revalidation is pending", () => {
  revalidation.isPending = true;
  revalidateSelection();
  expect(revalidation.mutateAsync).not.toHaveBeenCalled();
  expect(toast.promise).not.toHaveBeenCalled();
});
