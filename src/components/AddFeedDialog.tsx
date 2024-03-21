"use client";

import { DialogTitle } from "@radix-ui/react-dialog";
import { useState } from "react";
import { useDialogStore } from "~/app/(feed)/feed/dialogStore";
import { api } from "~/trpc/react";
import { Button } from "./ui/button";
import { Combobox } from "./ui/combobox";
import { Dialog, DialogContent, DialogHeader } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { validateFeedUrl } from "~/server/rss/validateFeedUrl";
import { toast } from "sonner";

export function AddFeedDialog() {
  const [feedUrl, setFeedUrl] = useState("");

  const {
    data: categories,
    refetch: refetchCategories,
    isLoading: isLoadingCategories,
  } = api.contentCategories.getAllForUser.useQuery();
  const { refetch: refetchFeeds } = api.feed.getAllFeedData.useQuery();
  const [categoryName, setCategoryName] = useState<string | null>(null);

  const addFeed = api.feed.create.useMutation();
  const addCategory = api.contentCategories.create.useMutation();

  const categoryOptions = categories?.map((category) => ({
    value: category.name.toLowerCase(),
    label: category.name,
  }));

  const { dialog, onOpenChange } = useDialogStore((store) => ({
    dialog: store.dialog,
    onOpenChange: store.onOpenChange,
  }));

  return (
    <Dialog open={dialog === "add-feed"} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-mono">Add Feed</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
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
          {addCategory.isLoading || isLoadingCategories ? (
            <Button disabled variant="outline">
              Loading...
            </Button>
          ) : (
            <Combobox
              label="Category"
              options={categoryOptions ?? []}
              onSelect={setCategoryName}
              onAddOption={async (newOption) => {
                await addCategory.mutateAsync({ name: newOption });
                const categoriesResponse = await refetchCategories();
                const newCategory = categoriesResponse.data?.find(
                  (category) => category.name === newOption,
                );

                if (newCategory) {
                  setCategoryName(newCategory.name.toLowerCase());
                }
              }}
              value={categoryName}
              placeholder="Select a category"
              width="full"
            />
          )}
          <Button
            disabled={!validateFeedUrl(feedUrl) || addFeed.isLoading}
            onClick={async () => {
              const category = !!categoryName
                ? categories?.find((category) => category.name === categoryName)
                : undefined;

              if (!category) {
                await addFeed.mutateAsync({ url: feedUrl });
              } else {
                await addFeed.mutateAsync({
                  url: feedUrl,
                  categoryId: category.id,
                });
              }

              setFeedUrl("");

              toast.success("Feed added!");
              await refetchFeeds();
            }}
          >
            {addFeed.isLoading ? "Adding..." : "Add Feed"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
