"use client";

import { createFileRoute } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { Loader2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { getInitialFeedDataFromFileInputElement } from "../components/feed/import/utils/getInitialFeedDataFromFileInputElement";
import type {
  ImportFeedDataFromFilesError,
  ImportFeedDataItem,
} from "../components/feed/import/utils/shared";
import { useDialogStore } from "~/components/feed/dialogStore";
import { ImportFeedList } from "~/components/feed/import/ImportFeedList";
import {
  ImportFinished,
  ImportInstructions,
} from "~/components/feed/import/ImportScreens";
import { ImportLoading } from "~/components/ImportLoading";
import { Button } from "~/components/ui/button";
import { shouldAlwaysKeepSSEConnectionAlive } from "~/lib/data/atoms";
import { useFeeds } from "~/lib/data/feeds";
import { useImportDropStore } from "~/lib/data/import-drop";
import { useImportResults, useLoadingMode } from "~/lib/data/loading-machine";
import { dataRequestActions } from "~/lib/data/directRequests";
import { IS_DEMO_INSTANCE } from "~/lib/demo";
import { MAX_BULK_MUTATION_ITEMS } from "~/lib/schemas/bulk";
import { useCanMutate } from "~/lib/data/offline-mutations";
import { findFeedWithRssUrl, getFeedRssUrl } from "~/lib/feeds/origins";

export const Route = createFileRoute("/_app/import")({
  component: EditFeedsPage,
});

function useIsAtBottom(dep: unknown) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(false);

  useEffect(() => {
    if (!bottomRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsAtBottom(entry?.isIntersecting ?? false);
      },
      { threshold: 0 },
    );

    observer.observe(bottomRef.current);
    return () => observer.disconnect();
  }, [dep]);

  return { bottomRef, isAtBottom };
}

// Keep SSE open during import so visibility changes don't disconnect the
// streaming import. Reset when the import loader is hidden.
function useKeepSSEAliveDuringImport({
  isFetchingRss,
  hasStartedImport,
}: {
  isFetchingRss: boolean;
  hasStartedImport: boolean;
}) {
  const setShouldAlwaysKeepSSEConnectionAlive = useSetAtom(
    shouldAlwaysKeepSSEConnectionAlive,
  );

  useEffect(() => {
    if (!isFetchingRss && hasStartedImport) {
      setShouldAlwaysKeepSSEConnectionAlive(false);
    }
  }, [isFetchingRss, hasStartedImport, setShouldAlwaysKeepSSEConnectionAlive]);

  useEffect(() => {
    return () => {
      setShouldAlwaysKeepSSEConnectionAlive(false);
    };
  }, [setShouldAlwaysKeepSSEConnectionAlive]);

  return setShouldAlwaysKeepSSEConnectionAlive;
}

function useImportDeactivatedToast(
  isImportComplete: boolean,
  importDeactivatedCount: number,
) {
  const { launchDialog } = useDialogStore();

  useEffect(() => {
    if (isImportComplete && importDeactivatedCount > 0) {
      const count = importDeactivatedCount;

      if (IS_DEMO_INSTANCE) {
        toast.warning(
          `${count} feed${count > 1 ? "s were" : " was"} added as inactive. This is the limit for the demo instance.`,
        );
      } else {
        toast.warning(
          `${count} feed${count > 1 ? "s were" : " was"} added as inactive. To unlock more active feeds, you can switch to a higher plan.`,
          {
            action: {
              label: "Upgrade",
              onClick: () =>
                launchDialog("subscription", { subscriptionView: "picker" }),
            },
          },
        );
      }
    }
  }, [isImportComplete, importDeactivatedCount, launchDialog]);
}

// Already-added feeds are not selectable, but the ones carrying OPML
// sections or tags are still sent so a re-import links them into the
// matching views. The request schema caps items at MAX_BULK_MUTATION_ITEMS;
// selected feeds take priority and organized already-added ones fill the
// remainder, both keeping file order (section placement follows submission
// order). Anything beyond the cap is left for a follow-up import.
function getImportSubmission(
  feedsFoundFromFile: ImportFeedDataItem[] | null,
  existingFeedUrls: Set<string>,
) {
  const channels = feedsFoundFromFile ?? [];
  const selectedChannels = channels.filter((channel) => channel.shouldImport);
  const organizedAlreadyAddedChannels = channels.filter(
    (channel) =>
      !channel.shouldImport &&
      existingFeedUrls.has(channel.feedUrl) &&
      (channel.categoryPaths?.length ||
        channel.tagNames?.length ||
        channel.categories.length),
  );
  const alreadyAddedUrlsToSubmit = new Set(
    organizedAlreadyAddedChannels
      .slice(0, Math.max(0, MAX_BULK_MUTATION_ITEMS - selectedChannels.length))
      .map((channel) => channel.feedUrl),
  );
  const channelsToSubmit = channels
    .filter(
      (channel) =>
        channel.shouldImport || alreadyAddedUrlsToSubmit.has(channel.feedUrl),
    )
    .slice(0, MAX_BULK_MUTATION_ITEMS);
  const leftOutByLimitCount =
    selectedChannels.length +
    organizedAlreadyAddedChannels.length -
    channelsToSubmit.length;

  return { selectedChannels, channelsToSubmit, leftOutByLimitCount };
}

// One import run's lifecycle changes together (submit, stream start, stream
// end, settle, reset), so it lives in a single reducer.
type ImportRunState = {
  hasStartedImport: boolean;
  isImportComplete: boolean;
  isImportPending: boolean;
  leftOutByLimitUrls: Set<string>;
};

type ImportRunAction =
  | { type: "submitted"; leftOutByLimitUrls: Set<string> }
  | { type: "started" }
  | { type: "completed" }
  | { type: "settled" }
  | { type: "reset" };

const INITIAL_IMPORT_RUN: ImportRunState = {
  hasStartedImport: false,
  isImportComplete: false,
  isImportPending: false,
  leftOutByLimitUrls: new Set(),
};

function importRunReducer(
  state: ImportRunState,
  action: ImportRunAction,
): ImportRunState {
  switch (action.type) {
    case "submitted":
      return {
        ...state,
        isImportPending: true,
        leftOutByLimitUrls: action.leftOutByLimitUrls,
      };
    case "started":
      return { ...state, hasStartedImport: true };
    case "completed":
      return { ...state, isImportComplete: true };
    case "settled":
      return { ...state, isImportPending: false };
    case "reset":
      return INITIAL_IMPORT_RUN;
  }
}

function ImportFooter({
  isAtBottom,
  submitCount,
  isImportPending,
  hasStartedImport,
  onFeedImport,
}: {
  isAtBottom: boolean;
  submitCount: number;
  isImportPending: boolean;
  hasStartedImport: boolean;
  onFeedImport: () => void;
}) {
  return (
    <div
      data-testid="import-footer"
      className={`bg-background sticky bottom-0 z-10 border-t transition-[border-color] ${
        isAtBottom ? "border-transparent" : "border-border"
      }`}
    >
      <div className="mx-auto max-w-2xl px-6 py-4">
        <Button
          className="w-full gap-2"
          size="lg"
          onClick={onFeedImport}
          disabled={submitCount === 0 || isImportPending}
        >
          {isImportPending && !hasStartedImport ? (
            <>
              Importing...
              <Loader2Icon size={16} className="animate-spin" />
            </>
          ) : (
            <>Import {submitCount} feeds</>
          )}
        </Button>
      </div>
    </div>
  );
}

function EditFeedsPage() {
  const canMutate = useCanMutate();
  const inputElementRef = useRef<HTMLInputElement | null>(null);

  const [feedsFoundFromFile, setFeedsFoundFromFile] = useState<
    ImportFeedDataItem[] | null
  >(null);
  const [importRun, dispatchImportRun] = useReducer(
    importRunReducer,
    INITIAL_IMPORT_RUN,
  );
  const {
    hasStartedImport,
    isImportComplete,
    isImportPending,
    leftOutByLimitUrls,
  } = importRun;

  const [fileInputErrorList, setFileInputErrorList] =
    useState<ImportFeedDataFromFilesError | null>(null);
  const pendingDropResult = useImportDropStore((state) => state.pendingResult);
  const clearPendingDropResult = useImportDropStore(
    (state) => state.clearPendingResult,
  );

  // Signal to Playwright tests that React has hydrated and the onChange handler
  // is attached to the file input, so file-chooser interactions are reliable.
  useEffect(() => {
    inputElementRef.current?.setAttribute("data-ready", "true");
  }, []);

  const { bottomRef, isAtBottom } = useIsAtBottom(feedsFoundFromFile);

  const channelImportCount = feedsFoundFromFile?.filter(
    (feed) => feed.shouldImport,
  ).length;

  const { feeds } = useFeeds();
  const existingFeedUrls = new Set(feeds.map((feed) => getFeedRssUrl(feed)));
  const { selectedChannels, channelsToSubmit, leftOutByLimitCount } =
    getImportSubmission(feedsFoundFromFile, existingFeedUrls);
  const loading = useLoadingMode();
  const importResults = useImportResults();
  const isFetchingRss = loading.mode === "importing";
  const { failedImportUrls, importDeactivatedCount } = importResults;

  const isPostImportScreen = isImportComplete || hasStartedImport;
  const setShouldAlwaysKeepSSEConnectionAlive = useKeepSSEAliveDuringImport({
    isFetchingRss,
    hasStartedImport,
  });

  const applyFileResult = (
    feedResult:
      | ImportFeedDataFromFilesError
      | { success: true; data: ImportFeedDataItem[] },
  ) => {
    if (feedResult.success) {
      // Mark already-added feeds as shouldImport: false
      const feedsWithImportStatus = feedResult.data.map((feed) => ({
        ...feed,
        shouldImport: !findFeedWithRssUrl(feeds, feed.feedUrl),
      }));
      setFeedsFoundFromFile(feedsWithImportStatus);
      setFileInputErrorList(null);
    } else {
      setFeedsFoundFromFile(null);
      setFileInputErrorList(feedResult);
    }
  };
  const applyPendingDropResult = useEffectEvent(applyFileResult);

  useEffect(() => {
    if (!pendingDropResult) return;

    const frame = requestAnimationFrame(() => {
      applyPendingDropResult(pendingDropResult);
      clearPendingDropResult();
    });

    return () => cancelAnimationFrame(frame);
  }, [pendingDropResult, clearPendingDropResult]);

  useEffect(() => {
    if (isImportPending && loading.mode === "importing" && !hasStartedImport) {
      const id = requestAnimationFrame(() =>
        dispatchImportRun({ type: "started" }),
      );
      return () => cancelAnimationFrame(id);
    }
  }, [isImportPending, loading.mode, hasStartedImport]);

  useImportDeactivatedToast(isImportComplete, importDeactivatedCount);

  const onSelectFiles = async () => {
    if (!inputElementRef.current) return;

    const feedResult = await getInitialFeedDataFromFileInputElement(
      inputElementRef.current,
    );
    inputElementRef.current.value = "";

    applyFileResult(feedResult);
  };

  const onFeedImport = async () => {
    if (!feedsFoundFromFile?.length) return;

    setShouldAlwaysKeepSSEConnectionAlive(true);

    const submittedUrls = new Set(
      channelsToSubmit.map((channel) => channel.feedUrl),
    );
    dispatchImportRun({
      type: "submitted",
      leftOutByLimitUrls: new Set(
        selectedChannels
          .filter((channel) => !submittedUrls.has(channel.feedUrl))
          .map((channel) => channel.feedUrl),
      ),
    });
    if (leftOutByLimitCount > 0) {
      toast.warning(
        `${leftOutByLimitCount} feed${leftOutByLimitCount > 1 ? "s were" : " was"} left out: an import is limited to ${MAX_BULK_MUTATION_ITEMS} feeds. Import the file again to add the rest.`,
      );
    }

    const channelsToImport = channelsToSubmit.map((feed) => ({
      categories: feed.categories,
      categoryPaths: feed.categoryPaths,
      feedUrl: feed.feedUrl,
      tagNames: feed.tagNames,
    }));

    try {
      await dataRequestActions.streamingImport(channelsToImport);

      dispatchImportRun({ type: "completed" });
    } catch {
      toast.error("Import failed. Please try again.");
    } finally {
      dispatchImportRun({ type: "settled" });
    }
  };

  const onReset = () => {
    setFeedsFoundFromFile(null);
    dispatchImportRun({ type: "reset" });
    setShouldAlwaysKeepSSEConnectionAlive(false);
  };

  if (isFetchingRss) {
    return <ImportLoading />;
  }

  return (
    <fieldset className="contents" disabled={!canMutate}>
      <div className="mx-auto max-w-2xl p-6">
        <h2 className="font-sans text-lg">Import Feeds</h2>
        {!isPostImportScreen && (
          <ImportInstructions onSelectFiles={onSelectFiles} />
        )}
        {isPostImportScreen && <ImportFinished onReset={onReset} />}
        <input
          id="import-file-input"
          ref={inputElementRef}
          type="file"
          accept="text"
          aria-label="Import feed files"
          className="sr-only"
          multiple
          onChange={onSelectFiles}
        />
        {!!fileInputErrorList?.errors?.length && (
          <div className="text-destructive mt-2">
            {fileInputErrorList.errors.map((error) => (
              <div key={error}>{error}</div>
            ))}
          </div>
        )}
        {!!feedsFoundFromFile && (
          <ImportFeedList
            feedsFoundFromFile={feedsFoundFromFile}
            feeds={feeds}
            isPostImportScreen={isPostImportScreen}
            channelImportCount={channelImportCount}
            failedImportUrls={failedImportUrls}
            leftOutByLimitUrls={leftOutByLimitUrls}
            setFeedsFoundFromFile={setFeedsFoundFromFile}
            bottomRef={bottomRef}
          />
        )}
      </div>
      {!!feedsFoundFromFile && !isPostImportScreen && (
        <ImportFooter
          isAtBottom={isAtBottom}
          submitCount={channelsToSubmit.length}
          isImportPending={isImportPending}
          hasStartedImport={hasStartedImport}
          onFeedImport={onFeedImport}
        />
      )}
    </fieldset>
  );
}
