import {
  classifyDiscoveryInput,
  feedDiscoveryKey,
  matchesDiscoveredFeed,
} from "@serial/feed-discovery";
import { PublicationRowContent } from "@serial/ui";
import {
  BookmarkIcon,
  Loader2Icon,
  RefreshCwIcon,
  RssIcon,
  SearchIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  normalizeFeedSearchUrl,
  STATIC_FEED_SEARCH_OPTIONS,
} from "./feedSearchOptions";
import type { ReactNode, Ref } from "react";
import type { DiscoveredFeed } from "./FeedDiscoveryResults";
import type { StaticFeedSearchOption } from "./feedSearchOptions";
import type { ContentPlatform } from "~/lib/content/descriptor";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/components/ui/command";

const CENTERED_STATE_CLASS_NAME =
  "text-muted-foreground absolute inset-0 px-6 py-6 text-center sm:flex sm:items-center sm:justify-center";

function CenteredStateContent({
  children,
  testId,
}: {
  children: ReactNode;
  testId: string;
}) {
  return (
    <div
      className="absolute top-1/3 left-1/2 flex w-[calc(100%-3rem)] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3 sm:static sm:w-auto sm:translate-x-0 sm:translate-y-0"
      data-testid={testId}
    >
      {children}
    </div>
  );
}

function StaticFeedResult({
  option,
  onSelect,
}: {
  option: StaticFeedSearchOption;
  onSelect: (option: StaticFeedSearchOption) => void;
}) {
  return (
    <CommandItem
      className="gap-2"
      value={`${option.label} ${option.url}`}
      keywords={option.keywords}
      onSelect={() => onSelect(option)}
    >
      <RssIcon className="text-muted-foreground size-4" />
      <div className="min-w-0">
        <p className="truncate">{option.label}</p>
        <p className="text-muted-foreground truncate text-xs">
          {option.description ?? option.url}
        </p>
      </div>
    </CommandItem>
  );
}

function SuggestedFeedResults({
  query = "",
  onSelect,
}: {
  query?: string;
  onSelect: (option: StaticFeedSearchOption) => void;
}) {
  const options = STATIC_FEED_SEARCH_OPTIONS.filter((option) =>
    [option.label, ...(option.keywords ?? [])]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  if (!options.length) return null;
  return (
    <CommandGroup heading="Suggested feeds">
      {options.map((option) => (
        <StaticFeedResult
          key={option.url}
          option={option}
          onSelect={onSelect}
        />
      ))}
    </CommandGroup>
  );
}

interface FeedDiscoveryCommandProps {
  url: string;
  onUrlChange: (url: string) => void;
  onDiscover: (url?: string) => void;
  onSelectFeed: (feed: DiscoveredFeed) => void;
  onSelectBookmark: (url: string) => void;
  bookmarkPlatform: ContentPlatform;
  discoveredFeeds: DiscoveredFeed[];
  state: "input" | "discovering" | "no-results" | "select" | "adding";
  inputRef?: Ref<HTMLInputElement>;
  loadingLabel?: string;
}

const AUTO_DISCOVERY_DELAY_MS = 500;
const BOOKMARK_ACTION_LABEL: Record<ContentPlatform, string> = {
  website: "Bookmark page to read later",
  youtube: "Bookmark video to watch later",
  peertube: "Bookmark video to watch later",
  nebula: "Bookmark video to watch later",
};

function FeedResults({
  query,
  visible,
  retry,
  feeds,
  onDiscover,
  onSelect,
}: {
  query: string;
  visible: boolean;
  retry: boolean;
  feeds: DiscoveredFeed[];
  onDiscover: () => void;
  onSelect: (feed: DiscoveredFeed) => void;
}) {
  return (
    <CommandGroup heading="Feeds" className={visible ? undefined : "hidden"}>
      {retry && (
        <CommandItem
          className="gap-2"
          value={`Retry finding feeds ${query}`}
          onSelect={onDiscover}
        >
          <span className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded">
            <RefreshCwIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate">Retry finding feeds</p>
            <p className="text-muted-foreground truncate text-xs">
              No feeds found.
            </p>
          </div>
        </CommandItem>
      )}
      {feeds.map((feed) => (
        <CommandItem
          className="gap-2"
          key={feedDiscoveryKey(feed)}
          data-onboarding="feed-result"
          value={feedDiscoveryKey(feed)}
          onSelect={() => onSelect(feed)}
        >
          <PublicationRowContent feed={feed} />
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function BookmarkResult({
  url,
  platform,
  visible,
  onSelect,
}: {
  url: string;
  platform: ContentPlatform;
  visible: boolean;
  onSelect: (url: string) => void;
}) {
  return (
    <CommandGroup heading="Bookmark" className={visible ? undefined : "hidden"}>
      {visible && (
        <CommandItem
          className="gap-2"
          value={`${BOOKMARK_ACTION_LABEL[platform]} ${url}`}
          onSelect={() => onSelect(url)}
        >
          <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded">
            <BookmarkIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate">{BOOKMARK_ACTION_LABEL[platform]}</p>
            <p className="text-muted-foreground truncate text-xs">{url}</p>
          </div>
        </CommandItem>
      )}
    </CommandGroup>
  );
}

function useAutomaticDiscovery(
  query: string | null,
  state: FeedDiscoveryCommandProps["state"],
  onDiscover: () => void,
) {
  const [lastQuery, setLastQuery] = useState<string | null>(null);
  const isPending =
    query !== null &&
    state !== "discovering" &&
    state !== "select" &&
    lastQuery !== query;
  const canDiscover = state === "input" || state === "no-results";
  useEffect(() => {
    if (!query || !canDiscover || lastQuery === query) return;
    const timeout = window.setTimeout(() => {
      setLastQuery(query);
      onDiscover();
    }, AUTO_DISCOVERY_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [query, canDiscover, lastQuery, onDiscover]);
  return { isPending, reset: () => setLastQuery(null) };
}

function DiscoveryProgress({
  state,
  hasResults,
  pending,
  loadingLabel,
}: {
  state: FeedDiscoveryCommandProps["state"];
  hasResults: boolean;
  pending: boolean;
  loadingLabel: string;
}) {
  const adding = state === "adding";
  if (!adding && state !== "discovering" && !pending) return null;
  if (!adding && hasResults)
    return (
      <div
        className="text-muted-foreground flex items-center gap-2 px-4 py-2 text-xs"
        role="status"
      >
        <Loader2Icon className="size-4 animate-spin" />
        <span>Finding feeds…</span>
      </div>
    );
  return (
    <div className={CENTERED_STATE_CLASS_NAME} role="status" aria-live="polite">
      <CenteredStateContent testId="feed-discovery-loading-state">
        <Loader2Icon className="size-8 animate-spin" strokeWidth={1.5} />
        <span>{adding ? loadingLabel : "Finding feeds…"}</span>
      </CenteredStateContent>
    </div>
  );
}

export function FeedDiscoveryCommand({
  url,
  onUrlChange,
  onDiscover,
  onSelectFeed,
  onSelectBookmark,
  bookmarkPlatform,
  discoveredFeeds,
  state,
  inputRef,
  loadingLabel = "Adding feed…",
}: FeedDiscoveryCommandProps) {
  const commandRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{
    value: string;
    feed?: DiscoveredFeed;
  }>({ value: "" });
  const selectedFeed = selection.feed
    ? discoveredFeeds.find((feed) =>
        matchesDiscoveredFeed(feed, selection.feed!),
      )
    : undefined;
  const normalizedUrl = classifyDiscoveryInput(url) ? url.trim() : null;
  const bookmarkUrl = normalizeFeedSearchUrl(url);
  const isAddingFeed = state === "adding";
  const isDiscovering = state === "discovering";
  const hasNoResults = state === "no-results";
  const isSelecting =
    state === "select" || (isDiscovering && discoveredFeeds.length > 0);
  const { isPending: isAutoDiscoveryPending, reset: resetAutoDiscovery } =
    useAutomaticDiscovery(normalizedUrl, state, onDiscover);

  useEffect(() => {
    if (!isSelecting) return;

    const animationFrame = window.requestAnimationFrame(() => {
      commandRef.current
        ?.querySelector<HTMLInputElement>("[cmdk-input]")
        ?.focus();
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [isSelecting]);

  return (
    <Command
      ref={commandRef}
      value={selectedFeed ? feedDiscoveryKey(selectedFeed) : selection.value}
      onValueChange={(value) =>
        setSelection({
          value,
          feed: discoveredFeeds.find(
            (feed) => feedDiscoveryKey(feed) === value,
          ),
        })
      }
      className="h-full min-h-0 rounded-none border-0 sm:h-auto [&_[cmdk-input-wrapper]_svg]:size-5 [&_[cmdk-input]]:pr-10 sm:[&_[cmdk-input]]:pr-0 [&_[cmdk-item]]:pointer-events-auto [&_[cmdk-item]]:opacity-100"
      shouldFilter={
        !isAddingFeed &&
        !isDiscovering &&
        !isSelecting &&
        !isAutoDiscoveryPending
      }
    >
      <CommandInput
        ref={inputRef}
        value={url}
        onValueChange={(nextUrl) => {
          resetAutoDiscovery();
          onUrlChange(nextUrl);
        }}
        className="h-14 text-base"
        placeholder="Paste a URL or search for a feed..."
        disabled={isAddingFeed}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !isSelecting || isAddingFeed) return;

          const command = event.currentTarget.closest("[cmdk-root]");
          const selectedItem =
            command?.querySelector<HTMLElement>(
              '[cmdk-item][data-selected="true"]',
            ) ?? command?.querySelector<HTMLElement>("[cmdk-item]");

          if (selectedItem) {
            event.preventDefault();
            selectedItem.click();
          }
        }}
      />
      <CommandList className="relative flex max-h-none min-h-0 flex-1 flex-col sm:max-h-[min(60dvh,32rem,calc(100dvh-5.5rem))] sm:min-h-[min(20rem,60dvh,calc(100dvh-5.5rem))] sm:flex-none">
        {normalizedUrl ? (
          <>
            {!bookmarkUrl && (
              <SuggestedFeedResults
                query={url}
                onSelect={(selected) => onDiscover(selected.url)}
              />
            )}
            <FeedResults
              query={normalizedUrl}
              visible={isSelecting || hasNoResults}
              retry={hasNoResults}
              feeds={discoveredFeeds}
              onDiscover={() => onDiscover()}
              onSelect={onSelectFeed}
            />
            <DiscoveryProgress
              state={state}
              hasResults={isSelecting}
              pending={isAutoDiscoveryPending}
              loadingLabel={loadingLabel}
            />
            {bookmarkUrl && (
              <BookmarkResult
                url={bookmarkUrl}
                platform={bookmarkPlatform}
                visible={isSelecting || hasNoResults}
                onSelect={onSelectBookmark}
              />
            )}
          </>
        ) : (
          <>
            <CommandEmpty className={CENTERED_STATE_CLASS_NAME}>
              <CenteredStateContent testId="feed-discovery-empty-state">
                <SearchIcon className="size-8" strokeWidth={1.5} />
                <span>Enter a website, channel, or RSS feed URL.</span>
              </CenteredStateContent>
            </CommandEmpty>
            <SuggestedFeedResults
              onSelect={(selected) => onDiscover(selected.url)}
            />
          </>
        )}
      </CommandList>
    </Command>
  );
}
