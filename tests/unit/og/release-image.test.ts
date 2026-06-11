import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  RELEASE_OG_IMAGE_SIZE,
  renderReleaseOgImage,
} from "~/server/og/release";
import {
  getReleaseOgResponse,
  RELEASE_OG_CACHE_CONTROL,
} from "~/server/og/releaseResponse";

vi.mock("content-collections", () => ({
  allBlogPosts: [],
  allReleases: [
    {
      slug: "public-release",
      title: "Public release",
      description: "This release is public.",
      publish_date: "2026-06-10",
      public: true,
      content: "",
      excerpt: "",
    },
    {
      slug: "private-release",
      title: "Private release",
      publish_date: "2026-06-10",
      public: false,
      content: "",
      excerpt: "",
    },
    {
      slug: "screenshot-release",
      title: "Screenshot release",
      screenshot: "/releases/screenshots/screenshot-release.png",
      publish_date: "2026-06-10",
      public: true,
      content: "",
      excerpt: "",
    },
  ],
}));

type TestRelease = {
  slug: string;
  title: string;
  description?: string;
  publish_date: string;
};

function makeRelease(overrides: Partial<TestRelease> = {}): TestRelease {
  return {
    slug: "test-release",
    title: "A release title",
    description: "A release description",
    publish_date: "2026-06-10",
    ...overrides,
  };
}

describe("renderReleaseOgImage", () => {
  it.each([
    ["normal content", makeRelease()],
    ["no description", makeRelease({ description: undefined })],
    [
      "long content",
      makeRelease({
        title: "A very long release title ".repeat(10),
        description: "A very long release description ".repeat(20),
      }),
    ],
  ])("renders a 1200x630 PNG with %s", async (_name, release) => {
    const image = await renderReleaseOgImage(release);
    const metadata = await sharp(image).metadata();

    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(RELEASE_OG_IMAGE_SIZE.width);
    expect(metadata.height).toBe(RELEASE_OG_IMAGE_SIZE.height);
  });

  it("renders the base OG branding without Satori warnings", async () => {
    const warningSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    try {
      const image = await renderReleaseOgImage(makeRelease());
      const releaseIconRegion = await sharp(image)
        .extract({ left: 48, top: 48, width: 64, height: 64 })
        .stats();
      const brandingRegion = await sharp(image)
        .extract({ left: 48, top: 550, width: 120, height: 44 })
        .stats();

      expect(
        Math.min(...releaseIconRegion.channels.map((channel) => channel.min)),
      ).toBeLessThan(250);
      expect(
        Math.min(...brandingRegion.channels.map((channel) => channel.min)),
      ).toBeLessThan(250);
      expect(warningSpy).not.toHaveBeenCalled();
    } finally {
      warningSpy.mockRestore();
    }
  });

  it("uses the light desktop screenshot by default", async () => {
    const image = await renderReleaseOgImage(makeRelease());
    const screenshotRegion = await sharp(image)
      .extract({ left: 450, top: 100, width: 50, height: 50 })
      .stats();

    expect(
      Math.min(
        ...screenshotRegion.channels.slice(0, 3).map((channel) => channel.min),
      ),
    ).toBeLessThan(250);
  });
});

describe("getReleaseOgResponse", () => {
  it("returns a cached PNG for a public release", async () => {
    const response = await getReleaseOgResponse("public-release");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe(
      RELEASE_OG_CACHE_CONTROL,
    );
  });

  it("embeds a configured release screenshot", async () => {
    const screenshot = await sharp({
      create: {
        width: 32,
        height: 18,
        channels: 3,
        background: "#000000",
      },
    })
      .png()
      .toBuffer();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array(screenshot), {
        headers: { "Content-Type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const response = await getReleaseOgResponse(
        "screenshot-release",
        "https://serial.tube",
      );
      const screenshotRegion = await sharp(await response.arrayBuffer())
        .extract({ left: 450, top: 100, width: 50, height: 50 })
        .stats();

      expect(fetchMock).toHaveBeenCalledWith(
        new URL(
          "https://serial.tube/releases/screenshots/screenshot-release.png",
        ),
      );
      expect(
        Math.min(
          ...screenshotRegion.channels
            .slice(0, 3)
            .map((channel) => channel.min),
        ),
      ).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns 404 for an unknown release", async () => {
    const response = await getReleaseOgResponse("does-not-exist");

    expect(response.status).toBe(404);
  });

  it("returns 404 for an unpublished release", async () => {
    const response = await getReleaseOgResponse("private-release");

    expect(response.status).toBe(404);
  });
});
