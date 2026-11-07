// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApplicationFeed,
  ApplicationFeedOrigin,
} from "~/server/db/schema";
import { feedsStore } from "~/lib/data/feeds/store";
import {
  useIsFeedRevalidating,
  useRevalidateFeedMutation,
} from "~/lib/data/feeds/mutations";

const { revalidate } = vi.hoisted(() => ({ revalidate: vi.fn() }));

vi.mock("~/lib/orpc", () => ({
  orpc: {
    feed: {
      revalidate: {
        mutationOptions: (options: Record<string, unknown>) => ({
          mutationFn: revalidate,
          ...options,
        }),
      },
    },
  },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const NOW = new Date("2026-09-16T12:00:00.000Z");
const roots: Array<ReturnType<typeof createRoot>> = [];
const clients: QueryClient[] = [];

function origin(
  id: number,
  kind: ApplicationFeedOrigin["kind"],
  locator: string,
): ApplicationFeedOrigin {
  return {
    id,
    feedId: 1,
    userId: "user",
    kind,
    locator,
    lastFetchedAt: null,
    nextFetchAt: null,
    sourceName: null,
    sourceImageUrl: null,
    sourceDescription: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function feed(origins: ApplicationFeedOrigin[]): ApplicationFeed {
  return {
    id: 1,
    userId: "user",
    name: "Original",
    imageUrl: "",
    platform: "website",
    openLocation: "serial",
    createdAt: NOW,
    updatedAt: NOW,
    isActive: true,
    siteUrl: "https://example.com",
    nameEditedAt: null,
    origins,
  };
}

type RevalidationHook = ReturnType<typeof useRevalidateFeedMutation>;
const mounted: Array<{ mutation: RevalidationHook; pending: boolean }> = [];

function Harness() {
  const mutation = useRevalidateFeedMutation();
  const pending = useIsFeedRevalidating(1);
  mounted.push({ mutation, pending });
  return null;
}

async function renderHooks() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  clients.push(client);
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  await act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Harness),
        createElement(Harness),
      ),
    );
  });
}

beforeEach(() => {
  mounted.length = 0;
  feedsStore.getState().reset();
  feedsStore.getState().add(feed([origin(1, "rss", "https://old.test/rss")]));
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const client of clients.splice(0)) client.clear();
  vi.resetAllMocks();
});

describe("Feed revalidation client state", () => {
  it("shares pending state and sends only one same-Feed request", async () => {
    let resolve!: (value: ApplicationFeed) => void;
    revalidate.mockReturnValue(
      new Promise<ApplicationFeed>((done) => {
        resolve = done;
      }),
    );
    await renderHooks();
    const [first, second] = mounted;

    act(() => {
      first!.mutation.mutate({ feedId: 1 });
      second!.mutation.mutate({ feedId: 1 });
    });
    await act(async () => {
      await vi.waitFor(() => expect(revalidate).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(mounted.slice(-2).map(({ pending }) => pending)).toEqual([
          true,
          true,
        ]),
      );
      resolve(feed([origin(1, "rss", "https://new.test/rss")]));
    });
  });

  it("does not let a stale response remove an origin added meanwhile", async () => {
    const rss = origin(1, "rss", "https://old.test/rss");
    const publication = origin(
      2,
      "atproto",
      "at://did:plc:example/site.standard.publication/example",
    );
    let resolve!: (value: ApplicationFeed) => void;
    revalidate.mockReturnValue(
      new Promise<ApplicationFeed>((done) => {
        resolve = done;
      }),
    );
    await renderHooks();
    const request = mounted[0]!.mutation.mutateAsync({ feedId: 1 });
    await vi.waitFor(() => expect(revalidate).toHaveBeenCalledOnce());
    feedsStore.getState().update(1, { origins: [rss, publication] });

    await act(async () => {
      resolve(feed([rss]));
      await request;
    });

    expect(feedsStore.getState().feedsDict[1]!.origins).toEqual([
      rss,
      publication,
    ]);
  });
});
