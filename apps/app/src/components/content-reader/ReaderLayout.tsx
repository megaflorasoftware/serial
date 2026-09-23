"use client";

import clsx from "clsx";
import type { ReactNode } from "react";
import { getArticleWidthLayout } from "~/components/content-reader/articleWidth";
import { useZoom } from "~/components/feed/watch/[id]/useZoom";

/**
 * The reader column every `/read` surface shares: zoom-driven width, the
 * source row above the article, and the sticky action bar below it.
 */
export function ReaderLayout({
  source,
  actions,
  barsHidden = false,
  children,
}: {
  source: ReactNode;
  actions?: ReactNode;
  barsHidden?: boolean;
  children: ReactNode;
}) {
  const { zoom } = useZoom();
  const articleWidthLayout = getArticleWidthLayout(zoom);
  return (
    <div
      className={clsx(
        "mx-auto grid h-full w-full place-items-center",
        articleWidthLayout.className,
      )}
      style={articleWidthLayout.style}
    >
      <div className="mb-4 flex w-full items-center gap-3 px-6 sm:pt-6">
        {source}
      </div>
      {children}
      {actions ? (
        <div
          className={clsx(
            "sticky inset-x-0 bottom-0 left-0 grid place-items-center transition-transform duration-300",
            barsHidden && "translate-y-full",
          )}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}
