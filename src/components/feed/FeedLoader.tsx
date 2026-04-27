import clsx from "clsx";
import { Progress } from "~/components/ui/progress";
import { useLoadingMode } from "~/lib/data/loading-machine";
import { useFeeds } from "~/lib/data/feeds/store";

export function FeedLoader() {
  const loading = useLoadingMode();
  const feeds = useFeeds();

  const hasFeeds = feeds.length > 0;
  const showProgress =
    loading.mode === "initialLoad" || loading.mode === "backgroundRefresh";

  if (!hasFeeds || !showProgress) {
    return null;
  }

  const progress = loading.mode === "backgroundRefresh" ? loading.progress : 0;

  return (
    <div
      className={clsx("w-32 transition-opacity", {
        "opacity-0": loading.mode === "initialLoad",
        "opacity-100": loading.mode === "backgroundRefresh",
      })}
    >
      <Progress value={progress} className="w-full" />
    </div>
  );
}
