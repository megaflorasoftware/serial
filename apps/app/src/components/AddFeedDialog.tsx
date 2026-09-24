import { ToggleGroup } from "@radix-ui/react-toggle-group";
import {
  CheckIcon,
  ExternalLinkIcon,
  OrbitIcon,
  RefreshCwIcon,
  RssIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "@tanstack/react-router";
import { FeedDiscoveryCommand } from "./feed-discovery/FeedDiscoveryCommand";
import { useFeedDiscovery } from "./feed-discovery/useFeedDiscovery";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import { ControlledResponsiveDialog } from "./ui/responsive-dropdown";
import { SelectableChipList } from "./ui/selectable-chip-list";
import { Switch } from "./ui/switch";
import { ToggleGroupItem } from "./ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import type { DiscoveredFeed } from "@serial/feed-discovery";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type {
  ApplicationFeed,
  ApplicationView,
  FeedOpenLocation,
} from "~/server/db/schema";
import type { ContentPlatform } from "~/lib/content/descriptor";
import type { BookmarkSaveResult } from "~/server/bookmarks/contracts";
import type { ApplicationBookmark } from "~/server/mixed-content/projection";
import { useVisualViewport } from "~/lib/hooks/useVisualViewport";
import {
  feedCreatedDuringOnboarding,
  feedSavedDuringOnboarding,
  requestOnboardingSkip,
  useOnboarding,
} from "~/lib/onboarding/store";
import { useFeedCategories } from "~/lib/data/feed-categories";
import { useFeeds } from "~/lib/data/feeds";
import {
  useCreateFeedMutation,
  useDeleteFeedMutation,
  useEditFeedMutation,
  useImportFeedItems,
  useIsFeedRevalidating,
  useRevalidateFeedMutation,
  useSetFeedActiveMutation,
} from "~/lib/data/feeds/mutations";
import { PLATFORM_TO_FORMATTED_NAME_MAP } from "~/lib/data/feeds/utils";
import { useShortcut } from "~/lib/hooks/useShortcut";
import { useDialogStore } from "~/components/feed/dialogStore";
import { useViews } from "~/lib/data/views";
import { useViewFeeds } from "~/lib/data/view-feeds";
import { UNCATEGORIZED_VIEW_ID } from "~/lib/data/views/constants";
import { useContentCategories } from "~/lib/data/content-categories";
import { useCreateContentCategoryMutation } from "~/lib/data/content-categories/mutations";
import { useQuickCreateViewMutation } from "~/lib/data/views/mutations";
import { VIEW_LAYOUT_ITEM_TYPE } from "~/server/db/constants";
import { getAssumedFeedPlatform } from "~/server/rss/validateFeedUrl";
import { useSaveBookmarkMutation } from "~/lib/data/bookmarks/mutations";
import { BookmarkOrganizationEditor } from "~/components/bookmarks/BookmarkOrganizationEditor";
import { useCanMutate } from "~/lib/data/offline-mutations";
import {
  getAtmosphereOrigin,
  getFeedRssUrl,
  getFeedWebsiteUrl,
  isDiscoveredFeedAdded,
} from "~/lib/feeds/origins";

function useViewOptions() {
  const { views } = useViews();
  return views
    .filter((v) => v.id !== UNCATEGORIZED_VIEW_ID)
    .map((v) => ({ id: v.id, label: v.name }));
}

function toggleSelectedId(
  selectedIds: number[],
  setSelectedIds: (ids: number[]) => void,
  id: number,
) {
  setSelectedIds(
    selectedIds.includes(id)
      ? selectedIds.filter((selectedId) => selectedId !== id)
      : [...selectedIds, id],
  );
}

export function AddFeedDialog() {
  const canMutate = useCanMutate();
  const [pendingAction, setPendingAction] = useState<
    "feed" | "bookmark" | null
  >(null);
  const [bookmarkFeedback, setBookmarkFeedback] = useState<
    | (BookmarkSaveResult<ApplicationBookmark> & {
        bookmark: ApplicationBookmark;
      })
    | null
  >(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const discovery = useFeedDiscovery();
  const { feeds: addedFeeds } = useFeeds();
  const { mutateAsync: createFeed } = useCreateFeedMutation();
  const importFeedItems = useImportFeedItems();
  const { mutateAsync: saveBookmark } = useSaveBookmarkMutation();

  const dialog = useDialogStore((store) => store.dialog);
  const onDialogOpenChange = useDialogStore((store) => store.onOpenChange);

  // Global "a" shortcut: opens the Add Feed dialog from anywhere except the
  // /views and /tags routes, which register their own "a" shortcuts.
  const launchDialog = useDialogStore((store) => store.launchDialog);
  const location = useLocation();
  useShortcut("a", (event) => {
    if (!canMutate) return;
    if (
      location.pathname.startsWith("/views") ||
      location.pathname.startsWith("/tags")
    ) {
      return;
    }
    event.preventDefault();
    launchDialog("add-feed");
  });

  const onOpenChange = (open = false) => {
    if (!open && requestOnboardingSkip()) return;
    onDialogOpenChange(open);

    if (!open) {
      setPendingAction(null);
      setBookmarkFeedback(null);
      discovery.reset();
    }
  };

  const handleSelectFeed = async (feed: DiscoveredFeed) => {
    if (pendingAction || !canMutate) return;
    setPendingAction("feed");

    const createFeedPromise = discovery
      .finishSelection(feed)
      .then((selection) =>
        createFeed({
          url: selection.url,
          selection,
          categoryIds: [],
          viewIds: [],
        }),
      );
    toast.promise(createFeedPromise, {
      error: (error) =>
        error instanceof Error
          ? error.message
          : "Something went wrong adding your feed.",
    });

    try {
      const result = await createFeedPromise;
      const createdFeed = result.feeds[0];
      if (!createdFeed) return;

      feedCreatedDuringOnboarding(createdFeed.id);
      discovery.reset();
      launchDialog("edit-feed", { selectedFeedId: createdFeed.id });
      // The dialog moves on once the Feed exists; items arrive behind a toast.
      importFeedItems(createdFeed).catch(() => {});
    } catch {
      // Error handled by toast.promise
    } finally {
      setPendingAction(null);
    }
  };

  const handleSelectBookmark = async (sourceUrl: string) => {
    if (pendingAction || !canMutate) return;
    setPendingAction("bookmark");
    try {
      const result = await saveBookmark({ sourceUrl });
      if (useDialogStore.getState().dialog !== "add-feed") return;
      setBookmarkFeedback(
        result as BookmarkSaveResult<ApplicationBookmark> & {
          bookmark: ApplicationBookmark;
        },
      );
    } catch {
      toast.error("Could not save Bookmark");
    } finally {
      setPendingAction(null);
    }
  };

  const isOpen = dialog === "add-feed";

  const dialogContentRef = useVisualViewport(isOpen);

  const handleBookmarkEditorClose = () => {
    if (useOnboarding.getState().instruction === "find-feed") {
      setBookmarkFeedback(null);
      discovery.reset();
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={isOpen && canMutate} onOpenChange={onOpenChange}>
      <DialogContent
        data-onboarding="find-feed"
        ref={dialogContentRef}
        hideClose
        overlayClassName="bg-background sm:bg-black/40"
        className="top-[var(--visual-viewport-top,0px)] left-0 h-[var(--visual-viewport-height,100dvh)] max-h-[var(--visual-viewport-height,100dvh)] w-screen max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden border-0 p-0 sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)] sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:border sm:[@media(min-height:600px)]:top-1/3"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          urlInputRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">
          {bookmarkFeedback ? "Organize Bookmark" : "Find a feed or Bookmark"}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Paste a website, channel, or RSS feed URL.
        </DialogDescription>
        {bookmarkFeedback ? (
          <BookmarkOrganizationEditor
            bookmarkId={bookmarkFeedback.bookmark.id}
            feedback={bookmarkFeedback}
            onClose={handleBookmarkEditorClose}
          />
        ) : (
          <FeedDiscoveryCommand
            url={discovery.url}
            onUrlChange={discovery.handleUrlChange}
            onDiscover={discovery.discoverFeeds}
            onSelectFeed={(feed) => void handleSelectFeed(feed)}
            onSelectBookmark={(url) => void handleSelectBookmark(url)}
            bookmarkPlatform={getAssumedFeedPlatform(discovery.url)}
            discoveredFeeds={discovery.discoveredFeeds}
            isFeedAdded={(feed) => isDiscoveredFeedAdded(addedFeeds, feed)}
            state={pendingAction ? "adding" : discovery.discoveryState}
            loadingLabel={
              pendingAction === "bookmark"
                ? "Saving Bookmark and capturing page…"
                : "Adding feed…"
            }
            inputRef={urlInputRef}
          />
        )}
        <DialogClose asChild>
          <Button
            className="absolute top-2 right-2 sm:hidden"
            variant="ghost"
            size="icon"
            aria-label="Close"
          >
            <XIcon className="size-4" />
          </Button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

function FeedOpenLocationToggleGroup({
  feedPlatform,
  openLocation,
  setOpenLocation,
}: {
  feedPlatform: ContentPlatform;
  openLocation: FeedOpenLocation;
  setOpenLocation: (location: FeedOpenLocation) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor="categories">Open items in</Label>
      <ToggleGroup
        id="categories"
        type="single"
        value={openLocation}
        onValueChange={(value) => {
          if (!value) return;
          setOpenLocation(value as FeedOpenLocation);
        }}
        className="flex w-fit flex-wrap justify-start gap-1"
      >
        <ToggleGroupItem size="sm" variant="outline" value="serial">
          Serial
        </ToggleGroupItem>
        <ToggleGroupItem size="sm" variant="outline" value="origin">
          {PLATFORM_TO_FORMATTED_NAME_MAP[feedPlatform]}
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

function getPrioritizedTagIds(
  views: ApplicationView[],
  selectedViewIds: number[],
) {
  const selectedViewIdSet = new Set(selectedViewIds);
  const prioritizedTagIds = new Set<number>();
  for (const view of views) {
    if (!selectedViewIdSet.has(view.id)) continue;

    for (const section of view.viewSections) {
      if (section.itemType === VIEW_LAYOUT_ITEM_TYPE.TAG) {
        prioritizedTagIds.add(section.itemId);
      }
    }
  }
  return prioritizedTagIds;
}

function useEditFeedForm(selectedFeedId: null | number) {
  const [name, setName] = useState<string>("");
  const [selectedCategories, setSelectedCategories] = useState<number[]>([]);
  const [selectedViewIds, setSelectedViewIds] = useState<number[]>([]);
  const [selectedOpenLocation, setSelectedOpenLocation] =
    useState<FeedOpenLocation>("serial");
  const initializedFeedIdRef = useRef<number | null>(null);
  const previousFeedNameRef = useRef<string>("");

  const { feeds } = useFeeds();
  const { feedCategories } = useFeedCategories();
  const { viewFeeds } = useViewFeeds();

  useEffect(() => {
    if (selectedFeedId == null) {
      initializedFeedIdRef.current = null;
      return;
    }
    const feed = feeds.find((v) => v.id === selectedFeedId);
    if (!feed) return;
    if (initializedFeedIdRef.current === selectedFeedId) {
      const previousName = previousFeedNameRef.current;
      setName((draft) => (draft === previousName ? feed.name : draft));
      previousFeedNameRef.current = feed.name;
      return;
    }
    previousFeedNameRef.current = feed.name;

    const _feedCategories = feedCategories
      .filter((category) => category.feedId === feed.id)
      .map((category) => category.categoryId)
      .filter((id) => typeof id === "number");

    const _feedViewIds = viewFeeds
      .filter((vf) => vf.feedId === feed.id)
      .map((vf) => vf.viewId);

    setName(feed.name);
    setSelectedCategories(_feedCategories);
    setSelectedViewIds(_feedViewIds);
    setSelectedOpenLocation(feed.openLocation);
    initializedFeedIdRef.current = selectedFeedId;
  }, [feedCategories, viewFeeds, selectedFeedId, feeds]);

  return {
    name,
    setName,
    selectedCategories,
    setSelectedCategories,
    selectedViewIds,
    setSelectedViewIds,
    selectedOpenLocation,
    setSelectedOpenLocation,
    feed: feeds.find((v) => v.id === selectedFeedId),
  };
}

function FeedActiveSwitch({
  canMutate,
  feed,
  selectedFeedId,
}: {
  canMutate: boolean;
  feed: ApplicationFeed | undefined;
  selectedFeedId: null | number;
}) {
  const { mutate: setFeedActive } = useSetFeedActiveMutation();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center">
          <Switch
            disabled={!canMutate}
            checked={feed?.isActive ?? true}
            onCheckedChange={(checked) => {
              if (selectedFeedId !== null) {
                setFeedActive({
                  feedId: selectedFeedId,
                  isActive: checked,
                });
              }
            }}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {feed?.isActive ? "Feed active" : "Feed inactive"}
      </TooltipContent>
    </Tooltip>
  );
}

function EditFeedDialogFooter({
  canMutate,
  isFormDisabled,
  actions,
}: {
  canMutate: boolean;
  isFormDisabled: boolean;
  actions: ReturnType<typeof useEditFeedDialogActions>;
}) {
  return (
    <div className="flex gap-2">
      <Button
        disabled={!canMutate || actions.isDeletingFeed}
        className="flex-1"
        variant="destructive"
        onClick={actions.handleDelete}
      >
        {actions.isDeletingFeed ? "Deleting..." : "Delete"}
      </Button>
      <Button
        disabled={!canMutate || isFormDisabled || actions.isUpdatingFeed}
        data-onboarding="save-feed"
        onClick={actions.handleSave}
        className="flex-1"
      >
        {actions.isUpdatingFeed ? "Saving..." : "Save"}
      </Button>
    </div>
  );
}

function CopyFeedLinkButton({
  url,
  label,
  success,
  icon,
}: {
  url: string;
  label: string;
  success: string;
  icon: ReactNode;
}) {
  const [hasCopied, setHasCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(success);
      setHasCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setHasCopied(false), 2000);
    } catch {
      toast.error("Could not copy URL");
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="shrink-0"
          aria-label={label}
          onClick={copy}
        >
          {hasCopied ? <CheckIcon size={16} /> : icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function FeedNameField({
  name,
  setName,
  feed,
  children,
}: {
  name: string;
  setName: (name: string) => void;
  feed: ApplicationFeed | undefined;
  children?: ReactNode;
}) {
  const websiteUrl = feed && getFeedWebsiteUrl(feed);
  const feedUrl = feed && getFeedRssUrl(feed);
  const publicationUri = feed && getAtmosphereOrigin(feed)?.locator;
  const platformName =
    PLATFORM_TO_FORMATTED_NAME_MAP[feed?.platform ?? "youtube"];

  return (
    <div className="grid gap-2">
      <Label htmlFor="name">Name</Label>
      <div className="flex gap-2">
        <Input
          id="name"
          type="text"
          value={name}
          placeholder="My Feed"
          onChange={(e) => setName(e.target.value)}
          className="flex-1"
        />
        {children}
        {publicationUri && (
          <CopyFeedLinkButton
            key={publicationUri}
            url={publicationUri}
            icon={<OrbitIcon size={16} />}
            label="Copy Publication Link"
            success="Publication link copied!"
          />
        )}
        {feedUrl && (
          <CopyFeedLinkButton
            key={feedUrl}
            url={feedUrl}
            icon={<RssIcon size={16} />}
            label="Copy Feed URL"
            success="Feed URL copied!"
          />
        )}
        {websiteUrl && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="shrink-0"
                asChild
              >
                <a
                  href={websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open in ${platformName}`}
                >
                  <ExternalLinkIcon size={16} />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open in {platformName}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function useEditFeedDialogActions({
  canMutate,
  selectedFeedId,
  name,
  selectedCategories,
  selectedViewIds,
  selectedOpenLocation,
  onClose,
}: {
  canMutate: boolean;
  selectedFeedId: null | number;
  name: string;
  selectedCategories: number[];
  selectedViewIds: number[];
  selectedOpenLocation: FeedOpenLocation;
  onClose: () => void;
}) {
  const [isUpdatingFeed, setIsUpdatingFeed] = useState(false);
  const [isDeletingFeed, setIsDeletingFeed] = useState(false);
  const isUpdatingFeedRef = useRef(false);
  const isDeletingFeedRef = useRef(false);

  const { mutateAsync: editFeed } = useEditFeedMutation();
  const { mutateAsync: deleteFeed } = useDeleteFeedMutation();

  const handleDelete = async () => {
    if (selectedFeedId === null || !canMutate || isDeletingFeedRef.current) {
      return;
    }

    isDeletingFeedRef.current = true;
    setIsDeletingFeed(true);
    try {
      const deleteFeedPromise = deleteFeed(selectedFeedId);
      toast.promise(deleteFeedPromise, {
        loading: "Deleting feed...",
        success: () => {
          return "Feed deleted!";
        },
        error: () => {
          return "Something went wrong deleting your feed.";
        },
      });
      onClose();
      await deleteFeedPromise;
    } catch {
      // Error handled by toast.promise
    } finally {
      isDeletingFeedRef.current = false;
      setIsDeletingFeed(false);
    }
  };

  const handleSave = async () => {
    if (selectedFeedId === null || !canMutate || isUpdatingFeedRef.current) {
      return;
    }

    isUpdatingFeedRef.current = true;
    setIsUpdatingFeed(true);
    try {
      await editFeed({
        feedId: selectedFeedId,
        categoryIds: selectedCategories,
        viewIds: selectedViewIds,
        openLocation: selectedOpenLocation,
        name,
      });
      toast.success("Feed updated!");
      feedSavedDuringOnboarding();
      onClose();
    } catch {
      // Error handled by toast
    } finally {
      isUpdatingFeedRef.current = false;
      setIsUpdatingFeed(false);
    }
  };

  return {
    isUpdatingFeed,
    isDeletingFeed,
    handleDelete,
    handleSave,
  };
}

function EditFeedViewsField({
  canMutate,
  selectedViewIds,
  setSelectedViewIds,
}: {
  canMutate: boolean;
  selectedViewIds: number[];
  setSelectedViewIds: Dispatch<SetStateAction<number[]>>;
}) {
  const viewOptions = useViewOptions();
  const { mutateAsync: quickCreateView } = useQuickCreateViewMutation();

  return (
    <SelectableChipList
      label="Views"
      options={viewOptions}
      createDisabled={!canMutate}
      selectedIds={selectedViewIds}
      onToggle={(id) =>
        toggleSelectedId(selectedViewIds, setSelectedViewIds, id)
      }
      onCreate={async (viewName) => {
        if (!canMutate) return;
        try {
          const createdView = await quickCreateView({ name: viewName });
          if (createdView) {
            setSelectedViewIds((ids) =>
              ids.includes(createdView.id) ? ids : [...ids, createdView.id],
            );
          }
        } catch {
          toast.error("Failed to create view.");
          throw new Error("Failed to create view.");
        }
      }}
      createLabel="Create view"
      createPlaceholder="New view name..."
    />
  );
}

function EditFeedTagsField({
  canMutate,
  selectedCategories,
  setSelectedCategories,
  selectedViewIds,
}: {
  canMutate: boolean;
  selectedCategories: number[];
  setSelectedCategories: Dispatch<SetStateAction<number[]>>;
  selectedViewIds: number[];
}) {
  const { views } = useViews();
  const { contentCategories } = useContentCategories();
  const { mutateAsync: createContentCategory } =
    useCreateContentCategoryMutation();

  const tagOptions = contentCategories.map((category) => ({
    id: category.id,
    label: category.name,
  }));
  const prioritizedTagIds = getPrioritizedTagIds(views, selectedViewIds);

  return (
    <SelectableChipList
      label="Tags"
      createDisabled={!canMutate}
      options={tagOptions}
      selectedIds={selectedCategories}
      prioritizedIds={prioritizedTagIds}
      onToggle={(id) =>
        toggleSelectedId(selectedCategories, setSelectedCategories, id)
      }
      onCreate={async (tagName) => {
        if (!canMutate) return;
        try {
          const createdTag = await createContentCategory({
            name: tagName,
            feedCategorizations: [],
          });
          if (createdTag) {
            setSelectedCategories((ids) =>
              ids.includes(createdTag.id) ? ids : [...ids, createdTag.id],
            );
          }
        } catch {
          toast.error("Failed to create tag.");
          throw new Error("Failed to create tag.");
        }
      }}
      createLabel="Create tag"
      createPlaceholder="New tag name..."
    />
  );
}

export function EditFeedDialog({
  selectedFeedId,
  onClose,
}: {
  selectedFeedId: null | number;
  onClose: () => void;
}) {
  const canMutate = useCanMutate();
  const {
    name,
    setName,
    selectedCategories,
    setSelectedCategories,
    selectedViewIds,
    setSelectedViewIds,
    selectedOpenLocation,
    setSelectedOpenLocation,
    feed,
  } = useEditFeedForm(selectedFeedId);
  const actions = useEditFeedDialogActions({
    canMutate,
    selectedFeedId,
    name,
    selectedCategories,
    selectedViewIds,
    selectedOpenLocation,
    onClose,
  });

  const { mutate: revalidateFeed } = useRevalidateFeedMutation();
  const isRevalidating = useIsFeedRevalidating(selectedFeedId);
  const isFormDisabled = !name || isRevalidating;

  return (
    <ControlledResponsiveDialog
      mobileSheet
      open={selectedFeedId !== null}
      onOpenChange={() => {
        if (!requestOnboardingSkip()) onClose();
      }}
      title="Edit Feed"
      headerRight={
        <div className="flex items-center gap-2">
          <FeedActiveSwitch
            canMutate={canMutate && !isRevalidating}
            feed={feed}
            selectedFeedId={selectedFeedId}
          />
        </div>
      }
      footer={
        <EditFeedDialogFooter
          canMutate={canMutate && !isRevalidating}
          isFormDisabled={isFormDisabled}
          actions={actions}
        />
      }
    >
      <div className="grid gap-6">
        <FeedNameField name={name} setName={setName} feed={feed}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="shrink-0"
                aria-label="Revalidate Feed"
                aria-busy={isRevalidating}
                disabled={
                  !canMutate ||
                  !feed ||
                  isRevalidating ||
                  actions.isUpdatingFeed ||
                  actions.isDeletingFeed
                }
                onClick={() => {
                  if (selectedFeedId !== null)
                    revalidateFeed({ feedId: selectedFeedId });
                }}
              >
                <RefreshCwIcon
                  size={16}
                  className={isRevalidating ? "animate-spin" : undefined}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Revalidate Feed</TooltipContent>
          </Tooltip>
        </FeedNameField>
        <EditFeedViewsField
          canMutate={canMutate}
          selectedViewIds={selectedViewIds}
          setSelectedViewIds={setSelectedViewIds}
        />
        <EditFeedTagsField
          canMutate={canMutate}
          selectedCategories={selectedCategories}
          setSelectedCategories={setSelectedCategories}
          selectedViewIds={selectedViewIds}
        />
        <FeedOpenLocationToggleGroup
          feedPlatform={feed?.platform ?? "youtube"}
          openLocation={selectedOpenLocation}
          setOpenLocation={setSelectedOpenLocation}
        />
      </div>
    </ControlledResponsiveDialog>
  );
}
