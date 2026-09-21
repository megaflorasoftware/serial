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
import { RecordCard } from "~/components/content-reader/RecordCard";
import { SandboxedFrame } from "~/components/content-reader/SandboxedFrame";
import { ArticleImageLightbox } from "~/components/feed/read/ArticleImageLightbox";
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
  /** Frames show the notice instead of loading. */
  offline?: boolean;
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
              [{inline.number}]
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

function Picture({
  image,
  simplified,
  fill = false,
}: {
  image: ReaderImage;
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
  return <ArticleImageLightbox src={image.url} alt={image.alt} style={style} />;
}

/**
 * Columns for an Offprint grid: images fill the rows in order, and a mosaic
 * gives its first image both rows.
 */
function gridColumns(count: number, rows: number, mosaic: boolean) {
  if (mosaic && rows === 2 && count > 1) return 1 + Math.ceil((count - 1) / 2);
  return Math.max(1, Math.ceil(count / rows));
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
          <Picture image={block.image} simplified={simplified} />
          {block.caption && (
            <figcaption>
              <RichText content={block.caption} />
            </figcaption>
          )}
        </figure>
      );
    case "imageGroup": {
      const grid = block.layout.mode === "grid" ? block.layout : null;
      return (
        <figure
          data-reader-figure="group"
          data-reader-align={block.align ?? undefined}
          data-reader-image-group={block.layout.mode}
          data-reader-grid-rows={grid?.rows}
          data-reader-grid-ratio={grid?.ratio}
          style={
            grid
              ? ({
                  "--reader-grid-columns": gridColumns(
                    block.images.length,
                    grid.rows,
                    grid.ratio === "mosaic",
                  ),
                } as CSSProperties)
              : undefined
          }
        >
          <div data-reader-image-group-items>
            {block.images.map((image, index) => (
              <Picture
                key={index}
                image={image}
                simplified={simplified}
                fill={grid !== null}
              />
            ))}
          </div>
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
          {block.imageUrl && (
            <a href={block.href} target="_blank" rel="noopener noreferrer">
              <img
                {...REMOTE_IMAGE_PROPS}
                src={block.imageUrl}
                alt={block.title}
              />
            </a>
          )}
          <p>
            <a href={block.href} target="_blank" rel="noopener noreferrer">
              <strong>{block.title}</strong>
            </a>
            {block.description && (
              <>
                <br />
                {block.description}
              </>
            )}
          </p>
        </div>
      );
    case "recordPreview":
      return <RecordCard card={block.card} />;
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
          unavailable={simplified || options.offline === true}
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
