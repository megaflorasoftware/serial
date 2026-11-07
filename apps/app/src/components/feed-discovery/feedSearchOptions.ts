import { classifyDiscoveryInput } from "@serial/feed-discovery";

export type StaticFeedSearchOption = {
  label: string;
  description?: string;
  url: string;
  keywords?: string[];
};

/**
 * Curated feed shortcuts shown in the add-feed command.
 *
 * Add one entry per feed. Entries may share a keyword, so a search such as
 * "dropout" can intentionally return several related feeds. Include common
 * abbreviations and alternate spellings in `keywords` (for example,
 * "ny times" and "nytimes") so cmdk can fuzzily match them.
 */
export const STATIC_FEED_SEARCH_OPTIONS: StaticFeedSearchOption[] = [];

export function normalizeFeedSearchUrl(value: string) {
  return classifyDiscoveryInput(value)?.websiteUrl ?? null;
}
