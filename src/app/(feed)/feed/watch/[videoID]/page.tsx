"use client";

import clsx from "clsx";
import { useEffect, useState } from "react";
import { useKeyboard } from "~/components/KeyboardProvider";
import ResponsiveVideo from "~/components/ResponsiveVideo";
import { VideoActions } from "./VideoActions";

export default function WatchVideoPage({
  params,
}: {
  params: { videoID: string };
}) {
  const [showVideo, setShowVideo] = useState(false);
  const { view } = useKeyboard();

  useEffect(() => {
    setTimeout(() => {
      setShowVideo(true);
    }, 250);
  }, []);

  return (
    <div
      className={clsx("grid h-full w-full place-items-center", {
        "absolute inset-0 z-30 bg-background": view === "fullscreen",
        "mx-auto max-w-3xl": view === "windowed",
      })}
    >
      <div
        className={clsx("w-full", {
          "sm:py-6": view === "windowed",
        })}
      >
        <div className="relative">
          <div
            className={clsx(
              "absolute top-0 aspect-video w-full animate-pulse overflow-hidden bg-muted transition-opacity",
              {
                rounded: view === "windowed",
              },
            )}
          />
          <div
            className={clsx("w-full overflow-hidden transition-opacity", {
              rounded: view === "windowed",
              "opacity-0": !showVideo,
              "opacity-100": showVideo,
            })}
          >
            <ResponsiveVideo videoID={params.videoID} />
          </div>
          <VideoActions videoID={params.videoID} />
        </div>
      </div>
    </div>
  );
}
