"use client";

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useZoom } from "../components/feed/watch/[id]/useZoom";
import { ContentActions } from "../components/feed/watch/[id]/ContentActions";
import type { ExternalContentVisibility } from "~/components/content-reader/ExternalContent";
import { useFeeds } from "~/lib/data/feeds";
import { barsHiddenAtom } from "~/lib/data/atoms";
import { useExternalContentVisibility } from "~/lib/hooks/useExternalContentVisibility";
import classes from "~/components/feed/read/article.module.css";
import { useFeedItemValue } from "~/lib/data/store";
import {
  hasReaderBodyContent,
  readerContent,
} from "~/lib/data/feed-items/readerBody";
import { ArticleContent } from "~/components/feed/read/ArticleContent";
import { ReaderDocumentContent } from "~/components/content-reader/ReaderDocumentContent";
import { getOriginActionLabel } from "~/lib/content/capabilities";
import { useOpenOriginalShortcut } from "~/lib/hooks/useOpenOriginalShortcut";
import {
  getClosestVisibleElement,
  getElements,
  useArticleNavigation,
} from "~/lib/hooks/useArticleNavigation";
import { useDebouncedSaveProgress } from "~/lib/hooks/useDebouncedSaveProgress";
import { useRefreshFeedItem } from "~/lib/hooks/useRefreshFeedItem";
import { useRestoreArticleProgress } from "~/lib/hooks/useRestoreArticleProgress";
import { useScrollDirection } from "~/lib/hooks/useScrollDirection";
import { ArticleSidebars } from "~/components/feed/read/ArticleSidebars";
import {
  TruncationAlert,
  useTruncationAlert,
} from "~/components/feed/read/TruncationAlert";
import { useRetentionPin } from "~/lib/hooks/useRetentionPin";
import { useBookmarkValue } from "~/lib/data/bookmarks";
import { BookmarkReader } from "~/components/content-reader/BookmarkReader";
import { ContentRendererFallback } from "~/components/content-renderer/ContentRendererFallback";
import { ReaderLayout } from "~/components/content-reader/ReaderLayout";
import { REMOTE_IMAGE_PROPS } from "~/lib/remoteMedia";
import {
  ReaderBodySkeleton,
  ReaderHeader,
  ReaderSkeleton,
  ReaderSource,
} from "~/components/content-reader/ReaderSkeleton";
import { useCanMutate } from "~/lib/data/offline-mutations";
import {
  contentDestination,
  resolveContentItem,
} from "~/lib/data/content-items/resolver";
import { CONTENT_PLATFORM } from "~/lib/content/descriptor";

export const Route = createFileRoute("/_app/read/$id")({
  component: ReadPage,
});

function ReadPage() {
  const params = Route.useParams();
  const bookmark = useBookmarkValue(params.id);
  const feedItem = useFeedItemValue(params.id);
  const feedItemRefresh = useRefreshFeedItem(bookmark ? undefined : params.id);
  const resolution = resolveContentItem({ bookmark, feedItem });
  if (resolution.status === "ambiguous") {
    return <p className="p-6 text-center">This content ID is ambiguous.</p>;
  }
  if (resolution.status === "missing") {
    return <ReaderSkeleton />;
  }
  const destination = contentDestination(resolution.item);
  if (destination.renderer !== "read") {
    return <ContentRendererFallback destination={destination} />;
  }
  if (resolution.item.entityKind === "bookmark") {
    return <BookmarkReader id={params.id} />;
  }
  return (
    <FeedReader
      id={params.id}
      hasRefreshedFeedItem={feedItemRefresh.complete}
    />
  );
}

// Show/hide header and footer bars based on scroll direction
function useReaderBars() {
  const setBarsHidden = useSetAtom(barsHiddenAtom);
  const barsHidden = useAtomValue(barsHiddenAtom);
  const handleScrollDirection = useCallback(
    (direction: "up" | "down") => {
      setBarsHidden(direction === "down");
    },
    [setBarsHidden],
  );
  useScrollDirection(handleScrollDirection);

  // Reset bars visibility when leaving the article
  useEffect(() => {
    return () => {
      setBarsHidden(false);
    };
  }, [setBarsHidden]);

  return barsHidden;
}

type FeedReaderFeed = ReturnType<typeof useFeeds>["feeds"][number];
type FeedReaderItem = ReturnType<typeof useFeedItemValue>;

function feedReaderSource(feed: FeedReaderFeed | undefined) {
  if (!feed) return null;
  return {
    name: feed.name,
    icon: feed.imageUrl ? (
      <img
        {...REMOTE_IMAGE_PROPS}
        src={feed.imageUrl}
        alt=""
        className="aspect-square size-6 rounded object-cover"
      />
    ) : (
      <div className="bg-muted aspect-square size-6 rounded" />
    ),
  };
}

function feedReaderHeader(
  feedItem: FeedReaderItem,
  feed: FeedReaderFeed | undefined,
) {
  if (!feedItem) return null;
  return {
    title: feedItem.title,
    author: feedItem.author || feed?.name || "",
  };
}

/** The body: skeleton while pending, else the document or HTML reader. */
function FeedReaderBody({
  pending,
  reader,
  feedItem,
  feed,
  externalContent,
}: {
  pending: boolean;
  reader: ReturnType<typeof readerContent>;
  feedItem: FeedReaderItem;
  feed: FeedReaderFeed | undefined;
  externalContent: ExternalContentVisibility;
}) {
  if (pending) return <ReaderBodySkeleton />;
  const noticeHref = feedItem?.url ?? "";
  const originActionLabel = getOriginActionLabel({
    platform: feed?.platform ?? CONTENT_PLATFORM.WEBSITE,
    contentType: feedItem?.contentType ?? "text",
  });
  if (reader?.form === "document") {
    return (
      <ReaderDocumentContent
        document={reader.document}
        documentUrl={noticeHref}
        originActionLabel={originActionLabel}
        externalContent={externalContent}
      />
    );
  }
  return (
    <ArticleContent
      content={reader?.form === "html" ? reader.html : ""}
      externalContent={externalContent}
      noticeHref={noticeHref}
      originActionLabel={originActionLabel}
    />
  );
}

function FeedReader({
  id,
  hasRefreshedFeedItem,
}: {
  id: string;
  hasRefreshedFeedItem: boolean;
}) {
  const canMutate = useCanMutate();
  useRetentionPin("feed-item", id);

  const externalContent = useExternalContentVisibility(id);

  const feedItem = useFeedItemValue(id);

  const { feeds } = useFeeds();

  const feed = feeds.find((f) => f.id === feedItem?.feedId);

  const { zoom } = useZoom();

  // Deriving a Document source is the expensive step, so it is keyed on the
  // body identity rather than on the zoom the reader also reads.
  // A reference refresh replaces the body object and re-derives; the
  // revision stays, so progress does not move.
  const body = feedItem?.body;
  const reader = useMemo(() => readerContent(body), [body]);
  // A body already on the client draws at once; the skeleton fills in only
  // while the server has not yet answered. An empty answer draws nothing.
  const isBodyPending = !hasReaderBodyContent(body) && !hasRefreshedFeedItem;

  const articleRef = useRef<HTMLDivElement>(null);
  const [articleElement, setArticleElement] = useState<HTMLDivElement | null>(
    null,
  );
  const updateArticleRef = useCallback((element: HTMLDivElement | null) => {
    articleRef.current = element;
    setArticleElement(element);
  }, []);

  const barsHidden = useReaderBars();

  // Shortcut to open original URL
  useOpenOriginalShortcut(feedItem?.url);

  // Arrow key navigation between paragraphs/headings
  const { scrollToElement } = useArticleNavigation(articleRef);
  useRestoreArticleProgress({
    contentId: id,
    articleElement,
    progress: feedItem?.progress,
    ready: hasRefreshedFeedItem,
  });

  // Save progress 500ms after last scroll event
  useDebouncedSaveProgress({
    contentId: id,
    getProgress: () => {
      const elements = getElements(articleRef.current);
      const closestVisibleIndex = getClosestVisibleElement(elements);
      return {
        progress: Math.max(closestVisibleIndex, 0),
        duration: elements.length,
      };
    },
  });

  const { shouldShowTruncationAlert, handleAlertResponse } = useTruncationAlert(
    { feed, feedItem, canMutate },
  );

  return (
    <ReaderLayout
      source={<ReaderSource source={feedReaderSource(feed)} />}
      actions={<ContentActions contentID={id} />}
      barsHidden={barsHidden}
    >
      <div key={id} className="relative w-full">
        <ArticleSidebars
          article={articleElement}
          contentKey={`${id}:${externalContent}:${zoom}:${body?.revision ?? ""}:${reader?.form === "document" ? reader.document.footnotes.length : (reader?.html ?? "")}`}
          scrollToElement={scrollToElement}
        />
        <div
          ref={updateArticleRef}
          className={`h-full w-full px-6 sm:pb-6 ${classes.article}`}
        >
          <ReaderHeader header={feedReaderHeader(feedItem, feed)} />
          <FeedReaderBody
            pending={isBodyPending}
            reader={reader}
            feedItem={feedItem}
            feed={feed}
            externalContent={externalContent}
          />
        </div>
      </div>
      {shouldShowTruncationAlert && (
        <TruncationAlert
          canMutate={canMutate}
          onRespond={handleAlertResponse}
        />
      )}
    </ReaderLayout>
  );
}
