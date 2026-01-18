"use client";

import { createFileRoute, Link } from "@tanstack/react-router";
import {
  GlobeIcon,
  PlayCircleIcon,
  Trash2Icon,
  YoutubeIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ViewCategoriesInput } from "~/components/AddViewDialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { ControlledResponsiveDialog } from "~/components/ui/responsive-dropdown";
import { useContentCategories } from "~/lib/data/content-categories";
import { useFeedCategories } from "~/lib/data/feed-categories";
import {
  useBulkAssignFeedCategoryMutation,
  useBulkRemoveFeedCategoryMutation,
} from "~/lib/data/feed-categories/mutations";
import { useFeeds } from "~/lib/data/feeds";
import { useBulkDeleteFeedsMutation } from "~/lib/data/feeds/mutations";
import type { FeedPlatform } from "~/server/db/schema";

export const Route = createFileRoute("/_app/feeds")({
  component: ManageFeedsPage,
});

function PlatformIcon({ platform }: { platform: FeedPlatform }) {
  switch (platform) {
    case "youtube":
      return <YoutubeIcon size={16} />;
    case "peertube":
      return <PlayCircleIcon size={16} />;
    case "website":
    default:
      return <GlobeIcon size={16} />;
  }
}

function FeedImage({
  imageUrl,
  name,
  platform,
}: {
  imageUrl: string;
  name: string;
  platform: FeedPlatform;
}) {
  if (!imageUrl) {
    return (
      <div className="bg-muted text-muted-foreground grid size-7 shrink-0 place-items-center rounded">
        <PlatformIcon platform={platform} />
      </div>
    );
  }

  return (
    <img
      src={imageUrl}
      alt={name}
      className="size-7 shrink-0 rounded object-cover"
    />
  );
}

function ManageFeedsPage() {
  const { feeds } = useFeeds();
  const { feedCategories } = useFeedCategories();
  const { contentCategories } = useContentCategories();

  const [selectedFeedIds, setSelectedFeedIds] = useState<Set<number>>(
    new Set(),
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [isScrolled, setIsScrolled] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const headerRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!headerRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsScrolled(!entry?.isIntersecting);
      },
      { threshold: 0 },
    );

    observer.observe(headerRef.current);
    return () => observer.disconnect();
  }, []);
  const [showEditCategoriesDialog, setShowEditCategoriesDialog] = useState(false);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<number[]>([]);

  const { mutateAsync: bulkDeleteFeeds, isPending: isDeletingFeeds } =
    useBulkDeleteFeedsMutation();
  const {
    mutateAsync: bulkAssignCategory,
    isPending: isAssigningCategory,
  } = useBulkAssignFeedCategoryMutation();
  const {
    mutateAsync: bulkRemoveCategory,
    isPending: isRemovingCategory,
  } = useBulkRemoveFeedCategoryMutation();

  const feedCategoriesMap = useMemo(() => {
    const map = new Map<number, number[]>();
    feedCategories?.forEach((fc) => {
      const existing = map.get(fc.feedId) ?? [];
      existing.push(fc.categoryId);
      map.set(fc.feedId, existing);
    });
    return map;
  }, [feedCategories]);

  const categoryNamesMap = useMemo(() => {
    const map = new Map<number, string>();
    contentCategories?.forEach((c) => {
      map.set(c.id, c.name);
    });
    return map;
  }, [contentCategories]);

  const filteredFeeds = useMemo(() => {
    if (!feeds) return [];
    const sorted = [...feeds].sort((a, b) => a.name.localeCompare(b.name));
    if (!searchQuery.trim()) return sorted;

    const lowercaseQuery = searchQuery.toLowerCase();
    return sorted.filter((feed) =>
      feed.name.toLowerCase().includes(lowercaseQuery),
    );
  }, [feeds, searchQuery]);

  const selectedCount = selectedFeedIds.size;
  const allSelected = filteredFeeds.length > 0 && selectedCount === filteredFeeds.length;

  const toggleFeedSelection = (feedId: number) => {
    setSelectedFeedIds((prev) => {
      const next = new Set(prev);
      if (next.has(feedId)) {
        next.delete(feedId);
      } else {
        next.add(feedId);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedFeedIds(new Set(filteredFeeds.map((f) => f.id)));
  };

  const handleDelete = async () => {
    const feedIds = Array.from(selectedFeedIds);
    const deletePromise = bulkDeleteFeeds({ feedIds });
    toast.promise(deletePromise, {
      loading: `Deleting ${feedIds.length} feed${feedIds.length > 1 ? "s" : ""}...`,
      success: () => {
        setSelectedFeedIds(new Set());
        setShowDeleteDialog(false);
        return `Deleted ${feedIds.length} feed${feedIds.length > 1 ? "s" : ""}!`;
      },
      error: () => "Failed to delete feeds",
    });
  };

  const getSharedCategories = () => {
    const feedIds = Array.from(selectedFeedIds);
    if (feedIds.length === 0) return [];

    const firstFeedCategories = feedCategoriesMap.get(feedIds[0]!) ?? [];
    return firstFeedCategories.filter((categoryId) =>
      feedIds.every((feedId) =>
        feedCategoriesMap.get(feedId)?.includes(categoryId),
      ),
    );
  };

  const openEditCategoriesDialog = () => {
    setSelectedCategoryIds(getSharedCategories());
    setShowEditCategoriesDialog(true);
  };

  const handleEditCategories = async () => {
    const feedIds = Array.from(selectedFeedIds);

    // Get all categories that any selected feed currently has
    const allCurrentCategories = new Set<number>();
    feedIds.forEach((feedId) => {
      const categories = feedCategoriesMap.get(feedId) ?? [];
      categories.forEach((c) => allCurrentCategories.add(c));
    });

    // Categories to add: selected in dialog
    // Categories to remove: any category that a feed has but is not selected
    const categoriesToAdd = selectedCategoryIds;
    const categoriesToRemove = Array.from(allCurrentCategories).filter(
      (id) => !selectedCategoryIds.includes(id),
    );

    const promises: Promise<void>[] = [];

    categoriesToAdd.forEach((categoryId) => {
      promises.push(bulkAssignCategory({ feedIds, categoryId }));
    });

    categoriesToRemove.forEach((categoryId) => {
      promises.push(bulkRemoveCategory({ feedIds, categoryId }));
    });

    if (promises.length === 0) {
      setShowEditCategoriesDialog(false);
      return;
    }

    const editPromise = Promise.all(promises);
    toast.promise(editPromise, {
      loading: "Updating categories...",
      success: () => {
        setSelectedCategoryIds([]);
        setShowEditCategoriesDialog(false);
        return "Categories updated!";
      },
      error: () => "Failed to update categories",
    });
  };

  if (!feeds?.length) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h2 className="font-mono text-lg">Manage Feeds</h2>
        <p className="text-muted-foreground mt-4">
          You don&apos;t have any feeds yet.
        </p>
        <Link to="/">
          <Button className="mt-4">Back to home</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="pb-24">
      <div className="mx-auto max-w-2xl px-6 pt-6">
        <h2 ref={headerRef} className="font-mono text-lg">Manage Feeds</h2>
      </div>

      <div
        className={`bg-background sticky top-0 z-10 transition-[border-color] ${
          isScrolled ? "border-b border-solid" : "border-b border-transparent"
        }`}
      >
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-4 px-6 py-4">
          <Input
            placeholder="Search feeds..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1"
          />
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={selectAll} disabled={allSelected}>
              Select All
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedFeedIds(new Set())}
              disabled={selectedCount === 0}
            >
              Deselect All
            </Button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-2xl px-6">

      <div className="-mx-3 mt-6">
        {filteredFeeds.map((feed) => {
          const isSelected = selectedFeedIds.has(feed.id);
          const feedCategoryIds = feedCategoriesMap.get(feed.id) ?? [];

          return (
            <div
              key={feed.id}
              className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-muted/50"
              onClick={() => toggleFeedSelection(feed.id)}
            >
              <Checkbox
                id={`feed-${feed.id}`}
                checked={isSelected}
                onCheckedChange={() => toggleFeedSelection(feed.id)}
                onClick={(e) => e.stopPropagation()}
              />
              <FeedImage imageUrl={feed.imageUrl} name={feed.name} platform={feed.platform} />
              <span className="line-clamp-1 flex-1">{feed.name}</span>
              <div className="flex flex-wrap gap-1">
                {feedCategoryIds.map((categoryId) => {
                  const categoryName = categoryNamesMap.get(categoryId);
                  if (!categoryName) return null;
                  return (
                    <Badge key={categoryId} variant="outline">
                      {categoryName}
                    </Badge>
                  );
                })}
              </div>
            </div>
          );
        })}

        {filteredFeeds.length === 0 && searchQuery && (
          <p className="text-muted-foreground py-8 text-center">
            No feeds match &quot;{searchQuery}&quot;
          </p>
        )}
      </div>
      </div>

      {selectedCount > 0 && (
        <div className="bg-background fixed inset-x-0 bottom-0 border-t border-solid">
          <div className="mx-auto flex max-w-2xl items-center justify-between px-6 py-4">
            <Button
              variant="outline"
              onClick={openEditCategoriesDialog}
              disabled={isAssigningCategory || isRemovingCategory}
            >
              Edit Categories
            </Button>
            <Button
              variant="destructive"
              onClick={() => setShowDeleteDialog(true)}
              disabled={isDeletingFeeds}
            >
              <Trash2Icon size={16} className="mr-2" />
              Delete ({selectedCount})
            </Button>
          </div>
        </div>
      )}

      <ControlledResponsiveDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        title="Delete Feeds"
        description={`Are you sure you want to delete ${selectedCount} feed${selectedCount > 1 ? "s" : ""}? This action cannot be undone.`}
      >
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => setShowDeleteDialog(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className="flex-1"
            onClick={handleDelete}
            disabled={isDeletingFeeds}
          >
            {isDeletingFeeds ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </ControlledResponsiveDialog>

      <ControlledResponsiveDialog
        open={showEditCategoriesDialog}
        onOpenChange={setShowEditCategoriesDialog}
        title="Edit Categories"
        description={`Select categories for ${selectedCount} feed${selectedCount > 1 ? "s" : ""}.`}
      >
        <div className="grid gap-4">
          <ViewCategoriesInput
            selectedCategories={selectedCategoryIds}
            setSelectedCategories={setSelectedCategoryIds}
          />
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowEditCategoriesDialog(false)}
            >
              Cancel
            </Button>
            <Button
              className="flex-1"
              onClick={handleEditCategories}
              disabled={isAssigningCategory || isRemovingCategory}
            >
              {isAssigningCategory || isRemovingCategory ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </ControlledResponsiveDialog>
    </div>
  );
}
