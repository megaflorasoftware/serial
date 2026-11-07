const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
]);
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export type YouTubeReference = { videoId: string; start: string | null };

export function parseYouTubeReference(
  url: string | undefined,
): YouTubeReference | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!YOUTUBE_HOSTS.has(parsed.hostname)) return null;

  let videoId: string | null = null;
  if (parsed.hostname === "youtu.be") {
    videoId = parsed.pathname.slice(1).split("/")[0] ?? null;
  } else {
    const embedMatch = /^\/(?:embed|shorts|live|v)\/([^/]+)/.exec(
      parsed.pathname,
    );
    videoId = embedMatch?.[1] ?? parsed.searchParams.get("v");
  }
  if (!videoId || !YOUTUBE_VIDEO_ID.test(videoId)) return null;

  const start =
    parsed.searchParams.get("start") ?? parsed.searchParams.get("t");
  // Share links write the offset as `t=30s`; embeds write `start=30`.
  const validStart = start ? /^(\d+)s?$/.exec(start)?.[1] : undefined;
  return { videoId, start: validStart ?? null };
}
