import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { getReleaseDocumentRkey, STANDARD_SITE } from ".";
import type { Release } from "content-collections";

export type StandardSiteDocumentRecord = {
  $type: typeof STANDARD_SITE.documentCollection;
  site: string;
  title: string;
  path: string;
  publishedAt: string;
  tags: string[];
  textContent: string;
  description?: string;
};

export type StandardSiteRecord = {
  uri: string;
  value: Record<string, unknown>;
};

type MarkdownNode = {
  type?: string;
  children?: MarkdownNode[];
  value?: string;
};

export function buildPublicationRecord() {
  return {
    $type: STANDARD_SITE.publicationCollection,
    url: STANDARD_SITE.publicationUrl,
    name: STANDARD_SITE.publicationName,
    description: STANDARD_SITE.publicationDescription,
    preferences: {
      showInDiscover: true,
    },
  };
}

function renderBlockNode(node: MarkdownNode): string {
  if (node.type === "root") {
    return (
      node.children?.map(renderBlockNode).filter(Boolean).join("\n\n") ?? ""
    );
  }

  if (node.type === "list" || node.type === "table") {
    return node.children?.map(renderBlockNode).filter(Boolean).join("\n") ?? "";
  }

  if (node.type === "listItem") {
    return node.children?.map(renderBlockNode).filter(Boolean).join("\n") ?? "";
  }

  if (node.type === "blockquote") {
    return (
      node.children?.map(renderBlockNode).filter(Boolean).join("\n\n") ?? ""
    );
  }

  if (node.type === "code") return node.value ?? "";

  return toString(node, { includeHtml: false });
}

export function markdownToPlaintext(markdown: string) {
  const processor = unified().use(remarkParse).use(remarkGfm);
  const tree = processor.parse(markdown);

  return renderBlockNode(tree)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildDocumentRecord(
  release: Release,
  publicationUri: string,
): StandardSiteDocumentRecord {
  return {
    $type: STANDARD_SITE.documentCollection,
    site: publicationUri,
    title: release.title,
    path: `/${release.slug}`,
    publishedAt: `${release.publish_date}T00:00:00.000Z`,
    tags: [...STANDARD_SITE.releaseTags],
    textContent: markdownToPlaintext(release.content),
    ...(release.description ? { description: release.description } : {}),
  };
}

export function planDocumentSync(
  releases: Release[],
  publicationUri: string,
  existingRecords: StandardSiteRecord[],
) {
  const upserts = releases.map((release) => ({
    rkey: getReleaseDocumentRkey(release),
    record: buildDocumentRecord(release, publicationUri),
  }));
  const expectedRkeys = new Set(upserts.map(({ rkey }) => rkey));

  const deletes = existingRecords.flatMap(({ uri, value }) => {
    if (value.site !== publicationUri) return [];

    const rkey = uri.split("/").at(-1);
    if (!rkey || expectedRkeys.has(rkey)) return [];
    return [rkey];
  });

  return { upserts, deletes };
}
