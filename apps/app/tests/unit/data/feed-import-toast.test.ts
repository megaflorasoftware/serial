import { expect, it, vi } from "vitest";
import { importFeedItemsWithToast } from "~/lib/data/feeds/mutations";

const mocks = vi.hoisted(() => ({ promise: vi.fn() }));
vi.mock("sonner", () => ({ toast: mocks }));
vi.mock("~/lib/orpc", () => ({ orpc: {} }));

const feed = { id: 7, name: "Leaflet Lab Notes" };

it("wraps the item import in a toast keyed by the Feed with no success copy", async () => {
  const importing = Promise.resolve();
  const fetchItems = vi.fn(() => importing);
  await expect(importFeedItemsWithToast(feed, fetchItems)).resolves.toBe(
    undefined,
  );
  expect(fetchItems).toHaveBeenCalledWith(7);
  const [promise, options] = mocks.promise.mock.calls[0]!;
  expect(promise).toBe(importing);
  expect(options).toMatchObject({
    id: "feed-import:7",
    loading: "Importing items from Leaflet Lab Notes…",
  });
  expect(options.success).toBeUndefined();
});

it("shows the import error message, with a fallback for unknown failures", () => {
  importFeedItemsWithToast(feed, () => Promise.resolve());
  const { error } = mocks.promise.mock.calls.at(-1)![1];
  expect(error(new Error("Publication is unavailable"))).toBe(
    "Publication is unavailable",
  );
  expect(error("boom")).toBe(
    "Something went wrong importing items from Leaflet Lab Notes.",
  );
});
