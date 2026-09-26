"use client";

import { Element } from "html-react-parser";
import type { HTMLReactParserOptions } from "html-react-parser";
import type { ExternalContentVisibility } from "~/components/content-reader/ExternalContent";
import { ExternalContent } from "~/components/content-reader/ExternalContent";
import { ArticleContent } from "~/components/feed/read/ArticleContent";

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Renders a Page capture. Captures are sanitized on the server before they
 * are stored, so the body goes straight to the shared HTML renderer, which
 * intercepts every frame. Version 1 captures replaced YouTube frames with a
 * placeholder element; that placeholder is turned back into the frame it
 * stood for so it reaches the same interception.
 */
export function BookmarkArticleContent({
  content,
  externalContent,
  noticeHref,
  originActionLabel,
}: {
  content: string;
  externalContent: ExternalContentVisibility;
  noticeHref: string;
  originActionLabel: string;
}) {
  return (
    <ArticleContent
      content={content}
      externalContent={externalContent}
      noticeHref={noticeHref}
      originActionLabel={originActionLabel}
      replace={legacyYouTubePlaceholder(
        externalContent,
        noticeHref,
        originActionLabel,
      )}
    />
  );
}

function legacyYouTubePlaceholder(
  externalContent: ExternalContentVisibility,
  noticeHref: string,
  originActionLabel: string,
): HTMLReactParserOptions["replace"] {
  return (node) => {
    if (!(node instanceof Element)) return;
    if (node.attribs["data-serial-embed"] !== "youtube") return;
    const videoId = node.attribs["data-video-id"];
    if (!videoId || !YOUTUBE_VIDEO_ID.test(videoId)) return <></>;
    const start = node.attribs["data-start"];
    const query = start && /^\d+$/.test(start) ? `?start=${start}` : "";
    return (
      <ExternalContent
        source={{
          kind: "src",
          src: `https://www.youtube-nocookie.com/embed/${videoId}${query}`,
        }}
        visibility={externalContent}
        noticeHref={noticeHref}
        originActionLabel={originActionLabel}
        height={null}
        aspectRatio={null}
      />
    );
  };
}
