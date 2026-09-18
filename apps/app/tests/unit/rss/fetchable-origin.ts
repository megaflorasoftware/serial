import type { DatabaseFeed, DatabaseFeedOrigin } from "~/server/db/schema";
import type { FetchableOrigin } from "~/server/rss/types";

export type FetchableOriginOverrides = Partial<DatabaseFeedOrigin> & {
  etag?: string | null;
  lastModifiedHeader?: string | null;
  id?: number;
  name?: string;
  platform?: DatabaseFeed["platform"];
  isActive?: boolean;
};

/**
 * One Feed with a single RSS origin, the unit the fetch pipeline consumes.
 * `id` is the Feed id; the origin id derives from it so pairs stay distinct.
 */
export function makeFetchableOrigin(
  defaults: { name: string; platform: DatabaseFeed["platform"]; url: string },
  overrides: FetchableOriginOverrides = {},
): FetchableOrigin {
  const {
    id = 1,
    name = defaults.name,
    platform = defaults.platform,
    isActive = true,
    etag = null,
    lastModifiedHeader = null,
    ...origin
  } = overrides;
  return {
    feed: {
      id,
      userId: "user-1",
      name,
      imageUrl: "",
      platform,
      openLocation: "serial",
      createdAt: new Date(),
      updatedAt: new Date(),
      isActive,
      siteUrl: null,
      nameEditedAt: null,
    },
    origin: {
      id: id * 100,
      feedId: id,
      userId: "user-1",
      kind: "rss",
      rss: {
        originId: id * 100,
        etag,
        lastModifiedHeader,
        alternateLocators: null,
      },
      atproto: null,
      locator: defaults.url,
      lastFetchedAt: null,
      nextFetchAt: null,
      sourceName: null,
      sourceImageUrl: null,
      sourceDescription: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...origin,
    },
  };
}
