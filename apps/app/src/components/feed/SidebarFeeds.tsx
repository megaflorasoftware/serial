import { Link } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  AlertCircleIcon,
  CircleSmall,
  Edit2Icon,
  MinusIcon,
  OrbitIcon,
  PauseIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { Skeleton } from "../ui/skeleton";
import { useDialogStore } from "./dialogStore";
import type { ApplicationFeed } from "~/server/db/schema";
import type { NavigationSnapshot } from "~/server/navigation/snapshot";
import { EditFeedDialog } from "~/components/AddFeedDialog";
import { ButtonWithShortcut } from "~/components/ButtonWithShortcut";
import { Input } from "~/components/ui/input";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "~/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  categoryFilterAtom,
  contentStatusFilterAtom,
  dateFilterAtom,
  feedFilterAtom,
  viewFilterAtom,
} from "~/lib/data/atoms";
import { useFeeds } from "~/lib/data/feeds";
import { useFeedStatus } from "~/lib/data/store";
import {
  getNavigationAvailability,
  useNavigationSnapshot,
  useNavigationSnapshotStatus,
} from "~/lib/data/navigation/store";
import { isContentStatusAvailable } from "~/lib/content-status";
import { useCanMutate } from "~/lib/data/offline-mutations";

import { getFeedPublicationName } from "~/lib/feeds/origins";

function useDebouncedState(defaultValue: string, delay: number) {
  const [searchQuery, setSearchQuery] = useState(defaultValue);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const setDebouncedQuery = useCallback(
    (newValue: string, forceUpdate = false) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      if (forceUpdate) {
        setSearchQuery(newValue);
      } else {
        timeoutRef.current = setTimeout(() => {
          setSearchQuery(newValue);
        }, delay);
      }
    },
    [delay],
  );

  return [searchQuery, setDebouncedQuery] as const;
}

function sortFeedOptions(a: ApplicationFeed, b: ApplicationFeed) {
  return a.name.localeCompare(b.name);
}

function PublicationGlyph({ name }: { name?: string }) {
  if (name === undefined) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <OrbitIcon size={16} className="ml-auto shrink-0" aria-label={name} />
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}

const EMPTY_FEED_AVAILABILITY: NavigationSnapshot["feeds"] = {};

type FeedOption = ApplicationFeed & {
  hasEntries: boolean;
  belongsToCurrentView: boolean;
  hasEntriesInCurrentView: boolean;
};

// Memoized with primitive props and id-keyed callbacks so a store update that
// touches one feed re-renders one row, not the whole list.
const ActiveFeedSidebarItem = memo(function ActiveFeedSidebarItemContent({
  feedId,
  name,
  publicationName,
  hasEntries,
  isSelected,
  onSelect,
  onEdit,
}: {
  feedId: number;
  name: string;
  publicationName?: string;
  hasEntries: boolean;
  isSelected: boolean;
  onSelect: (feedId: number) => void;
  onEdit: (feedId: number) => void;
}) {
  const feedStatus = useFeedStatus(feedId);
  const isSuccess = feedStatus === "success" || feedStatus === "skipped";

  return (
    <SidebarMenuItem data-onboarding-feed={feedId} className="group flex gap-1">
      <SidebarMenuButton
        variant={isSelected ? "outline" : "default"}
        onClick={() => onSelect(feedId)}
      >
        {feedStatus === "error" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertCircleIcon size={16} className="text-sidebar-accent" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-center">
              Something went wrong fetching content for this feed. If this
              continues, try deleting this feed and adding it again with the
              correct URL.
            </TooltipContent>
          </Tooltip>
        )}
        {feedStatus === "empty" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <MinusIcon size={16} className="text-sidebar-accent" />
            </TooltipTrigger>
            <TooltipContent>
              This feed has no new content within the last 30 days.
            </TooltipContent>
          </Tooltip>
        )}
        {isSuccess && !hasEntries && (
          <CircleSmall size={16} className="text-sidebar-accent" />
        )}
        {isSuccess && hasEntries && (
          <div className="grid size-4 place-items-center">
            <div className="bg-sidebar-accent size-2.5 rounded-full" />
          </div>
        )}
        <div className="line-clamp-1">{name}</div>
        <PublicationGlyph name={publicationName} />
      </SidebarMenuButton>
      <div className="group/button flex w-fit items-center justify-end">
        <SidebarMenuButton onClick={() => onEdit(feedId)}>
          <Edit2Icon className="opacity-30 transition-opacity group-hover/button:opacity-100" />
        </SidebarMenuButton>
      </div>
    </SidebarMenuItem>
  );
});

const InactiveFeedSidebarItem = memo(function InactiveFeedSidebarItemContent({
  feedId,
  name,
  publicationName,
  hasEntries,
  isSelected,
  onSelect,
  onEdit,
}: {
  feedId: number;
  name: string;
  publicationName?: string;
  hasEntries: boolean;
  isSelected: boolean;
  onSelect: (feedId: number) => void;
  onEdit: (feedId: number) => void;
}) {
  return (
    <SidebarMenuItem className="group flex gap-1 opacity-50">
      <SidebarMenuButton
        variant={isSelected ? "outline" : "default"}
        onClick={() => onSelect(feedId)}
      >
        {!hasEntries && (
          <CircleSmall size={16} className="text-sidebar-accent" />
        )}
        {hasEntries && (
          <div className="grid size-4 place-items-center">
            <div className="bg-sidebar-accent size-2.5 rounded-full" />
          </div>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <PauseIcon size={16} className="text-muted-foreground" />
          </TooltipTrigger>
          <TooltipContent>
            This feed is inactive and won&apos;t receive new content.
          </TooltipContent>
        </Tooltip>
        <div className="text-muted-foreground line-clamp-1">{name}</div>
        <PublicationGlyph name={publicationName} />
      </SidebarMenuButton>
      <div className="group/button flex w-fit items-center justify-end">
        <SidebarMenuButton onClick={() => onEdit(feedId)}>
          <Edit2Icon className="opacity-30 transition-opacity group-hover/button:opacity-100" />
        </SidebarMenuButton>
      </div>
    </SidebarMenuItem>
  );
});

function groupFeedOptions(feedOptions: FeedOption[]) {
  const preferredFeedOptionsWithEntries: FeedOption[] = [];
  const preferredFeedOptionsWithoutEntries: FeedOption[] = [];
  const otherActiveFeedOptions: FeedOption[] = [];
  const inactiveFeedOptions: FeedOption[] = [];

  for (const feedOption of feedOptions) {
    // Inactive feeds always go to the inactive section
    if (!feedOption.isActive) {
      inactiveFeedOptions.push(feedOption);
    } else if (feedOption.hasEntriesInCurrentView) {
      preferredFeedOptionsWithEntries.push(feedOption);
    } else if (feedOption.belongsToCurrentView) {
      preferredFeedOptionsWithoutEntries.push(feedOption);
    } else {
      otherActiveFeedOptions.push(feedOption);
    }
  }
  preferredFeedOptionsWithEntries.sort(sortFeedOptions);
  preferredFeedOptionsWithoutEntries.sort(sortFeedOptions);
  otherActiveFeedOptions.sort(sortFeedOptions);
  inactiveFeedOptions.sort(sortFeedOptions);

  return {
    // Combine preferred options: feeds with entries first, then feeds matching view but without entries
    preferredFeedOptions: [
      ...preferredFeedOptionsWithEntries,
      ...preferredFeedOptionsWithoutEntries,
    ],
    otherActiveFeedOptions,
    inactiveFeedOptions,
  };
}

export function SidebarFeeds() {
  const canMutate = useCanMutate();
  const [searchQuery, setSearchQuery] = useDebouncedState("", 300);

  const [selectedFeedForEditing, setSelectedFeedForEditing] = useState<
    null | number
  >(null);

  const { feeds } = useFeeds();
  const launchDialog = useDialogStore((store) => store.launchDialog);

  const setDateFilter = useSetAtom(dateFilterAtom);
  const [feedFilter, setFeedFilter] = useAtom(feedFilterAtom);
  const categoryFilter = useAtomValue(categoryFilterAtom);
  const viewFilter = useAtomValue(viewFilterAtom);
  const contentStatusFilter = useAtomValue(contentStatusFilterAtom);
  const navigationSnapshot = useNavigationSnapshot();
  const navigationSnapshotStatus = useNavigationSnapshotStatus();
  const currentViewFeedAvailability = useMemo(
    () =>
      viewFilter
        ? (navigationSnapshot.viewFeeds[viewFilter.id] ??
          EMPTY_FEED_AVAILABILITY)
        : EMPTY_FEED_AVAILABILITY,
    [navigationSnapshot, viewFilter],
  );
  const selectFeed = useCallback(
    (feedId: number) => setFeedFilter(feedId),
    [setFeedFilter],
  );
  const editFeed = useCallback(
    (feedId: number) => setSelectedFeedForEditing(feedId),
    [],
  );

  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const { preferredFeedOptions, otherActiveFeedOptions, inactiveFeedOptions } =
    useMemo(
      () =>
        groupFeedOptions(
          feeds
            .filter(
              (feed) =>
                !normalizedSearchQuery ||
                feed.name.toLocaleLowerCase().includes(normalizedSearchQuery),
            )
            .map((feed) => ({
              ...feed,
              hasEntries: isContentStatusAvailable(
                getNavigationAvailability(navigationSnapshot.feeds, feed.id),
                contentStatusFilter,
              ),
              belongsToCurrentView: feed.id in currentViewFeedAvailability,
              hasEntriesInCurrentView: isContentStatusAvailable(
                getNavigationAvailability(currentViewFeedAvailability, feed.id),
                contentStatusFilter,
              ),
            })),
        ),
      [
        feeds,
        normalizedSearchQuery,
        navigationSnapshot,
        contentStatusFilter,
        currentViewFeedAvailability,
      ],
    );

  if (navigationSnapshotStatus !== "success") {
    return (
      <div>
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel className="pr-0 pb-2">
            <span className="inline-block flex-1">Feeds</span>
            <div className="flex w-fit items-center justify-end">
              <SidebarMenuButton asChild>
                <Link to="/feeds">
                  <SettingsIcon size={16} />
                </Link>
              </SidebarMenuButton>
              <SidebarMenuButton
                asChild
                onClick={() => launchDialog("add-feed")}
              >
                <ButtonWithShortcut
                  disabled={!canMutate}
                  shortcut="a"
                  variant="ghost"
                  data-onboarding="add-feed"
                  aria-label="Add Feed or Bookmark"
                >
                  <PlusIcon />
                </ButtonWithShortcut>
              </SidebarMenuButton>
            </div>
          </SidebarGroupLabel>
          <div className="flex flex-col items-center gap-4 px-2 py-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        </SidebarGroup>
      </div>
    );
  }

  const hasAnyItems = Object.values(navigationSnapshot.feeds).some(
    (availability) =>
      isContentStatusAvailable(availability, contentStatusFilter),
  );

  return (
    <>
      <EditFeedDialog
        selectedFeedId={selectedFeedForEditing}
        onClose={() => setSelectedFeedForEditing(null)}
      />
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel className="pr-0 pb-2">
          <span className="inline-block">Feeds</span>
          <div className="flex flex-1 items-center justify-end">
            <SidebarMenuButton size="default-icon" asChild>
              <Link to="/feeds">
                <SettingsIcon size={16} />
              </Link>
            </SidebarMenuButton>
            <SidebarMenuButton
              size="default-icon"
              data-onboarding="add-feed"
              aria-label="Add Feed or Bookmark"
              disabled={!canMutate}
              onClick={() => launchDialog("add-feed")}
            >
              <PlusIcon />
            </SidebarMenuButton>
          </div>
        </SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem className="my-2">
            <Input
              placeholder="Search for feed"
              onBlur={(e) => {
                setSearchQuery(e.target.value, true);
              }}
              onChange={(e) => {
                setSearchQuery(e.target.value);
              }}
            />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              variant={feedFilter === -1 ? "outline" : "default"}
              onClick={() => {
                setFeedFilter(-1);
                if (!viewFilter && categoryFilter < 0) {
                  setDateFilter(1);
                }
              }}
            >
              {!hasAnyItems && (
                <CircleSmall size={16} className="text-sidebar-accent" />
              )}
              {hasAnyItems && (
                <div className="grid size-4 place-items-center">
                  <div className="bg-sidebar-accent size-2.5 rounded-full" />
                </div>
              )}
              All
            </SidebarMenuButton>
          </SidebarMenuItem>
          {preferredFeedOptions.map((feed) => (
            <ActiveFeedSidebarItem
              key={feed.id}
              feedId={feed.id}
              name={feed.name}
              publicationName={getFeedPublicationName(feed)}
              hasEntries={feed.hasEntries}
              isSelected={feed.id === feedFilter}
              onSelect={selectFeed}
              onEdit={editFeed}
            />
          ))}
          {!!preferredFeedOptions.length && !!otherActiveFeedOptions.length && (
            <hr className="my-2 opacity-50" />
          )}
          {otherActiveFeedOptions.map((feed) => (
            <ActiveFeedSidebarItem
              key={feed.id}
              feedId={feed.id}
              name={feed.name}
              publicationName={getFeedPublicationName(feed)}
              hasEntries={feed.hasEntries}
              isSelected={feed.id === feedFilter}
              onSelect={selectFeed}
              onEdit={editFeed}
            />
          ))}
          {inactiveFeedOptions.length > 0 && (
            <>
              {(preferredFeedOptions.length > 0 ||
                otherActiveFeedOptions.length > 0) && (
                <hr className="my-2 opacity-50" />
              )}
              {inactiveFeedOptions.map((feed) => (
                <InactiveFeedSidebarItem
                  key={feed.id}
                  feedId={feed.id}
                  name={feed.name}
                  publicationName={getFeedPublicationName(feed)}
                  hasEntries={feed.hasEntries}
                  isSelected={feed.id === feedFilter}
                  onSelect={selectFeed}
                  onEdit={editFeed}
                />
              ))}
            </>
          )}
        </SidebarMenu>
      </SidebarGroup>
    </>
  );
}
