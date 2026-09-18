import { useCallback, useEffect, useRef, useState } from "react";
import {
  classifyDiscoveryInput,
  feedDiscoveryKey,
  matchesDiscoveredFeed,
} from "@serial/feed-discovery";
import type { DiscoveredFeed, DiscoveryOption } from "@serial/feed-discovery";
import { orpcRouterClient } from "~/lib/orpc";

type DiscoveryState = "input" | "discovering" | "no-results" | "select";
type Search = {
  controller: AbortController;
  feeds: DiscoveryOption[];
  completion: Promise<boolean>;
};

export function useFeedDiscovery() {
  const active = useRef<Search | null>(null);
  const [url, setUrl] = useState("");
  const [discoveryState, setDiscoveryState] = useState<DiscoveryState>("input");
  const [discoveredFeeds, setDiscoveredFeeds] = useState<DiscoveryOption[]>([]);
  const cancel = useCallback(() => {
    active.current?.controller.abort();
    active.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  const handleUrlChange = useCallback(
    (newUrl: string) => {
      cancel();
      setUrl(newUrl);
      setDiscoveryState("input");
      setDiscoveredFeeds([]);
    },
    [cancel],
  );
  const reset = useCallback(() => handleUrlChange(""), [handleUrlChange]);
  const discoverFeeds = useCallback(
    async (urlOverride?: string) => {
      const requestedUrl = urlOverride ?? url;
      if (!classifyDiscoveryInput(requestedUrl)) return;
      cancel();
      const search: Search = {
        controller: new AbortController(),
        feeds: [],
        completion: Promise.resolve(false),
      };
      active.current = search;
      setDiscoveryState("discovering");
      setUrl(requestedUrl);
      setDiscoveredFeeds([]);
      search.completion = (async () => {
        let complete = false;
        try {
          const stream = await orpcRouterClient.feed.discoverFeedsStream(
            { url: requestedUrl.trim() },
            { signal: search.controller.signal },
          );
          for await (const event of stream) {
            if (active.current !== search) return false;
            search.feeds = event.feeds.map((feed) => {
              const previous = search.feeds.find((row) =>
                matchesDiscoveredFeed(row, feed),
              );
              return {
                ...feed,
                discoveryId: feedDiscoveryKey(previous ?? feed),
              };
            });
            complete = event.complete;
            setDiscoveredFeeds(search.feeds);
            setDiscoveryState(
              complete
                ? search.feeds.length
                  ? "select"
                  : "no-results"
                : "discovering",
            );
          }
        } catch {
          // A partial stream is usable for display, but cannot complete an Add.
        }
        if (active.current === search)
          setDiscoveryState(search.feeds.length ? "select" : "no-results");
        return complete;
      })();
      await search.completion;
    },
    [url, cancel],
  );
  const finishSelection = useCallback(async (feed: DiscoveredFeed) => {
    const search = active.current;
    if (
      !search ||
      !(await search.completion) ||
      active.current !== search ||
      search.controller.signal.aborted
    )
      throw new Error("Feed discovery was interrupted. Please search again.");
    const completed = search.feeds.find((row) =>
      matchesDiscoveredFeed(row, feed),
    );
    if (!completed)
      throw new Error("This Feed is no longer available. Please search again.");
    return completed;
  }, []);
  return {
    url,
    discoveryState,
    discoveredFeeds,
    isDiscovering: discoveryState === "discovering",
    hasNoResults: discoveryState === "no-results",
    isSelecting: discoveryState === "select" || discoveredFeeds.length > 0,
    discoverFeeds,
    finishSelection,
    handleUrlChange,
    reset,
  };
}
