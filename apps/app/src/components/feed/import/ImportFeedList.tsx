import { ItemGroup } from "@serial/ui";
import { ImportFeedRow } from "./ImportFeedRow";
import { compareImportTitles } from "./importPageShared";
import type { RefObject } from "react";
import type {
  FailedImportUrls,
  SetFeedsFoundFromFile,
  UserFeeds,
} from "./importPageShared";
import type { ImportFeedDataItem } from "./utils/shared";
import { Button } from "~/components/ui/button";
import { findFeedWithRssUrl } from "~/lib/feeds/origins";

function ImportSelectionHeader({
  channelImportCount,
  feeds,
  setFeedsFoundFromFile,
}: {
  channelImportCount: number | undefined;
  feeds: UserFeeds;
  setFeedsFoundFromFile: SetFeedsFoundFromFile;
}) {
  return (
    <div className="flex items-center justify-between">
      <h3 className="font-semibold">Feeds To Import</h3>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          if (channelImportCount === 0) {
            setFeedsFoundFromFile((prevChannels) => {
              if (!prevChannels) return prevChannels;
              return prevChannels.map((channel) => {
                // Don't enable import for already-added feeds
                const isAlreadyAdded = !!findFeedWithRssUrl(
                  feeds,
                  channel.feedUrl,
                );
                if (!isAlreadyAdded) {
                  channel.shouldImport = true;
                }
                return channel;
              });
            });
          } else {
            setFeedsFoundFromFile((prevChannels) => {
              if (!prevChannels) return prevChannels;
              return prevChannels.map((channel) => {
                channel.shouldImport = false;
                return channel;
              });
            });
          }
        }}
      >
        {channelImportCount === 0 ? "Select All" : "Deselect All"}
      </Button>
    </div>
  );
}

export function ImportFeedList({
  feedsFoundFromFile,
  feeds,
  isPostImportScreen,
  channelImportCount,
  failedImportUrls,
  leftOutByLimitUrls,
  setFeedsFoundFromFile,
  bottomRef,
}: {
  feedsFoundFromFile: ImportFeedDataItem[];
  feeds: UserFeeds;
  isPostImportScreen: boolean;
  channelImportCount: number | undefined;
  failedImportUrls: FailedImportUrls;
  leftOutByLimitUrls: Set<string>;
  setFeedsFoundFromFile: SetFeedsFoundFromFile;
  bottomRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <>
      <div className="mt-12">
        {!isPostImportScreen && (
          <ImportSelectionHeader
            channelImportCount={channelImportCount}
            feeds={feeds}
            setFeedsFoundFromFile={setFeedsFoundFromFile}
          />
        )}
        <ItemGroup className="mt-4">
          {[...feedsFoundFromFile].sort(compareImportTitles).map((channel) => (
            <ImportFeedRow
              key={channel.feedUrl}
              channel={channel}
              feeds={feeds}
              isPostImportScreen={isPostImportScreen}
              failedImportUrls={failedImportUrls}
              leftOutByLimitUrls={leftOutByLimitUrls}
              setFeedsFoundFromFile={setFeedsFoundFromFile}
            />
          ))}
        </ItemGroup>
        <div ref={bottomRef} />
      </div>
    </>
  );
}
