import { renderReleaseOgImage } from "./release";
import { findReleaseWithSlug } from "~/lib/markdown/loaders";

export const RELEASE_OG_CACHE_CONTROL =
  "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800";

const releaseScreenshots = import.meta.glob("../../content/releases/*.png", {
  eager: true,
  import: "default",
  query: "?inline",
});

export function findReleaseScreenshot(slug: string) {
  const screenshot = releaseScreenshots[`../../content/releases/${slug}.png`];
  return typeof screenshot === "string" ? screenshot : undefined;
}

export async function getReleaseOgResponse(slug: string) {
  const release = findReleaseWithSlug(slug);
  if (!release) {
    return new Response("Not Found", { status: 404 });
  }

  const screenshotDataUrl = findReleaseScreenshot(release.slug);
  const image = await renderReleaseOgImage(release, screenshotDataUrl);
  return new Response(new Uint8Array(image), {
    status: 200,
    headers: {
      "Cache-Control": RELEASE_OG_CACHE_CONTROL,
      "Content-Type": "image/png",
    },
  });
}
