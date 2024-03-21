"use client";

import { VideoIcon } from "@radix-ui/react-icons";
import { useState } from "react";
import { useFeed } from "../lib/data/FeedProvider";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { ResponsiveDialog } from "./ui/responsive-dialog";
import Link from "next/link";

function getYouTubeVideoIdFromUrl(url: string) {
  const match = url.match(
    // eslint-disable-next-line no-useless-escape
    /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=)?(.+)/,
  );

  if (!match) {
    return null;
  }

  return match[1];
}

export function CustomVideoButton() {
  const [videoUrl, setVideoUrl] = useState("");

  return (
    <ResponsiveDialog
      title="Watch a YouTube Video"
      trigger={
        <Button variant="outline" size="icon">
          <VideoIcon />
        </Button>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="url">YouTube URL</Label>
          <Input
            id="url"
            type="url"
            placeholder="https://www.youtube.com/watch?v=XXXXXXXXXXX"
            onChange={(e) => {
              setVideoUrl(e.target.value);
            }}
          />
        </div>
        <Link href={`/feed/watch/${getYouTubeVideoIdFromUrl(videoUrl)}`}>
          <Button>Watch</Button>
        </Link>
      </div>
    </ResponsiveDialog>
  );
}
