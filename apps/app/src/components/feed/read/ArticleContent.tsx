"use client";

import parse, { Element } from "html-react-parser";
import type { HTMLReactParserOptions } from "html-react-parser";
import { ArticleVideoEmbed } from "~/components/content-reader/ArticleVideoEmbed";
import { flattenReaderImages } from "~/components/content-reader/flattenReaderImages";
import { ArticleImageLightbox } from "~/components/feed/read/ArticleImageLightbox";

function extractYouTubeVideoId(src: string): string | null {
  const match = src.match(
    /(?:youtube\.com|youtube-nocookie\.com)\/embed\/([^?/]+)/,
  );
  return match?.[1] ?? null;
}

function findImageSrc(node: Element): string | null {
  if (node.name === "img") return node.attribs.src ?? null;
  if (node.name === "source")
    return node.attribs.srcset?.split(/\s/)[0] ?? null;
  for (const child of node.children) {
    if (child instanceof Element) {
      const src = findImageSrc(child);
      if (src) return src;
    }
  }
  return null;
}

function isImageContainer(node: Element): boolean {
  if (node.name === "a") {
    const cls = node.attribs.class ?? "";
    if (cls.includes("image-link") || cls.includes("image2")) return true;
  }
  if (node.name === "figure") return !!findImageSrc(node);
  if (node.attribs.class?.includes("captioned-image-container")) return true;
  return false;
}

/** Renders an HTML Reader body: RSS bodies and legacy stored HTML. */
export function ArticleContent({
  content,
  simplified = false,
}: {
  content: string;
  simplified?: boolean;
}) {
  const options: HTMLReactParserOptions = {
    replace: (domNode) => {
      if (!(domNode instanceof Element)) return;

      // Open external links in new tabs. In-page links include footnote refs.
      if (
        domNode.name === "a" &&
        domNode.attribs.href &&
        !domNode.attribs.href.startsWith("#")
      ) {
        domNode.attribs.target = "_blank";
        domNode.attribs.rel = "noopener noreferrer";
      }

      if (simplified) return;

      if (domNode.name === "img") {
        const src = domNode.attribs.src ?? "";
        const alt = domNode.attribs.alt ?? "";
        if (!src) return;
        return <ArticleImageLightbox src={src} alt={alt} />;
      }

      if (isImageContainer(domNode)) {
        const src = findImageSrc(domNode);
        if (src) return <ArticleImageLightbox src={src} />;
      }

      if (domNode.name !== "iframe") return;

      const src = domNode.attribs.src ?? "";
      const videoId = extractYouTubeVideoId(src);
      if (!videoId) return;
      return <ArticleVideoEmbed videoId={videoId} />;
    },
  };

  const parsed = parse(content, options);
  const nodes = Array.isArray(parsed) ? parsed : [parsed];

  return <>{simplified ? nodes : flattenReaderImages(nodes)}</>;
}
