// content-collections.ts
import { defineCollection, defineConfig } from "@content-collections/core";
import matter from "gray-matter";
import z from "zod";
function extractFrontMatter(content) {
  const { data, content: body, excerpt } = matter(content, { excerpt: true });
  return { data, body, excerpt: excerpt || "" };
}
var markdownReleaseSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  publish_date: z.string().date(),
  public: z.boolean()
});
var releaseSchema = markdownReleaseSchema.extend({
  slug: z.string(),
  content: z.string(),
  excerpt: z.string()
});
var releases = defineCollection({
  name: "releases",
  directory: "./src/content/releases",
  // Directory containing your .md files
  include: "*.md",
  schema: markdownReleaseSchema,
  transform: ({ content, ...post }) => {
    const frontMatter = extractFrontMatter(content);
    return {
      ...post,
      slug: post._meta.path,
      excerpt: frontMatter.excerpt,
      content: frontMatter.body
    };
  }
});
var content_collections_default = defineConfig({
  collections: [releases]
});
export {
  content_collections_default as default,
  releaseSchema
};
