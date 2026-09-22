import { webkit } from "@playwright/test";
const browser = await webkit.launch();
const page = await browser.newPage();
await page.goto("http://127.0.0.1:21018/", { waitUntil: "load" });
const run = (opts) =>
  page.evaluate(async ({ withTrack, crossorigin, muted }) => {
    const out = { events: [], withTrack, crossorigin, muted };
    const video = document.createElement("video");
    video.muted = muted;
    video.playsInline = true;
    video.preload = "none";
    if (crossorigin) video.crossOrigin = "anonymous";
    if (withTrack) {
      const t = document.createElement("track");
      t.kind = "captions";
      video.append(t);
    }
    document.body.append(video);
    out.canPlayNative = video.canPlayType("application/vnd.apple.mpegurl");
    video.addEventListener("error", () =>
      out.events.push(["error", video.error?.code, video.error?.message]),
    );
    video.addEventListener("playing", () => out.events.push(["playing"]));
    video.addEventListener("loadedmetadata", () =>
      out.events.push(["loadedmetadata"]),
    );
    video.src =
      "https://video.bsky.app/watch/did%3Aplc%3Av46ojbiop5ebs5h7gaomixcc/bafkreig7lokcgph3k4du33qtvidhg2epjs3oam44bf56jgepeoqrrepeki/playlist.m3u8";
    await video
      .play()
      .then(() => out.events.push(["play resolved"]))
      .catch((e) => out.events.push(["play rejected", e.name, e.message]));
    await new Promise((r) => setTimeout(r, 6000));
    out.readyState = video.readyState;
    out.currentTime = Math.round(video.currentTime * 10) / 10;
    video.remove();
    return out;
  }, opts);
for (const opts of [
  { withTrack: true, crossorigin: false, muted: true },
  { withTrack: false, crossorigin: false, muted: true },
  { withTrack: false, crossorigin: false, muted: false },
])
  console.log(JSON.stringify(await run(opts)));
await browser.close();
