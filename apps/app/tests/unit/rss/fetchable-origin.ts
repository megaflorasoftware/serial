import type { DatabaseFeed, DatabaseFeedOrigin } from "~/server/db/schema";
import type { FetchableOrigin } from "~/server/rss/types";

export type FetchableOriginOverrides = Partial<DatabaseFeedOrigin> & {
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
      locator: defaults.url,
      etag: null,
      lastModifiedHeader: null,
      lastFetchedAt: null,
      nextFetchAt: null,
      repoRev: null,
      publicationDid: null,
      publicationRkey: null,
      pdsUrl: null,
      sourceName: null,
      sourceImageUrl: null,
      sourceDescription: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...origin,
    },
  };
}
