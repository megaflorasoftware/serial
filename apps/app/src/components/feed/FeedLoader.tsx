import { Progress } from "~/components/ui/progress";
import { useLoadingMode } from "~/lib/data/loading-machine";
import { useFeeds } from "~/lib/data/feeds/store";

function useBackgroundRefreshProgress(): number | null {
  const loading = useLoadingMode();
  const feeds = useFeeds();

  if (
    feeds.length === 0 ||
    loading.mode !== "backgroundRefresh" ||
    loading.progress <= 0
  ) {
    return null;
  }

  return loading.progress;
}

// Header bar from `md` up; the mobile bar below takes over under that.
export function FeedLoader() {
  const progress = useBackgroundRefreshProgress();
  if (progress === null) return null;

  return (
    <div className="hidden w-full max-w-32 md:block">
      <Progress value={progress} className="w-full" />
    </div>
  );
}

// Full-width edge strip between the banners and the header on phones,
// sticky so it stays visible while a reader page scrolls its header away.
export function MobileFeedLoader() {
  const progress = useBackgroundRefreshProgress();
  if (progress === null) return null;

  return (
    <div className="sticky top-0 z-20 w-full md:hidden">
      <Progress value={progress} className="h-1 rounded-none" />
    </div>
  );
}
