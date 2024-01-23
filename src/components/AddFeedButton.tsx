"use client";

import { PlusIcon } from "@radix-ui/react-icons";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Label } from "./ui/label";
import { Input } from "./ui/input";
import { api } from "~/trpc/react";
import { useState } from "react";
import { Combobox } from "./ui/combobox";

export function AddFeedButton() {
  const [feedUrl, setFeedUrl] = useState("");

  const {
    data: categories,
    refetch: refetchCategories,
    isLoading: isLoadingCategories,
  } = api.contentCategories.getAllForUser.useQuery();
  const { refetch: refetchFeeds } = api.feed.getAllFeedData.useQuery();
  const [category, setCategory] = useState<string | null>(null);

  const addFeed = api.feed.create.useMutation();
  const addCategory = api.contentCategories.create.useMutation();

  const categoryOptions = categories?.map((category) => ({
    value: category.id.toString(),
    label: category.name,
  }));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon">
          <PlusIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="url">RSS Feed URL</Label>
            <Input
              id="url"
              type="url"
              placeholder="https://www.example.com/feed.xml"
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
              onSelect={setCategory}
              onAddOption={async (newOption) => {
                await addCategory.mutateAsync({ name: newOption });
                const categoriesResponse = await refetchCategories();
                const newCategory = categoriesResponse.data?.find(
                  (category) => category.name === newOption,
                );
                if (newCategory) {
                  setCategory(newCategory?.id.toString());
                }
              }}
              value={category}
              placeholder="Select a category"
              width="full"
            />
          )}
          <Button
            onClick={async () => {
              if (category === null) {
                await addFeed.mutateAsync({ url: feedUrl });
              } else {
                await addFeed.mutateAsync({
                  url: feedUrl,
                  categoryId: parseInt(category, 10),
                });
              }

              await refetchFeeds();
            }}
          >
            {addFeed.isLoading ? "Adding..." : "Add Feed"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
