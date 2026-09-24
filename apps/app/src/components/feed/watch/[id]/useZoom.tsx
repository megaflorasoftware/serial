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

/**
 * The zoom for what is on screen. A /read item that is not known yet takes
 * the article zoom so its skeleton has the article's width; otherwise an
 * unknown item keeps the previously applied value until the new UI renders.
 */
function resolveZoom({
  isVideoPlatform,
  isVertical,
  isArticlePlatform,
  isUnknownReadItem,
  shortformVideoZoom,
  longformVideoZoom,
  articleZoom,
  lastZoom,
}: {
  isVideoPlatform: boolean;
  isVertical: boolean;
  isArticlePlatform: boolean;
  isUnknownReadItem: boolean;
  shortformVideoZoom: number;
  longformVideoZoom: number;
  articleZoom: number;
  lastZoom: number;
}) {
  if (isVideoPlatform)
    return isVertical ? shortformVideoZoom : longformVideoZoom;
  if (isArticlePlatform || isUnknownReadItem) return articleZoom;
  return lastZoom;
}

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
  const isUnknownReadItem = !platform && !!contentId;

  // Derived on render, not in an effect, so the server's HTML and the first
  // client paint already have the right width.
  const [lastZoom, setLastZoom] = useState(MIN_ZOOM);
  const zoom = resolveZoom({
    isVideoPlatform,
    isVertical,
    isArticlePlatform,
    isUnknownReadItem,
    shortformVideoZoom,
    longformVideoZoom,
    articleZoom,
    lastZoom,
  });
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
