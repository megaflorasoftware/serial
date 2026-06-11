import { describe, expect, it } from "vitest";
import type { Release } from "content-collections";
import {
  buildDocumentLink,
  buildDocumentUri,
  buildPublicationLink,
  createPublicationVerificationResponse,
  getReleaseDocumentRkey,
  parsePublicationUri,
  STANDARD_SITE,
} from "~/lib/standard-site";
import {
  buildDocumentRecord,
  buildPublicationRecord,
  markdownToPlaintext,
  planDocumentSync,
} from "~/lib/standard-site/records";

const PUBLICATION_URI =
  "at://did:plc:serialtest/site.standard.publication/3mnvfqfsk22zc";

function makeRelease(overrides: Partial<Release> = {}): Release {
  return {
    slug: "2026-06-10",
    title: "View sections",
    description: "Custom view sections and better navigation.",
    publish_date: "2026-06-10",
    public: true,
    content:
      "## Features\n\n- **Fast** syncing\n- [Useful links](https://example.com)",
    excerpt: "",
    _meta: {
      filePath: "src/content/releases/2026-06-10.md",
      fileName: "2026-06-10.md",
      directory: "src/content/releases",
      path: "2026-06-10",
      extension: "md",
    },
    ...overrides,
  };
}

describe("Standard.Site record builders", () => {
  it("builds the releases publication", () => {
    expect(buildPublicationRecord()).toEqual({
      $type: "site.standard.publication",
      url: "https://serial.tube/releases",
      name: "Serial Releases",
      description: STANDARD_SITE.publicationDescription,
      preferences: { showInDiscover: true },
    });
  });

  it("builds a complete release document with plaintext content", () => {
    const record = buildDocumentRecord(makeRelease(), PUBLICATION_URI);

    expect(record).toEqual({
      $type: "site.standard.document",
      site: PUBLICATION_URI,
      title: "View sections",
      description: "Custom view sections and better navigation.",
      path: "/2026-06-10",
      publishedAt: "2026-06-10T00:00:00.000Z",
      tags: ["release"],
      textContent: "Features\n\nFast syncing\nUseful links",
    });
  });

  it("normalizes Markdown into plaintext without formatting or URLs", () => {
    expect(
      markdownToPlaintext(
        "# Heading\n\nA **bold** [link](https://example.com).\n\n\n\nLast line.",
      ),
    ).toBe("Heading\n\nA bold link.\n\nLast line.");
  });

  it("generates a stable valid TID and document URI", () => {
    const release = makeRelease();
    const rkey = getReleaseDocumentRkey(release);

    expect(rkey).toMatch(
      /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/,
    );
    expect(getReleaseDocumentRkey(release)).toBe(rkey);
    expect(buildDocumentUri(PUBLICATION_URI, release)).toBe(
      `at://did:plc:serialtest/site.standard.document/${rkey}`,
    );
  });

  it("rejects invalid publication URIs", () => {
    expect(() => parsePublicationUri("https://serial.tube/releases")).toThrow();
    expect(() =>
      parsePublicationUri(
        "at://did:plc:serialtest/site.standard.document/3mnvfqfsk22zc",
      ),
    ).toThrow();
  });
});

describe("Standard.Site web verification", () => {
  it("builds main-instance publication and document links", () => {
    const options = {
      isMainInstance: true,
      publicationUri: PUBLICATION_URI,
    };

    expect(buildPublicationLink(options)).toEqual({
      rel: "site.standard.publication",
      href: PUBLICATION_URI,
    });
    expect(buildDocumentLink(makeRelease(), options)).toEqual({
      rel: "site.standard.document",
      href: buildDocumentUri(PUBLICATION_URI, makeRelease()),
    });
  });

  it("does not expose links outside the configured main instance", () => {
    expect(
      buildPublicationLink({
        isMainInstance: false,
        publicationUri: PUBLICATION_URI,
      }),
    ).toBeUndefined();
    expect(
      buildDocumentLink(makeRelease(), {
        isMainInstance: true,
        publicationUri: undefined,
      }),
    ).toBeUndefined();
  });

  it("serves the publication URI as plain text only when enabled", async () => {
    const response = createPublicationVerificationResponse({
      isMainInstance: true,
      publicationUri: PUBLICATION_URI,
    });
    const missingResponse = createPublicationVerificationResponse({
      isMainInstance: false,
      publicationUri: PUBLICATION_URI,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await response.text()).toBe(PUBLICATION_URI);
    expect(missingResponse.status).toBe(404);
  });
});

describe("Standard.Site reconciliation", () => {
  it("upserts public releases and only deletes stale records for this publication", () => {
    const release = makeRelease();
    const expectedRkey = getReleaseDocumentRkey(release);
    const plan = planDocumentSync([release], PUBLICATION_URI, [
      {
        uri: `at://did:plc:serialtest/site.standard.document/${expectedRkey}`,
        value: { site: PUBLICATION_URI },
      },
      {
        uri: "at://did:plc:serialtest/site.standard.document/3aaaaaaaaaaaa",
        value: { site: PUBLICATION_URI },
      },
      {
        uri: "at://did:plc:serialtest/site.standard.document/3bbbbbbbbbbbb",
        value: {
          site: "at://did:plc:other/site.standard.publication/3cccccccccccc",
        },
      },
    ]);

    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0]?.rkey).toBe(expectedRkey);
    expect(plan.deletes).toEqual(["3aaaaaaaaaaaa"]);
  });
});
