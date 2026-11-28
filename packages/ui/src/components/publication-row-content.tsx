import { Orbit, Rss } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import type { DiscoveredFeed } from "@serial/feed-discovery";
import type { ReactNode } from "react";

/**
 * The same publication identity and source treatment in the modal and extension.
 * A `trailing` node replaces the source icons on the right.
 */
export function PublicationRowContent({
  feed,
  trailing,
}: {
  feed: DiscoveredFeed;
  trailing?: ReactNode;
}) {
  const hasAtmosphere = feed.origins?.some(
    (origin) => origin.kind === "atproto",
  );
  const hasRss =
    !feed.origins || feed.origins.some((origin) => origin.kind === "rss");
  const Icon = hasAtmosphere ? Orbit : Rss;
  return (
    <div className="flex w-full min-w-0 items-center gap-2">
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
      <div className="min-w-0 flex-1">
        <p className="max-w-full truncate">
          {feed.title || feed.siteUrl || feed.url}
        </p>
        <p className="text-muted-foreground truncate text-xs">
          {feed.siteUrl || feed.url}
        </p>
      </div>
      <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-2">
        {trailing}
        {!trailing && hasAtmosphere && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Orbit size={16} aria-label="Atmosphere" />
            </TooltipTrigger>
            <TooltipContent>Atmosphere</TooltipContent>
          </Tooltip>
        )}
        {!trailing && hasRss && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Rss size={16} aria-label="RSS" />
            </TooltipTrigger>
            <TooltipContent>RSS</TooltipContent>
          </Tooltip>
        )}
      </span>
    </div>
  );
}
