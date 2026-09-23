"use client";

import { CustomVideoPlayer } from "~/components/CustomVideoPlayer";
import { useFlagState } from "~/lib/hooks/useFlagState";
import { ARTICLE_BLOCK_ATTRIBUTE } from "~/lib/hooks/useArticleNavigation";

/**
 * A YouTube video inside an article: the custom player, or the privacy embed
 * when the flag asks for it. Shared by HTML bodies and Reader documents so the
 * navigation and progress contracts see one `data-article-video-embed` shape.
 */
export function ArticleVideoEmbed({
  videoId,
  start,
}: {
  videoId: string;
  start?: string | null;
}) {
  const [videoPlayer] = useFlagState("CUSTOM_VIDEO_PLAYER");

  if (videoPlayer === "serial") {
    return (
      <div
        data-article-video-embed="serial"
        {...{ [ARTICLE_BLOCK_ATTRIBUTE]: "" }}
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
      data-article-video-embed="youtube"
      {...{ [ARTICLE_BLOCK_ATTRIBUTE]: "" }}
      className="aspect-video w-full overflow-hidden rounded"
    >
      <iframe
        width="1600"
        height="900"
        src={`https://www.youtube-nocookie.com/embed/${videoId}${start ? `?start=${start}` : ""}`}
        title="YouTube video player"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        className="h-full w-full border-none"
      />
    </div>
  );
}
