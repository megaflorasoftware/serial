import { renderReleaseOgImage } from "./release";
import { findReleaseWithSlug } from "~/lib/markdown/loaders";

export const RELEASE_OG_CACHE_CONTROL =
  "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800";

async function getScreenshotDataUrl(screenshot: string, baseUrl: string) {
  try {
    const screenshotUrl = new URL(screenshot, baseUrl);
    const response = await fetch(screenshotUrl);
    if (!response.ok) return undefined;

    const contentType = response.headers.get("Content-Type");
    if (!contentType?.startsWith("image/")) return undefined;

    const screenshotBuffer = Buffer.from(await response.arrayBuffer());
    return `data:${contentType};base64,${screenshotBuffer.toString("base64")}`;
  } catch {
    return undefined;
  }
}

export async function getReleaseOgResponse(slug: string, baseUrl?: string) {
  const release = findReleaseWithSlug(slug);
  if (!release) {
    return new Response("Not Found", { status: 404 });
  }

  const screenshotDataUrl =
    release.screenshot && baseUrl
      ? await getScreenshotDataUrl(release.screenshot, baseUrl)
      : undefined;
  const image = await renderReleaseOgImage(release, screenshotDataUrl);
  return new Response(new Uint8Array(image), {
    status: 200,
    headers: {
      "Cache-Control": RELEASE_OG_CACHE_CONTROL,
      "Content-Type": "image/png",
    },
  });
}
