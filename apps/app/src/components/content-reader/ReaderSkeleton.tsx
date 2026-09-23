"use client";

import type { ReactNode } from "react";
import { ReaderLayout } from "~/components/content-reader/ReaderLayout";
import classes from "~/components/feed/read/article.module.css";
import { Skeleton } from "~/components/ui/skeleton";

const PARAGRAPH_COUNT = 3;
/** Line widths for one prose paragraph; the last line runs short. */
const PARAGRAPH_LINE_WIDTHS = ["w-full", "w-full", "w-full", "w-2/3"] as const;

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
        <Skeleton data-serial-header className="h-[1.5rem] w-3/4" />
        <Skeleton data-serial-header className="h-[1rem] w-1/3" />
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
 * The article body's placeholder: three prose paragraphs in the article's
 * own font size and line pitch, so zoom applies and real paragraphs land
 * near the same height. The pending marker holds progress restoration.
 */
export function ReaderBodySkeleton() {
  return (
    <div role="status" aria-label="Loading article" data-reader-content-pending>
      {Array.from({ length: PARAGRAPH_COUNT }, (_, paragraph) => (
        <div
          key={paragraph}
          data-reader-skeleton-paragraph
          className="grid gap-[0.7em]"
        >
          {PARAGRAPH_LINE_WIDTHS.map((width, line) => (
            <Skeleton key={line} className={`h-[1em] ${width}`} />
          ))}
        </div>
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
