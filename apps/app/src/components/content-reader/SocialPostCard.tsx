import { useAtomValue } from "jotai";
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { ReaderImage, ReaderSocialPost } from "@serial/standard-site";
import { RowPreviewImage } from "~/components/content-reader/RecordCard";
import { SocialVideoPlayer } from "~/components/content-reader/SocialVideoPlayer";
import { isDisconnectedAtom } from "~/lib/data/atoms";
import { REMOTE_IMAGE_PROPS } from "~/lib/remoteMedia";
import { timeAgo } from "~/lib/utils";

const PLATFORM_NAMES = { bluesky: "Bluesky", pckt: "pckt" } as const;

/** A remote image that leaves no gap once it fails. */
function RemoteImage({
  src,
  alt = "",
  attribute,
  value = "",
  style,
}: {
  src: string;
  alt?: string;
  attribute: string;
  value?: string;
  style?: CSSProperties;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      {...REMOTE_IMAGE_PROPS}
      {...{ [attribute]: value }}
      src={src}
      alt={alt}
      style={style}
      onError={() => setFailed(true)}
    />
  );
}

function ExternalLink({
  href,
  children,
  ...attributes
}: {
  href: string;
  children: ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...attributes}>
      {children}
    </a>
  );
}

function aspectStyle(ratio: ReaderImage["aspectRatio"]) {
  return ratio
    ? { aspectRatio: `${ratio.width} / ${ratio.height}` }
    : undefined;
}

export type SocialPostCardProps = {
  post: ReaderSocialPost;
  /** The post's text, rendered by the caller so facets draw like body text. */
  text: ReactNode;
  /** The quoted record's card, rendered by the caller; null when unresolved. */
  quote: ReactNode;
  /** The static style: a video stays a poster, never a player. */
  simplified?: boolean;
};

/**
 * A Bluesky post or pckt note as an inline card: author header, text, media,
 * one level of quote. The whole card is a stretched link to the post; the
 * author link, the text's own links, the external preview and the quote
 * are layered above it. No engagement counts are drawn.
 */
export function SocialPostCard({
  post,
  text,
  quote,
  simplified = false,
}: SocialPostCardProps) {
  const platform = PLATFORM_NAMES[post.platform];
  const offline = useAtomValue(isDisconnectedAtom);
  const date = post.createdAt ? new Date(post.createdAt) : null;
  const posted = date && Number.isFinite(date.getTime()) ? timeAgo(date) : null;
  const name = post.author.name ?? post.author.handle ?? post.author.did;
  return (
    <div
      role="note"
      data-social-post={post.platform}
      data-record-card="row"
      data-article-block=""
    >
      {/* The card opens the post; only the author link and the body's own links sit above it. */}
      <ExternalLink href={post.url} data-social-post-link="">
        <span className="sr-only">Open post on {platform}</span>
      </ExternalLink>
      <div data-social-post-header>
        <ExternalLink href={post.author.url} data-social-post-author="">
          {post.author.avatarUrl ? (
            <RemoteImage
              key={post.author.avatarUrl}
              src={post.author.avatarUrl}
              attribute="data-social-post-avatar"
            />
          ) : (
            <span data-social-post-avatar aria-hidden="true" />
          )}
          <span data-social-post-name>{name}</span>
          {post.author.handle && post.author.name && (
            <span data-social-post-handle>@{post.author.handle}</span>
          )}
        </ExternalLink>
        {posted && (
          <time dateTime={post.createdAt ?? undefined} data-social-post-time>
            {posted}
          </time>
        )}
      </div>
      <div data-social-post-body>
        <p data-social-post-text>{text}</p>
        {post.images.length > 0 && (
          <div data-social-post-images={post.images.length}>
            {post.images.map((image) => (
              <RemoteImage
                key={image.url}
                src={image.url}
                alt={image.alt}
                attribute="data-social-post-image"
                style={aspectStyle(image.aspectRatio)}
              />
            ))}
          </div>
        )}
        {post.video && (
          <div data-social-post-video>
            {simplified || offline ? (
              <RemoteImage
                key={post.video.thumbnailUrl}
                src={post.video.thumbnailUrl}
                alt={
                  post.video.alt || `Video preview from the post on ${platform}`
                }
                attribute="data-social-post-image"
                style={aspectStyle(post.video.aspectRatio)}
              />
            ) : (
              <SocialVideoPlayer
                key={post.video.playlistUrl}
                video={post.video}
                platform={platform}
                style={aspectStyle(post.video.aspectRatio)}
              />
            )}
          </div>
        )}
        {post.mediaHidden && (
          <p data-social-post-hidden>
            Media hidden by the author&apos;s content labels.
          </p>
        )}
        {post.external && (
          <ExternalLink
            href={post.external.href}
            data-record-card="row"
            data-reader-link-card=""
          >
            {post.external.imageUrl && (
              <RowPreviewImage
                key={post.external.imageUrl}
                src={post.external.imageUrl}
              />
            )}
            <div data-record-copy>
              <p data-record-title>{post.external.title}</p>
              {post.external.description && (
                <p data-record-description>{post.external.description}</p>
              )}
            </div>
          </ExternalLink>
        )}
        {quote && <div data-social-post-quote>{quote}</div>}
      </div>
    </div>
  );
}
