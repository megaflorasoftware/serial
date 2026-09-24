"use client";

import type { ReactNode } from "react";
import { ReaderLayout } from "~/components/content-reader/ReaderLayout";
import classes from "~/components/feed/read/article.module.css";
import { Skeleton } from "~/components/ui/skeleton";

/**
 * The stand-in body: a paragraph, a heading, then two paragraphs, each a
 * real block so it takes the article's own font size, line box and flow
 * spacing. One line per wrapped line of text; the last line runs short.
 */
const BODY_BLOCKS = [
  { id: "lead", tag: "p", lines: ["w-full", "w-full", "w-full", "w-2/3"] },
  { id: "heading", tag: "h2", lines: ["w-1/2"] },
  { id: "first", tag: "p", lines: ["w-full", "w-full", "w-3/4"] },
  { id: "second", tag: "p", lines: ["w-full", "w-full", "w-full", "w-1/2"] },
] as const;

/**
 * One wrapped line of text: a bar centred in the block's line box. Spans,
 * because a div inside a paragraph is split apart when the server's HTML
 * is parsed.
 */
function SkeletonLine({ width }: { width: string }) {
  return (
    <span data-reader-skeleton-line>
      <Skeleton as="span" className={`h-[1em] ${width}`} />
    </span>
  );
}

/** What the reader knows about where an article came from. */
export type ReaderSourceInfo = { icon: ReactNode; name: string };

/** What the reader knows about an article before its body. */
export type ReaderHeaderInfo = { title: string; author: string };

/** The feed or bookmark the article came from, or its skeleton. */
export function ReaderSource({ source }: { source: ReaderSourceInfo | null }) {
  if (!source) {
    return (
      <>
        <Skeleton className="size-6 rounded" />
        <Skeleton className="h-4 w-32" />
      </>
    );
  }
  return (
    <>
      {source.icon}
      <span className="line-clamp-1 font-sans text-sm">{source.name}</span>
    </>
  );
}

/** The title and author lines, or their skeletons when the item is unknown. */
export function ReaderHeader({ header }: { header: ReaderHeaderInfo | null }) {
  if (!header) {
    return (
      <>
        <h1 data-serial-header>
          <SkeletonLine width="w-3/4" />
        </h1>
        <h6 data-serial-header>
          <SkeletonLine width="w-1/3" />
        </h6>
      </>
    );
  }
  return (
    <>
      <h1 data-serial-header>{header.title}</h1>
      <h6 data-serial-header>{header.author}</h6>
    </>
  );
}

/**
 * The article body's placeholder. Its blocks carry no text, so navigation
 * skips them, and the pending marker holds progress restoration.
 */
export function ReaderBodySkeleton() {
  return (
    <div role="status" aria-label="Loading article" data-reader-content-pending>
      {BODY_BLOCKS.map(({ id, tag: Block, lines }) => (
        <Block key={id}>
          {lines.map((width, line) => (
            <SkeletonLine key={`${id}-${line}`} width={width} />
          ))}
        </Block>
      ))}
    </div>
  );
}

/**
 * The whole reader while nothing can be drawn yet: source row, header, and
 * body each show real data when it is known and a skeleton when it is not.
 */
export function ReaderSkeleton({
  source = null,
  header = null,
}: {
  source?: ReaderSourceInfo | null;
  header?: ReaderHeaderInfo | null;
}) {
  return (
    <ReaderLayout source={<ReaderSource source={source} />}>
      <div className={`h-full w-full px-6 sm:pb-6 ${classes.article}`}>
        <ReaderHeader header={header} />
        <ReaderBodySkeleton />
      </div>
    </ReaderLayout>
  );
}
