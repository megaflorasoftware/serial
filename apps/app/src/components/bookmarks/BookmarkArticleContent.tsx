"use client";

import createDOMPurify from "dompurify";
import parse, { Element } from "html-react-parser";
import { useMemo, useSyncExternalStore } from "react";
import type { HTMLReactParserOptions } from "html-react-parser";
import { CustomVideoPlayer } from "~/components/CustomVideoPlayer";
import { flattenReaderImages } from "~/components/content-reader/flattenReaderImages";
import { ArticleImageLightbox } from "~/components/feed/read/ArticleImageLightbox";
import { useFlagState } from "~/lib/hooks/useFlagState";
import {
  BOOKMARK_CAPTURE_ALLOWED_ATTRIBUTES,
  BOOKMARK_CAPTURE_ALLOWED_TAGS,
} from "~/server/bookmarks/sanitizePolicy";

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const subscribeToClientSnapshot = () => () => undefined;

export function BookmarkArticleContent({ content }: { content: string }) {
  const [videoPlayer] = useFlagState("CUSTOM_VIDEO_PLAYER");
  const clientSanitizedContent = useMemo(() => {
    if (typeof window === "undefined") return "";
    return createDOMPurify(window).sanitize(content, {
      ALLOWED_TAGS: [...BOOKMARK_CAPTURE_ALLOWED_TAGS],
      ALLOWED_ATTR: [...BOOKMARK_CAPTURE_ALLOWED_ATTRIBUTES],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    });
  }, [content]);
  const sanitizedContent = useSyncExternalStore(
    subscribeToClientSnapshot,
    () => clientSanitizedContent,
    () => "",
  );

  if (!sanitizedContent) {
    return (
      <p role="status" data-reader-content-pending>
        Preparing Page capture…
      </p>
    );
  }

  const options: HTMLReactParserOptions = {
    replace: (node) => {
      if (!(node instanceof Element)) return;
      if (node.name === "a" && node.attribs.href?.startsWith("http")) {
        node.attribs.target = "_blank";
        node.attribs.rel = "noopener noreferrer";
      }
      if (node.name === "img") {
        const src = node.attribs.src;
        if (!src) return <></>;
        const width = Number(node.attribs.width);
        const height = Number(node.attribs.height);
        return (
          <ArticleImageLightbox
            src={src}
            alt={node.attribs.alt ?? ""}
            aspectRatio={
              width > 0 && height > 0 && Number.isFinite(width + height)
                ? { width, height }
                : null
            }
          />
        );
      }
      if (node.attribs["data-serial-embed"] !== "youtube") return;
      const videoId = node.attribs["data-video-id"];
      if (!videoId || !YOUTUBE_VIDEO_ID.test(videoId)) return <></>;
      const start = node.attribs["data-start"];
      const validStart = start && /^\d+$/.test(start) ? start : null;

      if (videoPlayer === "serial") {
        return (
          <div
            data-article-video-embed
            className="aspect-video w-full overflow-hidden rounded"
          >
            <CustomVideoPlayer
              videoID={videoId}
              orientation="horizontal"
              isInactive={false}
              isEmbed
            />
          </div>
        );
      }
      return (
        <div
          data-article-video-embed
          className="aspect-video w-full overflow-hidden rounded"
        >
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${videoId}${validStart ? `?start=${validStart}` : ""}`}
            title="YouTube video player"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-presentation"
            className="h-full w-full border-none"
          />
        </div>
      );
    },
  };

  const parsed = parse(sanitizedContent, options);
  const nodes = Array.isArray(parsed) ? parsed : [parsed];

  return <>{flattenReaderImages(nodes)}</>;
}
