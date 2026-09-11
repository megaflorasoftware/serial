import { CheckIcon, MinusIcon, PauseIcon, PlusIcon, XIcon } from "lucide-react";
import type { ImportFeedDataItem } from "./utils/shared";
import type { FailedImportUrls, UserFeeds } from "./importPageShared";
import { Button } from "~/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";

function ImportedFeedStatus({
  feedUrl,
  feeds,
}: {
  feedUrl: string;
  feeds: Array<{ url: string; isActive: boolean }>;
}) {
  const importedFeed = feeds.find((f) => f.url === feedUrl);
  const isInactive = importedFeed && !importedFeed.isActive;

  return (
    <Tooltip>
      <TooltipTrigger>
        {isInactive ? <PauseIcon size={20} /> : <CheckIcon size={20} />}
      </TooltipTrigger>
      <TooltipContent>
        {isInactive ? "Feed inactive" : "Imported Successfully!"}
      </TooltipContent>
    </Tooltip>
  );
}

function ImportSelectionToggle({
  channel,
  displayTitle,
  isAlreadyAdded,
  setShouldImport,
}: {
  channel: ImportFeedDataItem;
  displayTitle: string;
  isAlreadyAdded: boolean;
  setShouldImport: (shouldImport: boolean) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={channel.shouldImport ? "default" : "ghost"}
          size="icon"
          className="size-7"
          aria-label={`${channel.shouldImport ? "Deselect" : "Select"} ${displayTitle}`}
          disabled={isAlreadyAdded}
          onClick={() => setShouldImport(!channel.shouldImport)}
        >
          {channel.shouldImport ? (
            <CheckIcon size={16} />
          ) : (
            <PlusIcon size={16} />
          )}
        </Button>
      </TooltipTrigger>
      {!isAlreadyAdded && (
        <TooltipContent>
          {channel.shouldImport ? "Deselect" : "Select"} feed
        </TooltipContent>
      )}
    </Tooltip>
  );
}

function ImportSkippedStatus({
  channel,
  isAlreadyAdded,
  leftOutByLimitUrls,
}: {
  channel: ImportFeedDataItem;
  isAlreadyAdded: boolean;
  leftOutByLimitUrls: Set<string>;
}) {
  if (isAlreadyAdded) return null;
  const wasLeftOut = leftOutByLimitUrls.has(channel.feedUrl);
  if (channel.shouldImport && !wasLeftOut) return null;

  return (
    <Tooltip>
      <TooltipTrigger>
        <MinusIcon size={20} />
      </TooltipTrigger>
      <TooltipContent>
        {wasLeftOut
          ? "This feed was left out: the import limit was reached."
          : "This feed was excluded from the import."}
      </TooltipContent>
    </Tooltip>
  );
}

function ImportOutcomeStatus({
  channel,
  feeds,
  isAlreadyAdded,
  wasImported,
  failedImportUrls,
  leftOutByLimitUrls,
}: {
  channel: ImportFeedDataItem;
  feeds: UserFeeds;
  isAlreadyAdded: boolean;
  wasImported: boolean;
  failedImportUrls: FailedImportUrls;
  leftOutByLimitUrls: Set<string>;
}) {
  // A failure reported for this row wins over "already added": an
  // already-subscribed feed is submitted on re-import and can still fail.
  const hasFailed = failedImportUrls.has(channel.feedUrl);

  return (
    <>
      {wasImported && !hasFailed && (
        <ImportedFeedStatus feedUrl={channel.feedUrl} feeds={feeds} />
      )}
      {hasFailed && (
        <Tooltip>
          <TooltipTrigger>
            <XIcon size={20} />
          </TooltipTrigger>
          <TooltipContent>Failed to import</TooltipContent>
        </Tooltip>
      )}
      <ImportSkippedStatus
        channel={channel}
        isAlreadyAdded={isAlreadyAdded}
        leftOutByLimitUrls={leftOutByLimitUrls}
      />
    </>
  );
}

export function ImportFeedRowActions({
  channel,
  feeds,
  displayTitle,
  isAlreadyAdded,
  wasImported,
  isPostImportScreen,
  failedImportUrls,
  leftOutByLimitUrls,
  setShouldImport,
}: {
  channel: ImportFeedDataItem;
  feeds: UserFeeds;
  displayTitle: string;
  isAlreadyAdded: boolean;
  wasImported: boolean;
  isPostImportScreen: boolean;
  failedImportUrls: FailedImportUrls;
  leftOutByLimitUrls: Set<string>;
  setShouldImport: (shouldImport: boolean) => void;
}) {
  if (!isPostImportScreen) {
    return (
      <ImportSelectionToggle
        channel={channel}
        displayTitle={displayTitle}
        isAlreadyAdded={isAlreadyAdded}
        setShouldImport={setShouldImport}
      />
    );
  }

  return (
    <ImportOutcomeStatus
      channel={channel}
      feeds={feeds}
      isAlreadyAdded={isAlreadyAdded}
      wasImported={wasImported}
      failedImportUrls={failedImportUrls}
      leftOutByLimitUrls={leftOutByLimitUrls}
    />
  );
}
