// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { DiscoveryOption } from "@serial/feed-discovery";
import { FeedDiscoveryCommand } from "~/components/feed-discovery/FeedDiscoveryCommand";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const originalResizeObserver = globalThis.ResizeObserver;
const container = document.createElement("div");
let mounted: ReturnType<typeof createRoot>;
afterEach(() => {
  act(() => mounted?.unmount());
  container.remove();
  globalThis.ResizeObserver = originalResizeObserver;
});
it("keeps the selected row and input focus while source icons and title update", async () => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
  document.body.append(container);
  mounted = createRoot(container);
  const rss: DiscoveryOption = {
    url: "https://example.com/rss",
    title: "RSS name",
    discoveryId: "stable",
    siteUrl: "https://example.com/",
    origins: [{ kind: "rss", locator: "https://example.com/rss" }],
  };
  const props = {
    url: "example.com",
    onUrlChange: vi.fn(),
    onDiscover: vi.fn(),
    onSelectFeed: vi.fn(),
    onSelectBookmark: vi.fn(),
    bookmarkPlatform: "website" as const,
    state: "discovering" as const,
  };
  await act(async () => {
    mounted.render(
      createElement(FeedDiscoveryCommand, { ...props, discoveredFeeds: [rss] }),
    );
  });
  const input = container.querySelector("input")!;
  input.focus();
  const row = container.querySelector('[cmdk-item][data-value="stable"]')!;
  expect(row).not.toBeNull();
  expect(row.getAttribute("data-selected")).toBe("true");
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Finding feeds…",
  );
  expect(row.querySelector('svg[aria-label="RSS"]')).not.toBeNull();
  const combined: DiscoveryOption = {
    ...rss,
    title: "Published name",
    origins: [
      ...rss.origins!,
      {
        kind: "atproto",
        locator: "at://did:plc:example/site.standard.publication/one",
      },
    ],
  };
  await act(async () => {
    mounted.render(
      createElement(FeedDiscoveryCommand, {
        ...props,
        discoveredFeeds: [combined],
      }),
    );
  });
  expect(container.querySelector('[cmdk-item][data-value="stable"]')).toBe(row);
  expect(document.activeElement).toBe(input);
  expect(row.getAttribute("data-selected")).toBe("true");
  expect(row.textContent).toContain("Published name");
  expect(row.querySelector('svg[aria-label="RSS"]')).not.toBeNull();
  expect(row.querySelector('svg[aria-label="Atmosphere"]')).not.toBeNull();
  expect(row.textContent).not.toContain("RSS · Atmosphere");
  act(() => (row as HTMLElement).click());
  expect(props.onSelectFeed).toHaveBeenCalledWith(combined);
});
it("disables an already added feed and lets Enter act only on the highlighted row", async () => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
  document.body.append(container);
  mounted = createRoot(container);
  const added: DiscoveryOption = {
    url: "https://example.com/rss",
    title: "Added feed",
    discoveryId: "added",
    origins: [{ kind: "rss", locator: "https://example.com/rss" }],
  };
  const available: DiscoveryOption = {
    url: "https://example.com/atom",
    title: "Available feed",
    discoveryId: "available",
    origins: [{ kind: "rss", locator: "https://example.com/atom" }],
  };
  const props = {
    url: "example.com",
    onUrlChange: vi.fn(),
    onDiscover: vi.fn(),
    onSelectFeed: vi.fn(),
    onSelectBookmark: vi.fn(),
    bookmarkPlatform: "website" as const,
    state: "select" as const,
    discoveredFeeds: [added, available],
    isFeedAdded: (feed: DiscoveryOption) => feed === added,
  };
  await act(async () => {
    mounted.render(createElement(FeedDiscoveryCommand, props));
  });
  const addedRow = container.querySelector<HTMLElement>(
    '[cmdk-item][data-value="added"]',
  )!;
  const availableRow = container.querySelector<HTMLElement>(
    '[cmdk-item][data-value="available"]',
  )!;
  expect(addedRow.getAttribute("aria-disabled")).toBe("true");
  expect(
    addedRow.querySelector('svg[aria-label="Already added"]'),
  ).not.toBeNull();
  expect(addedRow.querySelector('svg[aria-label="RSS"]')).toBeNull();
  expect(availableRow.getAttribute("aria-disabled")).toBe("false");
  expect(
    availableRow.querySelector('svg[aria-label="Already added"]'),
  ).toBeNull();
  expect(availableRow.querySelector('svg[aria-label="RSS"]')).not.toBeNull();
  act(() => addedRow.click());
  expect(props.onSelectFeed).not.toHaveBeenCalled();
  const input = container.querySelector("input")!;
  const pressEnter = () =>
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
  // The disabled row is never highlighted, so the available row is.
  expect(availableRow.getAttribute("data-selected")).toBe("true");
  pressEnter();
  expect(props.onSelectFeed).toHaveBeenCalledWith(available);
  props.onSelectFeed.mockClear();
  // Only the highlighted row acts. With the sole feed disabled, the Bookmark
  // row is highlighted and Enter saves the bookmark.
  await act(async () => {
    mounted.render(
      createElement(FeedDiscoveryCommand, {
        ...props,
        discoveredFeeds: [added],
      }),
    );
  });
  expect(addedRow.getAttribute("data-selected")).toBe("false");
  pressEnter();
  expect(props.onSelectFeed).not.toHaveBeenCalled();
  expect(props.onSelectBookmark).toHaveBeenCalledWith("https://example.com/");
  // With no highlighted row, Enter does nothing rather than choosing one. cmdk
  // keeps a highlight whenever an enabled row exists, so clear it directly.
  props.onSelectBookmark.mockClear();
  await act(async () => {
    mounted.render(createElement(FeedDiscoveryCommand, props));
  });
  for (const item of container.querySelectorAll("[cmdk-item]")) {
    item.setAttribute("data-selected", "false");
    item.setAttribute("aria-selected", "false");
  }
  expect(availableRow.getAttribute("aria-disabled")).toBe("false");
  pressEnter();
  expect(props.onSelectFeed).not.toHaveBeenCalled();
  expect(props.onSelectBookmark).not.toHaveBeenCalled();
});
