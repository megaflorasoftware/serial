"use client";

import { PlusIcon } from "@radix-ui/react-icons";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Label } from "./ui/label";
import { Input } from "./ui/input";
import { api } from "~/trpc/react";
import { useState } from "react";

export function AddFeedButton() {
  const [feedUrl, setFeedUrl] = useState("");

  const addFeed = api.feed.create.useMutation();

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
          <Button
            onClick={() => {
              addFeed.mutate({ url: feedUrl });
            }}
          >
            {addFeed.isLoading ? "Adding..." : "Add Feed"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
