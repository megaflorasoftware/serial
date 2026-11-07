import { readdir, readFile } from "node:fs/promises";
import matter from "gray-matter";
import { z } from "zod";
import { buildReleaseDocumentSource } from "../../src/lib/standard-site";

const frontmatterSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  publish_date: z.iso.date(),
  public: z.boolean(),
});

// The sync script runs under plain Node, so it cannot import the Astro content
// collection loader in src/lib/content.ts (an `astro:content` virtual module).
// Keep this reader aligned with that loader's frontmatter contract.
const RELEASES_DIR = new URL("../../src/content/releases/", import.meta.url);

export async function loadReleaseDocuments(directory = RELEASES_DIR) {
  const fileNames = await readdir(directory);
  const documents = [];

  for (const fileName of fileNames) {
    if (!fileName.endsWith(".md")) continue;

    const raw = await readFile(new URL(fileName, directory), "utf8");
    const { data, content } = matter(raw);
    const parsed = frontmatterSchema.parse(data);

    if (!parsed.public) continue;

    documents.push(
      buildReleaseDocumentSource({
        slug: fileName.replace(/\.md$/, ""),
        ...parsed,
        content: content.trim(),
      }),
    );
  }

  return documents.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
}
