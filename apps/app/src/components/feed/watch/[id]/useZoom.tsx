"use client";

import { useLocation } from "@tanstack/react-router";
import { useAtom } from "jotai";
import { useCallback, useEffect, useState } from "react";
import type { ContentPlatform } from "~/lib/content/descriptor";
import {
  articleZoomAtom,
  longformVideoZoomAtom,
  shortformVideoZoomAtom,
} from "~/lib/data/atoms";
import { useFeedItemValue } from "~/lib/data/store";
import { useBookmarkValue } from "~/lib/data/bookmarks";

export const MIN_ZOOM = 0;
export const MAX_ZOOM = 6;

export const MIN_ZOOM_VERTICAL = 0;
export const MAX_ZOOM_VERTICAL = 3;

const VIDEO_PLATFORMS: ContentPlatform[] = ["youtube", "peertube"];
const ARTICLE_PLATFORMS: ContentPlatform[] = ["website"];

export function useZoom() {
  const { pathname } = useLocation();
  const videoId = pathname.split("/watch/")[1]!;
  const contentId = pathname.split("/read/")[1]!;

  const feedItem = useFeedItemValue(videoId || contentId || "");
  const bookmark = useBookmarkValue(videoId || contentId || "");

  const platform = feedItem?.platform ?? bookmark?.platform ?? "";
  const isVertical =
    (feedItem?.orientation ?? bookmark?.orientation) === "vertical";

  const minZoom = isVertical ? MIN_ZOOM_VERTICAL : MIN_ZOOM;
  const maxZoom = isVertical ? MAX_ZOOM_VERTICAL : MAX_ZOOM;

  const [longformVideoZoom, setLongformVideoZoom] = useAtom(
    longformVideoZoomAtom,
  );
  const [shortformVideoZoom, setShortformVideoZoom] = useAtom(
    shortformVideoZoomAtom,
  );
  const [articleZoom, setArticleZoom] = useAtom(articleZoomAtom);

  const isVideoPlatform = VIDEO_PLATFORMS.includes(platform);
  const isArticlePlatform = ARTICLE_PLATFORMS.includes(platform);
  // Nothing is known about a /read item yet: the skeleton takes the width
  // the article will have.
  const isUnknownReadItem = !platform && !!contentId;

  // Derived on render, not in an effect, so the server's HTML and the first
  // client paint already have the right width. While navigating to an item
  // that is not known yet, the previously applied value stands until the
  // new UI has rendered.
  const [lastZoom, setLastZoom] = useState(MIN_ZOOM);
  let zoom = lastZoom;
  if (isVideoPlatform && isVertical) zoom = shortformVideoZoom;
  else if (isVideoPlatform) zoom = longformVideoZoom;
  else if (isArticlePlatform || isUnknownReadItem) zoom = articleZoom;
  useEffect(() => {
    setLastZoom(zoom);
  }, [zoom]);

  const zoomIn = useCallback(() => {
    if (isVideoPlatform) {
      const setVideoZoom = isVertical
        ? setShortformVideoZoom
        : setLongformVideoZoom;
      setVideoZoom((z) => {
        if (z >= maxZoom) {
          return z;
        }
        return z + 1;
      });
    }
    if (isArticlePlatform) {
      setArticleZoom((z) => {
        if (z >= MAX_ZOOM) {
          return z;
        }
        return z + 1;
      });
    }
    return () => {};
  }, [
    isVideoPlatform,
    isVertical,
    setShortformVideoZoom,
    setLongformVideoZoom,
    maxZoom,
    isArticlePlatform,
    setArticleZoom,
  ]);

  const zoomOut = useCallback(() => {
    if (isVideoPlatform) {
      const setVideoZoom = isVertical
        ? setShortformVideoZoom
        : setLongformVideoZoom;
      setVideoZoom((z) => {
        if (z <= minZoom) {
          return z;
        }
        return z - 1;
      });
    }
    if (isArticlePlatform) {
      setArticleZoom((z) => {
        if (z <= MIN_ZOOM) {
          return z;
        }
        return z - 1;
      });
    }
    return () => {};
  }, [
    isVideoPlatform,
    isVertical,
    setShortformVideoZoom,
    setLongformVideoZoom,
    minZoom,
    isArticlePlatform,
    setArticleZoom,
  ]);

  return {
    zoom,
    zoomIn,
    zoomOut,
    isVertical,
    minZoom,
    maxZoom,
  };
}
