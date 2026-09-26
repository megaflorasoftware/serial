"use client";

import { parseYouTubeReference } from "@serial/standard-site";
import type { ReaderAspectRatio, YouTubeReference } from "@serial/standard-site";
import type { SandboxedFrameSource } from "~/components/content-reader/SandboxedFrame";
import { ArticleVideoEmbed } from "~/components/content-reader/ArticleVideoEmbed";
import { ReaderNotice } from "~/components/content-reader/ReaderNotice";
import { SandboxedFrame } from "~/components/content-reader/SandboxedFrame";

/**
 * The one interception point for External content: every frame in an item
 * body, whether it arrived through an RSS body, a platform block or a
 * Bookmark capture, is decided here. YouTube goes to the video embed, an
 * `https` source or authored markup goes to the sandboxed frame, and anything
 * else, or any frame while External content is hidden, is the notice.
 */

/** Whether the reader shows External content in this body: the preference and the offline latch, combined upstream. */
export type ExternalContentVisibility = "show" | "hide";

export type ExternalContentProps = {
  source: SandboxedFrameSource;
  visibility: ExternalContentVisibility;
  /** The item's own page, the target of the notice. */
  noticeHref: string;
  originActionLabel: string;
  height: number | null;
  aspectRatio: ReaderAspectRatio | null;
  title?: string;
  /** A YouTube reference the caller already derived; otherwise the source is parsed. */
  youtube?: YouTubeReference | null;
};

function isHttps(url: string) {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function ExternalContent({
  source,
  visibility,
  noticeHref,
  originActionLabel,
  height,
  aspectRatio,
  title = "Embedded content",
  youtube: derivedYouTube,
}: ExternalContentProps) {
  const notice = (
    <ReaderNotice
      kind="externalContent"
      href={noticeHref}
      originActionLabel={originActionLabel}
    />
  );
  if (visibility === "hide") return notice;
  if (source.kind === "html") {
    return (
      <SandboxedFrame
        source={source}
        title={title}
        height={height}
        aspectRatio={aspectRatio}
      />
    );
  }
  const youtube = derivedYouTube ?? parseYouTubeReference(source.src);
  if (youtube)
    return <ArticleVideoEmbed videoId={youtube.videoId} start={youtube.start} />;
  if (!isHttps(source.src)) return notice;
  return (
    <SandboxedFrame
      source={source}
      title={title}
      height={height}
      aspectRatio={aspectRatio}
    />
  );
}

/** A stored `height` attribute, accepted within the same range as authored frames. */
export function storedFrameHeight(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) return null;
  const height = Number(value);
  return height >= 16 && height <= 1600 ? height : null;
}
