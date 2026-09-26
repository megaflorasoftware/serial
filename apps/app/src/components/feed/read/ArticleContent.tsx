"use client";

import parse, { Element } from "html-react-parser";
import type { HTMLReactParserOptions } from "html-react-parser";
import type { ExternalContentVisibility } from "~/components/content-reader/ExternalContent";
import { ExternalContent } from "~/components/content-reader/ExternalContent";
import { flattenReaderImages } from "~/components/content-reader/flattenReaderImages";
import { ArticleImageLightbox } from "~/components/feed/read/ArticleImageLightbox";

function findImage(node: Element): { src: string; node: Element } | null {
  if (node.name === "img")
    return node.attribs.src ? { src: node.attribs.src, node } : null;
  if (node.name === "source") {
    const src = node.attribs.srcset?.split(/\s/)[0];
    return src ? { src, node } : null;
  }
  for (const child of node.children) {
    if (child instanceof Element) {
      const image = findImage(child);
      if (image) return image;
    }
  }
  return null;
}

/** Publisher-declared pixel dimensions, when both are plain positive numbers. */
function htmlImageAspectRatio(node: Element) {
  const width = Number(node.attribs.width);
  const height = Number(node.attribs.height);
  return Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
    ? { width, height }
    : null;
}

function isImageContainer(node: Element): boolean {
  if (node.name === "a") {
    const cls = node.attribs.class ?? "";
    if (cls.includes("image-link") || cls.includes("image2")) return true;
  }
  if (node.name === "figure") return !!findImage(node);
  if (node.attribs.class?.includes("captioned-image-container")) return true;
  return false;
}

export type ArticleContentProps = {
  content: string;
  externalContent: ExternalContentVisibility;
  /** The item's own page, the target of every External content notice. */
  noticeHref: string;
  originActionLabel: string;
  /** A caller's own element mapping, consulted before the shared rules. */
  replace?: HTMLReactParserOptions["replace"];
};

/**
 * Renders an HTML Reader body: RSS bodies, legacy stored HTML and Bookmark
 * captures. Every `iframe` in the markup, stored or legacy, is intercepted
 * here so nothing renders unsandboxed.
 */
export function ArticleContent({
  content,
  externalContent,
  noticeHref,
  originActionLabel,
  replace,
}: ArticleContentProps) {
  const options: HTMLReactParserOptions = {
    replace: (domNode, index) => {
      if (!(domNode instanceof Element)) return;

      const replaced = replace?.(domNode, index);
      if (replaced !== undefined) return replaced;

      // Open external links in new tabs. In-page links include footnote refs.
      if (
        domNode.name === "a" &&
        domNode.attribs.href &&
        !domNode.attribs.href.startsWith("#")
      ) {
        domNode.attribs.target = "_blank";
        domNode.attribs.rel = "noopener noreferrer";
      }

      if (domNode.name === "img") {
        const src = domNode.attribs.src ?? "";
        const alt = domNode.attribs.alt ?? "";
        if (!src) return <></>;
        return (
          <ArticleImageLightbox
            src={src}
            alt={alt}
            aspectRatio={htmlImageAspectRatio(domNode)}
          />
        );
      }

      if (isImageContainer(domNode)) {
        const image = findImage(domNode);
        if (image)
          return (
            <ArticleImageLightbox
              src={image.src}
              aspectRatio={htmlImageAspectRatio(image.node)}
            />
          );
      }

      if (domNode.name !== "iframe") return;
      return (
        <ExternalContent
          source={{ kind: "src", src: domNode.attribs.src ?? "" }}
          visibility={externalContent}
          noticeHref={noticeHref}
          originActionLabel={originActionLabel}
          height={storedFrameHeight(domNode.attribs.height)}
          aspectRatio={null}
        />
      );
    },
  };

  const parsed = parse(content, options);
  const nodes = Array.isArray(parsed) ? parsed : [parsed];

  return <>{flattenReaderImages(nodes)}</>;
}

/** A stored `height` attribute, accepted within the same range as authored frames. */
function storedFrameHeight(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) return null;
  const height = Number(value);
  return height >= 16 && height <= 1600 ? height : null;
}
