"use client";

import { createFileRoute, Link } from "@tanstack/react-router";
import {
  GlobeIcon,
  PlayCircleIcon,
  Trash2Icon,
  PlusIcon,
  MinusIcon,
  YoutubeIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
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

function ManageFeedsPage() {
  const { feeds } = useFeeds();
  const { feedCategories } = useFeedCategories();
  const { contentCategories } = useContentCategories();

  const [selectedFeedIds, setSelectedFeedIds] = useState<Set<number>>(
    new Set(),
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showAddCategoryDialog, setShowAddCategoryDialog] = useState(false);
  const [showRemoveCategoryDialog, setShowRemoveCategoryDialog] =
    useState(false);
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
  const allSelected =
    filteredFeeds.length > 0 && selectedFeedIds.size === filteredFeeds.length;

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

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedFeedIds(new Set());
    } else {
      setSelectedFeedIds(new Set(filteredFeeds.map((f) => f.id)));
    }
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

  const handleAddCategory = async () => {
    if (selectedCategoryIds.length === 0) return;
    const feedIds = Array.from(selectedFeedIds);
    const categoryId = selectedCategoryIds[0];
    if (!categoryId) return;

    const assignPromise = bulkAssignCategory({ feedIds, categoryId });
    toast.promise(assignPromise, {
      loading: "Adding category...",
      success: () => {
        setSelectedCategoryIds([]);
        setShowAddCategoryDialog(false);
        return "Category added to selected feeds!";
      },
      error: () => "Failed to add category",
    });
  };

  const handleRemoveCategory = async () => {
    if (selectedCategoryIds.length === 0) return;
    const feedIds = Array.from(selectedFeedIds);
    const categoryId = selectedCategoryIds[0];
    if (!categoryId) return;

    const removePromise = bulkRemoveCategory({ feedIds, categoryId });
    toast.promise(removePromise, {
      loading: "Removing category...",
      success: () => {
        setSelectedCategoryIds([]);
        setShowRemoveCategoryDialog(false);
        return "Category removed from selected feeds!";
      },
      error: () => "Failed to remove category",
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
    <div className="mx-auto max-w-2xl p-6 pb-24">
      <h2 className="font-mono text-lg">Manage Feeds</h2>

      <div className="mt-6 flex items-center justify-between gap-4">
        <Input
          placeholder="Search feeds..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1"
        />
        <Button variant="outline" size="sm" onClick={toggleSelectAll}>
          {allSelected ? "Deselect All" : "Select All"}
        </Button>
      </div>

      <div className="mt-6">
        {filteredFeeds.map((feed) => {
          const isSelected = selectedFeedIds.has(feed.id);
          const feedCategoryIds = feedCategoriesMap.get(feed.id) ?? [];

          return (
            <div
              key={feed.id}
              className="border-muted/50 flex items-center justify-between gap-3 border-0 border-t border-solid py-4"
            >
              <Checkbox
                id={`feed-${feed.id}`}
                checked={isSelected}
                onCheckedChange={() => toggleFeedSelection(feed.id)}
              />
              <span className="bg-background border-foreground/30 text-foreground/50 grid size-7 shrink-0 place-items-center rounded border border-solid">
                <PlatformIcon platform={feed.platform} />
              </span>
              <label
                htmlFor={`feed-${feed.id}`}
                className="line-clamp-1 flex-1 cursor-pointer"
              >
                {feed.name}
              </label>
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

      {selectedCount > 0 && (
        <div className="bg-background fixed inset-x-0 bottom-0 border-t border-solid">
          <div className="mx-auto flex max-w-2xl items-center gap-2 p-4">
            <Button
              variant="destructive"
              onClick={() => setShowDeleteDialog(true)}
              disabled={isDeletingFeeds}
            >
              <Trash2Icon size={16} className="mr-2" />
              Delete ({selectedCount})
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setSelectedCategoryIds([]);
                setShowAddCategoryDialog(true);
              }}
              disabled={isAssigningCategory}
            >
              <PlusIcon size={16} className="mr-2" />
              Add Category
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setSelectedCategoryIds([]);
                setShowRemoveCategoryDialog(true);
              }}
              disabled={isRemovingCategory}
            >
              <MinusIcon size={16} className="mr-2" />
              Remove Category
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
        open={showAddCategoryDialog}
        onOpenChange={setShowAddCategoryDialog}
        title="Add Category"
        description={`Select a category to add to ${selectedCount} feed${selectedCount > 1 ? "s" : ""}.`}
      >
        <div className="grid gap-4">
          <ViewCategoriesInput
            selectedCategories={selectedCategoryIds}
            setSelectedCategories={(ids) =>
              setSelectedCategoryIds(ids.slice(-1))
            }
          />
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowAddCategoryDialog(false)}
            >
              Cancel
            </Button>
            <Button
              className="flex-1"
              onClick={handleAddCategory}
              disabled={isAssigningCategory || selectedCategoryIds.length === 0}
            >
              {isAssigningCategory ? "Adding..." : "Add Category"}
            </Button>
          </div>
        </div>
      </ControlledResponsiveDialog>

      <ControlledResponsiveDialog
        open={showRemoveCategoryDialog}
        onOpenChange={setShowRemoveCategoryDialog}
        title="Remove Category"
        description={`Select a category to remove from ${selectedCount} feed${selectedCount > 1 ? "s" : ""}.`}
      >
        <div className="grid gap-4">
          <ViewCategoriesInput
            selectedCategories={selectedCategoryIds}
            setSelectedCategories={(ids) =>
              setSelectedCategoryIds(ids.slice(-1))
            }
          />
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowRemoveCategoryDialog(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              onClick={handleRemoveCategory}
              disabled={isRemovingCategory || selectedCategoryIds.length === 0}
            >
              {isRemovingCategory ? "Removing..." : "Remove Category"}
            </Button>
          </div>
        </div>
      </ControlledResponsiveDialog>
    </div>
  );
}
