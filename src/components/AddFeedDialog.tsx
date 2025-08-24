"use client";
import { DialogTitle } from "@radix-ui/react-dialog";
import { ImportIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useDialogStore } from "~/app/(feed)/feed/dialogStore";
import { useFeedCategories } from "~/lib/data/feed-categories";
import { useFeeds } from "~/lib/data/feeds";
import {
  useCreateFeedMutation,
  useDeleteFeedMutation,
  useEditFeedMutation,
} from "~/lib/data/feeds/mutations";
import { validateFeedUrl } from "~/server/rss/validateFeedUrl";
import { ViewCategoriesInput } from "./AddViewDialog";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { useShortcut } from "~/lib/hooks/useShortcut";
import {
  useFeedsCollection,
  useAllFeedsLiveQuery,
  useSingleFeedLiveQuery,
} from "~/lib/collections/feeds";
import { useLiveQuery } from "@tanstack/react-db";

export function AddFeedDialog() {
  const [feedUrl, setFeedUrl] = useState("");
  const [isAddingFeed, setIsAddingFeed] = useState(false);

  const { mutateAsync: createFeed } = useCreateFeedMutation();

  const [selectedCategories, setSelectedCategories] = useState<number[]>([]);

  const dialog = useDialogStore((store) => store.dialog);
  const onDialogOpenChange = useDialogStore((store) => store.onOpenChange);

  const launchDialog = useDialogStore((store) => store.launchDialog);
  useShortcut("a", (event) => {
    event.preventDefault();
    launchDialog("add-feed");
  });

  const onOpenChange = (open = false) => {
    onDialogOpenChange(open);

    if (!open) {
      setFeedUrl("");
      setSelectedCategories([]);
    }
  };

  return (
    <Dialog open={dialog === "add-feed"} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-mono">Add Feed</DialogTitle>
        </DialogHeader>
        <div className="grid gap-6">
          <div className="grid gap-2">
            <Label htmlFor="url">Channel or RSS Feed URL</Label>
            <Input
              id="url"
              type="url"
              value={feedUrl}
              placeholder="https://www.youtube.com/@example"
              onChange={(e) => {
                setFeedUrl(e.target.value);
              }}
            />
          </div>
          <ViewCategoriesInput
            selectedCategories={selectedCategories}
            setSelectedCategories={setSelectedCategories}
          />
          <Button
            disabled={!validateFeedUrl(feedUrl) || isAddingFeed}
            onClick={async () => {
              setIsAddingFeed(true);

              try {
                const createFeedPromise = createFeed({
                  url: feedUrl,
                  categoryIds: selectedCategories,
                });
                toast.promise(createFeedPromise, {
                  loading: "Adding feed...",
                  success: () => {
                    return "Feed added!";
                  },
                  error: () => {
                    return "Something went wrong adding your feed.";
                  },
                });
                setFeedUrl("");
                onOpenChange(false);
              } catch {}

              setIsAddingFeed(false);
            }}
          >
            {isAddingFeed ? "Adding..." : "Add Feed"}
          </Button>
          <div className="py-4">
            <hr />
          </div>
          <Label>Have a lot of feeds to add?</Label>
          <Link href="/feed/import">
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              <ImportIcon size={16} />
              <span className="pl-1.5">Bulk Import</span>
            </Button>
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function EditFeedDialog({
  selectedFeedId,
  onClose,
}: {
  selectedFeedId: null | number;
  onClose: () => void;
}) {
  const { data: feed } = useSingleFeedLiveQuery(selectedFeedId);
  const feedsCollection = useFeedsCollection();

  const [name, setName] = useState<string>("");
  const [selectedCategories, setSelectedCategories] = useState<number[]>([]);

  const isFormDisabled = !name;

  const onOpenChange = (open: boolean) => {
    if (open) {
      if (!feed) return;

      setName(feed.name);
      setSelectedCategories(feed.categoryIds);
    } else {
      setName("");
      setSelectedCategories([]);
      onClose();
    }
  };

  useEffect(() => {
    if (!selectedFeedId || !(name === "" && !selectedCategories.length)) {
      return;
    }
    onOpenChange(true);
  }, [selectedFeedId, onOpenChange]);

  return (
    <Dialog open={selectedFeedId !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between font-mono">
            Edit Feed{" "}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-6">
          <div className="grid gap-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              placeholder="My Feed"
            />
          </div>
          <ViewCategoriesInput
            selectedCategories={selectedCategories}
            setSelectedCategories={setSelectedCategories}
          />
          <div className="flex gap-2">
            <Button
              className="flex-1"
              variant="destructive"
              onClick={async () => {
                if (selectedFeedId === null) return;

                feedsCollection.delete(selectedFeedId);
                onOpenChange(false);
              }}
            >
              Delete
            </Button>
            <Button
              disabled={isFormDisabled}
              onClick={async () => {
                if (selectedFeedId === null) return;

                feedsCollection.update(selectedFeedId, (draft) => {
                  draft.categoryIds = selectedCategories;
                  draft.name = name;
                });

                onOpenChange(false);
              }}
              className="flex-1"
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
