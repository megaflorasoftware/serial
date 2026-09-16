// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BlobRef } from "@atproto/api";
import { describe, expect, it } from "vitest";
import { loadReleaseDocuments } from "../scripts/lib/standard-site-content";
import {
  buildDocumentUri,
  buildReleaseDocumentSource,
  getDocumentRkey,
  STANDARD_SITE,
} from "../src/lib/standard-site";
import {
  assertStandardSiteSyncPlanIsSafe,
  buildDocumentRecord,
  buildPublicationRecord,
  planStandardSiteSync,
} from "../src/lib/standard-site/records";

const publicationUri =
  "at://did:plc:serial/site.standard.publication/3m22222222222";
const publicationIcon = BlobRef.fromJsonRef({
  cid: "bafkreigh2akiscaildc4lmyyzy3jxuvkwqezbszr77grdgo4mpfwu5zbmq",
  mimeType: "image/png",
});
const release = buildReleaseDocumentSource({
  slug: "2026-09-11",
  title: "September update",
  publish_date: "2026-09-11",
  content: "A **release** update.",
});

describe("release publication", () => {
  it("keeps the release identity while moving its URL under the publication", () => {
    expect(buildDocumentUri(publicationUri, release)).toBe(
      "at://did:plc:serial/site.standard.document/3mv7b42cwqisi",
    );
    expect(`${STANDARD_SITE.publicationUrl}${release.path}`).toBe(
      "https://www.serial.tube/releases/2026-09-11/",
    );
    expect(buildPublicationRecord(publicationIcon)).toMatchObject({
      name: "Serial Releases",
      description: "Release notes and product updates from Serial.",
      url: "https://www.serial.tube/releases",
    });
  });

  it("updates existing records, removes guides, and leaves other publications alone", () => {
    const rkey = getDocumentRkey(release);
    const plan = planStandardSiteSync({
      documents: [release],
      publicationUri,
      publicationIcon,
      existingPublications: [
        {
          uri: publicationUri,
          value: {
            ...buildPublicationRecord(publicationIcon),
            name: "Serial",
            url: "https://www.serial.tube",
          },
        },
      ],
      existingDocuments: [
        {
          uri: buildDocumentUri(publicationUri, release),
          value: {
            ...buildDocumentRecord(release, publicationUri),
            path: "/releases/2026-09-11",
          },
        },
        {
          uri: "at://did:plc:serial/site.standard.document/3m22222222223",
          value: {
            site: publicationUri,
            path: "/guides/getting-started",
            tags: ["guide"],
          },
        },
        {
          uri: "at://did:plc:serial/site.standard.document/3m22222222224",
          value: {
            site: "at://did:plc:serial/site.standard.publication/3m22222222225",
          },
        },
      ],
    });

    expect(plan).toMatchObject({ creates: 0, updates: 2, deletes: 1 });
    expect(plan.writes).toMatchObject([
      { $type: "com.atproto.repo.applyWrites#update", rkey: "3m22222222222" },
      {
        $type: "com.atproto.repo.applyWrites#update",
        rkey,
        value: { path: "/2026-09-11/" },
      },
      { $type: "com.atproto.repo.applyWrites#delete", rkey: "3m22222222223" },
    ]);
    expect(() =>
      assertStandardSiteSyncPlanIsSafe(plan, { allowLargeDelete: false }),
    ).not.toThrow();
  });

  it("does no writes after the publication matches the releases", () => {
    const plan = planStandardSiteSync({
      documents: [release],
      publicationUri,
      publicationIcon,
      existingPublications: [
        { uri: publicationUri, value: buildPublicationRecord(publicationIcon) },
      ],
      existingDocuments: [
        {
          uri: buildDocumentUri(publicationUri, release),
          value: buildDocumentRecord(release, publicationUri),
        },
      ],
    });
    expect(plan.writes).toEqual([]);
  });

  it("loads only public top-level release Markdown, including future-dated RSS entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "serial-releases-"));
    const releases = join(root, "releases");
    const guides = join(root, "guides");
    const markdown = (isPublic: boolean) =>
      `---\ntitle: Test\npublish_date: "2099-01-01"\npublic: ${isPublic}\n---\nRelease body.`;
    try {
      await mkdir(releases);
      await mkdir(guides);
      await mkdir(join(releases, "nested"));
      await Promise.all([
        writeFile(join(releases, "public.md"), markdown(true)),
        writeFile(join(releases, "draft.md"), markdown(false)),
        writeFile(join(releases, "ignored.txt"), markdown(true)),
        writeFile(join(releases, "nested", "nested.md"), markdown(true)),
        writeFile(join(guides, "guide.md"), markdown(true)),
      ]);
      const documents = await loadReleaseDocuments(
        pathToFileURL(`${releases}/`),
      );
      expect(documents).toMatchObject([
        {
          key: "public",
          path: "/public/",
          publishedAt: "2099-01-01T00:00:00.000Z",
          markdownContent: "Release body.",
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
