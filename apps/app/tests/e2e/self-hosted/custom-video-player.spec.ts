import { expect, test } from "@playwright/test";
import { signIn } from "../fixtures/auth";
import {
  SELF_HOSTED_APP_PORT,
  SELF_HOSTED_TURSO_PORT,
} from "../fixtures/ports";
import { cleanupUser, seedYouTubeVideoData } from "../fixtures/seed-db";
import type { Page } from "@playwright/test";

async function mockYouTubePlayer(
  page: Page,
  {
    readyDelayMs = 0,
  }: {
    readyDelayMs?: number;
  } = {},
) {
  await page.route(/\/\/www\.youtube\.com\/iframe_api/, async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        (() => {
          class MockYouTubePlayer {
            constructor(element, options) {
              this.element = typeof element === "string" ? document.getElementById(element) : element;
              this.options = options;
              this.listeners = {};
              this.iframe = document.createElement("iframe");
              this.iframe.src = "https://www.youtube-nocookie.com/embed/" + (options.videoId || "");
              this.iframe.title = "YouTube video player";
              this.element.appendChild(this.iframe);

              setTimeout(() => {
                options.events.onReady({ target: this });
              }, ${readyDelayMs});
            }

            addEventListener(eventName, listener) {
              this.listeners[eventName] = listener;
            }

            removeEventListener(eventName) {
              delete this.listeners[eventName];
            }

            cueVideoById() {}
            loadVideoById() {}
            cueVideoByUrl() {}
            loadVideoByUrl() {}
            playVideo() {}
            pauseVideo() {}
            stopVideo() {}
            getVideoLoadedFraction() { return 0; }
            cuePlaylist() {}
            loadPlaylist() {}
            nextVideo() {}
            previousVideo() {}
            playVideoAt() {}
            setShuffle() {}
            setLoop() {}
            getPlaylist() { return []; }
            getPlaylistIndex() { return 0; }
            setOption() {}
            mute() {}
            unMute() {}
            isMuted() { return false; }
            setVolume() {}
            getVolume() { return 100; }
            seekTo() {}
            getPlayerState() { return -1; }
            getPlaybackRate() { return 1; }
            setPlaybackRate() {}
            getAvailablePlaybackRates() { return [1]; }
            getPlaybackQuality() { return "default"; }
            setPlaybackQuality() {}
            getAvailableQualityLevels() { return []; }
            getCurrentTime() { return 0; }
            getDuration() { return 0; }
            getVideoUrl() { return ""; }
            getVideoEmbedCode() { return ""; }
            getOptions() { return []; }
            getOption() { return null; }
            destroy() { this.iframe.remove(); }
            setSize() {}
            getIframe() { return this.iframe; }
            loadModule() {}
          }

          window.YT = {
            Player: MockYouTubePlayer,
            PlayerState: {
              UNSTARTED: -1,
              ENDED: 0,
              PLAYING: 1,
              PAUSED: 2,
              BUFFERING: 3,
              CUED: 5,
            },
          };
          window.onYouTubeIframeAPIReady();
        })();
      `,
    });
  });
}

test.describe("custom video player", () => {
  test.use({
    viewport: { width: 1920, height: 1080 },
    // Service-worker fetches bypass page.route, including the YouTube API mock.
    serviceWorkers: "block",
  });

  let testEmail: string;

  test.afterEach(async () => {
    if (testEmail) {
      await cleanupUser(SELF_HOSTED_TURSO_PORT, testEmail);
    }
  });

  test("shows a spinner while the thumbnail and embed are loading", async ({
    page,
  }) => {
    const { email, password, feedItemId } = await seedYouTubeVideoData(
      SELF_HOSTED_TURSO_PORT,
      SELF_HOSTED_APP_PORT,
    );
    testEmail = email;

    await mockYouTubePlayer(page, { readyDelayMs: 2000 });
    await signIn({ page, email, password });
    await page.goto(`/watch/${feedItemId}`);

    const loadingButton = page.getByRole("button", {
      name: "Video loading",
    });
    await expect(loadingButton).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "Play video" })).toBeVisible({
      timeout: 10000,
    });
    await expect(loadingButton).toHaveCount(0);
  });
});
