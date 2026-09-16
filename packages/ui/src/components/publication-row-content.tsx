import { Orbit, Rss } from "lucide-react";
import { feedSourceLabel } from "@serial/feed-discovery";
import type { DiscoveredFeed } from "@serial/feed-discovery";

/** The same publication identity and source treatment in the modal and extension. */
export function PublicationRowContent({ feed }: { feed: DiscoveredFeed }) {
  const hasAtmosphere = feed.origins?.some(
    (origin) => origin.kind === "atproto",
  );
  const Icon = hasAtmosphere ? Orbit : Rss;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center overflow-hidden rounded">
        {feed.imageUrl ? (
          <img
            src={feed.imageUrl}
            alt=""
            className="size-8 object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <Icon className="size-4" />
        )}
      </span>
      <div className="min-w-0">
        <p className="max-w-full truncate">
          {feed.title || feed.siteUrl || feed.url}
        </p>
        <p className="text-muted-foreground truncate text-xs">
          {feed.siteUrl || feed.url}
        </p>
        <p className="text-muted-foreground text-xs">{feedSourceLabel(feed)}</p>
      </div>
    </div>
  );
}
