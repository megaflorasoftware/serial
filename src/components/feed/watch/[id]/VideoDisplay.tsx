import clsx from "clsx";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ContentActions } from "./ContentActions";
import {
  useVideoNavigation,
  useVideoNavigationShortcuts,
} from "./useVideoNavigationShortcuts";
import { useView } from "./useView";
import { ButtonWithShortcut } from "~/components/ButtonWithShortcut";
import ResponsiveVideo from "~/components/ResponsiveVideo";
import { useFeedItemValue } from "~/lib/data/store";
import { useShortcut } from "~/lib/hooks/useShortcut";

export function VideoDisplay({
  id,
  isInactive,
}: {
  id: string;
  isInactive: boolean;
}) {
  const item = useFeedItemValue(id);
  const [showVideo, setShowVideo] = useState(false);

  const { view, toggleView } = useView();

  useShortcut("`", toggleView);
  useShortcut("f", toggleView);

  useVideoNavigationShortcuts();

  const { goToPreviousVideo, goToNextVideo, canGoToPrevious, canGoToNext } =
    useVideoNavigation();

  useEffect(() => {
    const timeout = setTimeout(() => {
      setShowVideo(true);
    }, 100);

    return () => {
      clearTimeout(timeout);
    };
  }, []);

  if (!item) return null;

  const isVertical = item.orientation === "vertical";
  const showNavButtons = isVertical && view === "windowed";

  return (
    <>
      <div
        className={clsx("relative z-10 w-full", {
          "h-fit": view === "windowed",
          "h-full": view === "fullscreen",
        })}
      >
        <div className="flex items-center justify-center gap-4">
          {showNavButtons && (
            <ButtonWithShortcut
              shortcut="["
              variant="ghost"
              onClick={goToPreviousVideo}
              disabled={!canGoToPrevious}
            >
              <ChevronLeftIcon />
            </ButtonWithShortcut>
          )}
          <div className="relative w-full">
            <div
              className={clsx(
                "bg-muted absolute top-0 w-full animate-pulse overflow-hidden transition-opacity",
                {
                  "aspect-video rounded": view === "windowed" && !isVertical,
                  "aspect-9/16 rounded": view === "windowed" && isVertical,
                  "h-full": view === "fullscreen",
                },
              )}
            />
            <div
              className={clsx("w-full overflow-hidden transition-opacity", {
                "aspect-video rounded": view === "windowed" && !isVertical,
                "aspect-9/16 rounded": view === "windowed" && isVertical,
                "h-full": view === "fullscreen",
                "opacity-0": !showVideo,
                "opacity-100": showVideo,
              })}
            >
              <ResponsiveVideo
                videoID={item.contentId}
                isInactive={isInactive}
              />
            </div>
          </div>
          {showNavButtons && (
            <ButtonWithShortcut
              shortcut="]"
              variant="ghost"
              onClick={goToNextVideo}
              disabled={!canGoToNext}
            >
              <ChevronRightIcon />
            </ButtonWithShortcut>
          )}
        </div>
      </div>
      <ContentActions contentID={id} />
    </>
  );
}
