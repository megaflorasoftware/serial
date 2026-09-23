"use client";

import type { ReactNode } from "react";
import {
  ReaderLayout,
  ReaderSource,
} from "~/components/content-reader/ReaderLayout";
import classes from "~/components/feed/read/article.module.css";
import { Skeleton } from "~/components/ui/skeleton";

const PARAGRAPH_COUNT = 3;
/** Line widths for one prose paragraph; the last line runs short. */
const PARAGRAPH_LINE_WIDTHS = ["w-full", "w-full", "w-full", "w-2/3"] as const;

/**
 * The article body's placeholder: three prose paragraphs in the article's
 * own font size and flow spacing, so zoom applies and real paragraphs land
 * near the same height. The pending marker holds progress restoration.
 */
export function ReaderBodySkeleton() {
  return (
    <div role="status" aria-label="Loading article" data-reader-content-pending>
      {Array.from({ length: PARAGRAPH_COUNT }, (_, paragraph) => (
        <div key={paragraph} className="grid gap-[0.7em]">
          {PARAGRAPH_LINE_WIDTHS.map((width, line) => (
            <Skeleton key={line} className={`h-[1em] ${width}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** The title and author lines, or their skeletons when the item is unknown. */
export function ReaderHeader({
  header,
}: {
  header: { title: string; author: string } | null;
}) {
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
 * The whole reader while nothing can be drawn yet: source row, header, and
 * body each show real data when it is known and a skeleton when it is not.
 */
export function ReaderSkeleton({
  source = null,
  header = null,
}: {
  source?: Parameters<typeof ReaderSource>[0]["source"];
  header?: Parameters<typeof ReaderHeader>[0]["header"];
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

export type ReaderSkeletonProps = Parameters<typeof ReaderSkeleton>[0];
export type ReaderSourceInfo = NonNullable<ReaderSkeletonProps["source"]>;
export type ReaderHeaderInfo = NonNullable<ReaderSkeletonProps["header"]>;

export function readerSourceInfo(
  source: { imageUrl: string | null | undefined; name: string } | undefined,
  fallback: ReactNode,
): ReaderSourceInfo | null {
  return source
    ? { imageUrl: source.imageUrl ?? null, name: source.name, fallback }
    : null;
}
