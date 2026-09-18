// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { feedDiscoveryKey } from "@serial/feed-discovery";
import { useFeedDiscovery } from "~/components/feed-discovery/useFeedDiscovery";
import { orpcRouterClient } from "~/lib/orpc";

vi.mock("~/lib/orpc", () => ({
  orpcRouterClient: { feed: { discoverFeedsStream: vi.fn() } },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const rss = {
  url: "https://example.com/rss",
  siteUrl: "https://example.com/",
  title: "RSS name",
  origins: [{ kind: "rss" as const, locator: "https://example.com/rss" }],
};
const combined = {
  ...rss,
  title: "Publication name",
  origins: [
    ...rss.origins,
    {
      kind: "atproto" as const,
      locator: "at://did:plc:example/site.standard.publication/one",
    },
  ],
};
let api: ReturnType<typeof useFeedDiscovery>;
let root: ReturnType<typeof createRoot>;
function mount() {
  function Harness() {
    api = useFeedDiscovery();
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Harness)));
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  act(() => root?.unmount());
  vi.clearAllMocks();
});

it("displays early RSS and waits for completed origins before resolving selection", async () => {
  const finish = deferred();
  vi.mocked(orpcRouterClient.feed.discoverFeedsStream).mockImplementationOnce(
    async () =>
      (async function* () {
        yield { feeds: [rss], complete: false };
        await finish.promise;
        yield { feeds: [combined], complete: true };
      })(),
  );
  mount();
  let discovery: Promise<void>;
  await act(async () => {
    discovery = api.discoverFeeds("example.com");
  });
  expect(api.discoveredFeeds).toMatchObject([rss]);
  expect(api.isDiscovering).toBe(true);
  const key = feedDiscoveryKey(api.discoveredFeeds[0]!);
  const selected = vi.fn();
  const selection = api.finishSelection(api.discoveredFeeds[0]!).then(selected);
  expect(selected).not.toHaveBeenCalled();
  await act(async () => {
    finish.resolve();
    await discovery!;
    await selection;
  });
  expect(selected).toHaveBeenCalledWith(expect.objectContaining(combined));
  expect(feedDiscoveryKey(api.discoveredFeeds[0]!)).toBe(key);
  expect(api.isDiscovering).toBe(false);
});

it("cancels on close and rejects a pending Add even if an obsolete stream still emits", async () => {
  const finish = deferred();
  let signal: AbortSignal | undefined;
  vi.mocked(orpcRouterClient.feed.discoverFeedsStream).mockImplementationOnce(
    async (_, options) => {
      signal = options?.signal;
      return (async function* () {
        yield { feeds: [rss], complete: false };
        await finish.promise;
        yield { feeds: [combined], complete: true };
      })();
    },
  );
  mount();
  let discovery: Promise<void>;
  await act(async () => {
    discovery = api.discoverFeeds("example.com");
  });
  const selection = api.finishSelection(rss).catch((error: unknown) => error);
  act(() => api.reset());
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    finish.resolve();
    await discovery!;
  });
  expect(await selection).toBeInstanceOf(Error);
  expect(api.discoveredFeeds).toEqual([]);
  expect(api.discoveryState).toBe("input");
});

it("rejects selection when transport ends without a completion event", async () => {
  vi.mocked(orpcRouterClient.feed.discoverFeedsStream).mockImplementationOnce(
    async () =>
      (async function* () {
        yield { feeds: [rss], complete: false };
      })(),
  );
  mount();
  await act(async () => {
    await api.discoverFeeds("example.com");
  });
  await expect(api.finishSelection(rss)).rejects.toThrow("interrupted");
});

it("resolves an early RSS selection to a later preferred syndication format", async () => {
  const atom = {
    ...rss,
    url: "https://example.com/atom",
    origins: [
      {
        kind: "rss" as const,
        locator: "https://example.com/atom",
        alternateUrls: [rss.url],
      },
    ],
  };
  const finish = deferred();
  vi.mocked(orpcRouterClient.feed.discoverFeedsStream).mockImplementationOnce(
    async () =>
      (async function* () {
        yield { feeds: [rss], complete: false };
        await finish.promise;
        yield { feeds: [atom], complete: true };
      })(),
  );
  mount();
  let discovery: Promise<void>;
  await act(async () => {
    discovery = api.discoverFeeds("example.com");
  });
  const selection = api.finishSelection(rss);
  await act(async () => {
    finish.resolve();
    await discovery!;
  });
  expect(await selection).toMatchObject(atom);
  expect(feedDiscoveryKey(api.discoveredFeeds[0]!)).toBe(rss.url);
});

it("keeps Publications at the same site distinct after one gains RSS", async () => {
  const first = {
    ...combined,
    url: rss.siteUrl,
    origins: [combined.origins[1]!],
  };
  const second = {
    ...first,
    title: "Other Publication",
    origins: [
      {
        kind: "atproto" as const,
        locator: "at://did:plc:example/site.standard.publication/two",
      },
    ],
  };
  const finish = deferred();
  vi.mocked(orpcRouterClient.feed.discoverFeedsStream).mockImplementationOnce(
    async () =>
      (async function* () {
        yield { feeds: [first, second], complete: false };
        await finish.promise;
        yield { feeds: [combined, second], complete: true };
      })(),
  );
  mount();
  let discovery: Promise<void>;
  await act(async () => {
    discovery = api.discoverFeeds("@example.com");
  });
  const keys = api.discoveredFeeds.map(feedDiscoveryKey);
  const selection = api.finishSelection(second);
  await act(async () => {
    finish.resolve();
    await discovery!;
  });
  expect(api.discoveredFeeds.map(feedDiscoveryKey)).toEqual(keys);
  expect(new Set(keys).size).toBe(2);
  expect(await selection).toMatchObject(second);
});

it("replacing a search cancels its pending selection and ignores late results", async () => {
  const finish = deferred();
  let signal: AbortSignal | undefined;
  vi.mocked(orpcRouterClient.feed.discoverFeedsStream)
    .mockImplementationOnce(async (_, options) => {
      signal = options?.signal;
      return (async function* () {
        yield { feeds: [rss], complete: false };
        await finish.promise;
        yield { feeds: [combined], complete: true };
      })();
    })
    .mockImplementationOnce(async () =>
      (async function* () {
        yield { feeds: [], complete: true };
      })(),
    );
  mount();
  let first: Promise<void>;
  await act(async () => {
    first = api.discoverFeeds("example.com");
  });
  const selection = api.finishSelection(rss).catch((error: unknown) => error);
  act(() => api.handleUrlChange("other.example"));
  await act(async () => {
    await api.discoverFeeds("other.example");
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    finish.resolve();
    await first!;
  });
  expect(await selection).toBeInstanceOf(Error);
  expect(api.url).toBe("other.example");
  expect(api.discoveredFeeds).toEqual([]);
  expect(api.discoveryState).toBe("no-results");
});
