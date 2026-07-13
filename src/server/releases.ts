import { createServerFn } from "@tanstack/react-start";
import z from "zod";
import { MAIN_SITE_URL } from "~/lib/constants";

const RELEASES_URL = `${MAIN_SITE_URL}/releases.json`;
const RELEASES_CACHE_TTL_MS = 60 * 60 * 1000;
const RELEASES_FETCH_TIMEOUT_MS = 5_000;

const releasesResponseSchema = z.object({
  releases: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      description: z.string().optional(),
      publish_date: z.string(),
    }),
  ),
});

type ReleaseSummary = z.infer<
  typeof releasesResponseSchema
>["releases"][number];

let cachedMostRecentRelease: ReleaseSummary | undefined;
let cachedAtMs = 0;

async function fetchMostRecentRelease(): Promise<ReleaseSummary | undefined> {
  const isCacheFresh = Date.now() - cachedAtMs < RELEASES_CACHE_TTL_MS;
  if (cachedMostRecentRelease && isCacheFresh) {
    return cachedMostRecentRelease;
  }

  try {
    const response = await fetch(RELEASES_URL, {
      signal: AbortSignal.timeout(RELEASES_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return cachedMostRecentRelease;

    const { releases } = releasesResponseSchema.parse(await response.json());
    cachedMostRecentRelease = releases[0];
    cachedAtMs = Date.now();
    return cachedMostRecentRelease;
  } catch {
    // The release notifier is best-effort; fall back to whatever we have.
    return cachedMostRecentRelease;
  }
}

export const getMostRecentReleaseServerFn = createServerFn({
  method: "GET",
}).handler(async () => {
  return fetchMostRecentRelease();
});
