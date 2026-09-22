"use client";

import { Fragment } from "react";
import type { CSSProperties, ReactNode } from "react";
import type {
  ReaderBlock,
  ReaderDocument,
  ReaderImage,
  ReaderInline,
  ReaderRichText,
} from "@serial/standard-site";
import { ArticleVideoEmbed } from "~/components/content-reader/ArticleVideoEmbed";
import { ReaderNotice } from "~/components/content-reader/ReaderNotice";
import { LinkCard, RecordCard } from "~/components/content-reader/RecordCard";
import { SocialPostCard } from "~/components/content-reader/SocialPostCard";
import { SandboxedFrame } from "~/components/content-reader/SandboxedFrame";
import { ReaderImageCarousel } from "~/components/content-reader/ReaderImageCarousel";
import {
  ArticleImageLightboxGroup,
  ArticleImageLightboxTrigger,
} from "~/components/feed/read/ArticleImageLightbox";
import { REMOTE_IMAGE_PROPS } from "~/lib/remoteMedia";

/**
 * Renders a Reader document with the DOM shapes the reader's navigation,
 * progress, sidebar and lightbox code already read from HTML bodies:
 * paragraphs, headings, blockquotes, figures, list items, `data-lightbox`
 * wrappers, `data-article-video-embed` divs, and footnote links with ids.
 */

export type ReaderDocumentContentProps = {
  document: ReaderDocument;
  /** The document's own page, the target of every block notice. */
  documentUrl: string;
  originActionLabel: string;
  /** No lightbox, no video, and frames show the notice. */
  simplified?: boolean;
};

type RenderOptions = Omit<ReaderDocumentContentProps, "document">;

function footnoteId(number: number) {
  return `fn-${number}`;
}

function footnoteReferenceId(number: number) {
  return `fnref-${number}`;
}

function marksOf(inline: Extract<ReaderInline, { kind: "text" }>) {
  let node: ReactNode = inline.text;
  const { marks } = inline;
  if (marks.code) node = <code>{node}</code>;
  if (marks.highlight) node = <mark>{node}</mark>;
  if (marks.underline) node = <u>{node}</u>;
  if (marks.strikethrough) node = <del>{node}</del>;
  if (marks.italic) node = <em>{node}</em>;
  if (marks.bold) node = <strong>{node}</strong>;
  if (inline.link) {
    node = (
      <a
        href={inline.link.href}
        target="_blank"
        rel="noopener noreferrer"
        data-record-uri={inline.link.record ?? undefined}
      >
        {node}
      </a>
    );
  }
  return node;
}

function RichText({ content }: { content: ReaderRichText }) {
  return (
    <>
      {content.map((inline, index) =>
        inline.kind === "footnote" ? (
          <sup key={index}>
            <a
              href={`#${footnoteId(inline.number)}`}
              id={footnoteReferenceId(inline.number)}
              role="doc-noteref"
            >
              {inline.number}
            </a>
          </sup>
        ) : (
          <Fragment key={index}>{marksOf(inline)}</Fragment>
        ),
      )}
    </>
  );
}

function alignStyle(block: ReaderBlock): CSSProperties | undefined {
  return block.align ? { textAlign: block.align } : undefined;
}

function imageStyle(image: ReaderImage): CSSProperties | undefined {
  const style: CSSProperties = {};
  if (image.aspectRatio)
    style.aspectRatio = `${image.aspectRatio.width} / ${image.aspectRatio.height}`;
  if (image.width) style.maxWidth = `${image.width.value}${image.width.unit}`;
  return Object.keys(style).length ? style : undefined;
}

/**
 * One image of a lightbox group. In the simplified style there is no
 * lightbox, so the image is drawn plain.
 */
function Picture({
  image,
  index,
  simplified,
  fill = false,
}: {
  image: ReaderImage;
  index: number;
  simplified: boolean;
  /** Grid cells size the picture; the image's own hints are not applied. */
  fill?: boolean;
}) {
  const style = fill ? undefined : imageStyle(image);
  if (simplified) {
    return (
      <img
        {...REMOTE_IMAGE_PROPS}
        src={image.url}
        alt={image.alt}
        title={image.title ?? undefined}
        style={style}
      />
    );
  }
  return <ArticleImageLightboxTrigger index={index} style={style} />;
}

/** Wraps a figure's pictures in one lightbox group; simplified rendering has none. */
function Pictures({
  images,
  simplified,
  children,
}: {
  images: ReaderImage[];
  simplified: boolean;
  children: ReactNode;
}) {
  if (simplified) return <>{children}</>;
  return (
    <ArticleImageLightboxGroup
      images={images.map((image) => ({ src: image.url, alt: image.alt }))}
    >
      {children}
    </ArticleImageLightboxGroup>
  );
}

/** A natural grid cell keeps its image's own shape; a fixed ratio comes from the stylesheet. */
function cellStyle(image: ReaderImage): CSSProperties | undefined {
  return image.aspectRatio
    ? {
        aspectRatio: `${image.aspectRatio.width} / ${image.aspectRatio.height}`,
      }
    : undefined;
}

function Blocks({
  blocks,
  options,
}: {
  blocks: ReaderBlock[];
  options: RenderOptions;
}) {
  return (
    <>
      {blocks.map((block, index) => (
        <Block key={index} block={block} options={options} />
      ))}
    </>
  );
}

function Block({
  block,
  options,
}: {
  block: ReaderBlock;
  options: RenderOptions;
}) {
  const simplified = options.simplified === true;
  const notice = (
    kind: Parameters<typeof ReaderNotice>[0]["kind"],
    href = options.documentUrl,
  ) => (
    <ReaderNotice
      kind={kind}
      href={href}
      originActionLabel={options.originActionLabel}
    />
  );
  switch (block.kind) {
    case "paragraph":
      return (
        <p style={alignStyle(block)}>
          <RichText content={block.content} />
        </p>
      );
    case "heading": {
      const Tag = `h${block.level}` as const;
      return (
        <Tag style={alignStyle(block)}>
          <RichText content={block.content} />
        </Tag>
      );
    }
    case "quotation":
      return (
        <blockquote style={alignStyle(block)}>
          <Blocks blocks={block.children} options={options} />
        </blockquote>
      );
    case "callout":
      return (
        <aside
          data-reader-callout
          style={
            block.tint
              ? ({ "--reader-callout-tint": block.tint } as CSSProperties)
              : undefined
          }
        >
          {block.emoji && <span aria-hidden="true">{block.emoji}</span>}
          <p style={alignStyle(block)}>
            <RichText content={block.content} />
          </p>
        </aside>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      const task = block.items.some((item) => item.checked !== null);
      return (
        <Tag
          start={
            block.ordered && block.start !== null && block.start !== 1
              ? block.start
              : undefined
          }
          className={task ? "contains-task-list" : undefined}
        >
          {block.items.map((item, index) => (
            <li
              key={index}
              className={item.checked !== null ? "task-list-item" : undefined}
            >
              {item.checked !== null && (
                <input
                  type="checkbox"
                  disabled
                  checked={item.checked}
                  readOnly
                />
              )}{" "}
              <Blocks blocks={item.content} options={options} />
            </li>
          ))}
        </Tag>
      );
    }
    case "code":
      return (
        <pre style={alignStyle(block)}>
          <code
            className={
              block.language
                ? `language-${block.language.replace(/[^\w+#.-]/g, "")}`
                : undefined
            }
          >
            {block.code}
          </code>
        </pre>
      );
    case "math":
      return (
        <pre style={alignStyle(block)}>
          <code className="language-tex">{block.tex}</code>
        </pre>
      );
    case "table":
      return (
        <table>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => {
                  const Tag = cell.header ? "th" : "td";
                  return (
                    <Tag
                      key={cellIndex}
                      colSpan={cell.colspan ?? undefined}
                      rowSpan={cell.rowspan ?? undefined}
                    >
                      <Blocks blocks={cell.content} options={options} />
                    </Tag>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "image":
      return (
        <figure
          data-reader-figure="image"
          data-reader-align={block.align ?? undefined}
        >
          <Pictures images={[block.image]} simplified={simplified}>
            <Picture image={block.image} index={0} simplified={simplified} />
          </Pictures>
          {block.caption && (
            <figcaption>
              <RichText content={block.caption} />
            </figcaption>
          )}
        </figure>
      );
    case "imageGroup": {
      const { layout } = block;
      const grid = layout.mode === "grid" ? layout : null;
      const picture = (index: number) => (
        <Picture
          key={index}
          image={block.images[index]!}
          index={index}
          simplified={simplified}
          fill={grid !== null}
        />
      );
      return (
        <figure
          data-reader-figure="group"
          data-reader-align={block.align ?? undefined}
          data-reader-image-group={layout.mode}
          data-reader-grid-ratio={grid?.ratio ?? undefined}
          style={
            grid
              ? ({
                  "--reader-grid-columns": grid.columns,
                  "--reader-grid-columns-narrow": Math.min(grid.columns, 2),
                } as CSSProperties)
              : undefined
          }
        >
          {block.title && <p data-reader-image-group-title>{block.title}</p>}
          <Pictures images={block.images} simplified={simplified}>
            {layout.mode === "carousel" ? (
              <ReaderImageCarousel
                count={block.images.length}
                renderSlide={picture}
              />
            ) : (
              <div data-reader-image-group-items>
                {block.images.map((image, index) =>
                  grid && !grid.ratio ? (
                    <div key={index} style={cellStyle(image)}>
                      {picture(index)}
                    </div>
                  ) : (
                    picture(index)
                  ),
                )}
              </div>
            )}
          </Pictures>
          {block.caption && (
            <figcaption>
              <RichText content={block.caption} />
            </figcaption>
          )}
        </figure>
      );
    }
    case "divider":
      return <hr />;
    case "break":
      return <br />;
    case "linkCard":
      return (
        <div data-reader-align={block.align ?? undefined}>
          <LinkCard card={block} />
        </div>
      );
    case "recordPreview":
      return <RecordCard card={block.card} />;
    case "socialPost":
      return (
        <SocialPostCard
          post={block.post}
          text={<RichText content={block.post.text} />}
          quote={
            block.post.quote ? (
              <Block block={block.post.quote} options={options} />
            ) : null
          }
        />
      );
    case "embed":
      if (block.youtube && !simplified)
        return (
          <ArticleVideoEmbed
            videoId={block.youtube.videoId}
            start={block.youtube.start}
          />
        );
      if (block.youtube)
        return (
          <p>
            <a href={block.href} target="_blank" rel="noopener noreferrer">
              <strong>Watch on YouTube</strong>
            </a>
          </p>
        );
      // Every other src frame waits on the sandboxed frame decision (ticket 38).
      return notice("unsupported", block.href);
    case "html":
      return (
        <SandboxedFrame
          html={block.html}
          title="Embedded content"
          height={block.height}
          aspectRatio={block.aspectRatio}
          simplified={simplified}
          noticeHref={options.documentUrl}
          originActionLabel={options.originActionLabel}
        />
      );
    case "notice":
      return notice(block.reason);
    default:
      // A kind this client does not know yet: the shape only grows.
      return notice("unsupported");
  }
}

function Footnotes({ document }: { document: ReaderDocument }) {
  if (document.footnotes.length === 0) return null;
  return (
    <section role="doc-endnotes" data-reader-footnotes>
      <ol>
        {document.footnotes.map((footnote) => (
          <li
            key={footnote.number}
            id={footnoteId(footnote.number)}
            role="doc-footnote"
          >
            <RichText content={footnote.content} />{" "}
            <a
              href={`#${footnoteReferenceId(footnote.number)}`}
              role="doc-backlink"
              aria-label={`Back to reference ${footnote.number}`}
            >
              ↩
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ReaderDocumentContent({
  document,
  ...options
}: ReaderDocumentContentProps) {
  return (
    <>
      <Blocks blocks={document.blocks} options={options} />
      <Footnotes document={document} />
    </>
  );
}
