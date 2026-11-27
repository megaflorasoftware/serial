// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { getInitialFeedDataFromFiles } from "~/components/feed/import/utils/getInitialFeedDataFromFileInputElement";
import { getInitialFeedDataFromOPMLInput } from "~/components/feed/import/utils/getInitialFeedDataFromOPMLInput";
import { downloadOPML } from "~/lib/data/export/downloadOPML";

const OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <body>
    <outline text="Example" xmlUrl="https://example.com/feed.xml" />
  </body>
</opml>`;

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Example</title></channel></rss>`;

function file(name: string, content: string) {
  return new File([content], name);
}

describe("OPML file types", () => {
  // jsdom does not define these, so they are assigned rather than spied on.
  const { createObjectURL, revokeObjectURL } = URL;
  afterEach(() => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    vi.restoreAllMocks();
  });

  it("reads OPML saved as .xml or .opml.xml", async () => {
    for (const name of ["Inoreader Feeds.xml", "serial-feeds.opml.xml"]) {
      const result = await getInitialFeedDataFromFiles([file(name, OPML)]);
      expect(result.success).toBe(true);
      if (result.success)
        expect(result.data.map((feed) => feed.feedUrl)).toEqual([
          "https://example.com/feed.xml",
        ]);
    }
  });

  it("rejects files that are not OPML, whatever their extension", async () => {
    const result = await getInitialFeedDataFromFiles([
      file("feed.xml", RSS),
      file("notes.opml", "not xml at all"),
    ]);
    expect(result).toEqual({
      success: false,
      errors: [
        'File "feed.xml" isn\'t a valid OPML file.',
        'File "notes.opml" isn\'t a valid OPML file.',
      ],
    });
  });

  it("rejects truncated OPML instead of importing up to the cut", () => {
    expect(
      getInitialFeedDataFromOPMLInput(
        OPML.slice(0, OPML.indexOf("</body>")),
        "serial-feeds.opml",
      ),
    ).toEqual({
      success: false,
      error: 'File "serial-feeds.opml" isn\'t a valid OPML file.',
    });
  });

  it("accepts leading whitespace and unescaped ampersands in feed URLs", () => {
    const result = getInitialFeedDataFromOPMLInput(
      `\n  <?xml version="1.0"?>
<opml version="2.0"><body><outline xmlUrl="https://example.com/feed?a=1&b=2" /></body></opml>`,
      "feeds.opml",
    );
    expect(result.success).toBe(true);
    if (result.success)
      expect(result.data.map((feed) => feed.feedUrl)).toEqual([
        "https://example.com/feed?a=1&b=2",
      ]);
  });

  it("keeps the OPML files it can read when another file is rejected", async () => {
    const result = await getInitialFeedDataFromFiles([
      file("feed.xml", RSS),
      file("serial-feeds.opml.xml", OPML),
    ]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(1);
  });

  it("accepts an OPML document with an empty body", () => {
    expect(
      getInitialFeedDataFromOPMLInput(
        '<opml version="2.0"><head/><body/></opml>',
        "empty.opml",
      ),
    ).toEqual({ success: true, data: [] });
  });

  it("downloads exports as text/x-opml so iOS keeps the .opml name", async () => {
    let blob: Blob | undefined;
    URL.createObjectURL = vi.fn((object: Blob | MediaSource) => {
      blob = object as Blob;
      return "blob:export";
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe("serial-feeds.opml");
        expect(this.href).toBe("blob:export");
      });

    downloadOPML(OPML, "serial-feeds.opml");

    expect(click).toHaveBeenCalledOnce();
    expect(blob?.type).toBe("text/x-opml;charset=utf-8");
    expect(await blob?.text()).toBe(OPML);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:export");
  });
});
