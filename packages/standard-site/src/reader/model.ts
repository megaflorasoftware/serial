import type { RecordCard } from "../record-card";
import type { YouTubeReference } from "../youtube";

/**
 * The Reader document: the ordered typed blocks the reader derives from a
 * Document source and its Reference snapshots. Every block keeps `source`,
 * the block value as the platform wrote it, so nothing is dropped even when
 * the reader does not draw a field yet. The shape only grows; a client that
 * meets a kind it does not know renders the unsupported notice for it.
 */

export type ReaderAlign = "left" | "center" | "right" | "justify";

export type ReaderAspectRatio = { width: number; height: number };

/** A display width the reader honors, capped at the column. */
export type ReaderWidth = { value: number; unit: "px" | "%" };

export type ReaderMarks = {
  bold?: true;
  italic?: true;
  code?: true;
  strikethrough?: true;
  underline?: true;
  /** The color is carried, not drawn. */
  highlight?: { color: string | null };
};

export type ReaderLink = {
  href: string;
  /** The AT URI a Record mention names; the visible link may be HTTPS. */
  record: string | null;
};

export type ReaderTextSpan = {
  kind: "text";
  text: string;
  marks: ReaderMarks;
  link: ReaderLink | null;
};

export type ReaderFootnoteReference = { kind: "footnote"; number: number };

export type ReaderInline = ReaderTextSpan | ReaderFootnoteReference;

export type ReaderRichText = ReaderInline[];

export type ReaderFootnote = { number: number; content: ReaderRichText };

export type ReaderImage = {
  url: string;
  alt: string;
  /** Hover text, not a caption. */
  title: string | null;
  aspectRatio: ReaderAspectRatio | null;
  width: ReaderWidth | null;
  /** Carried, not drawn: the column is fixed. */
  fullBleed: boolean;
};

export type ReaderImageGroupLayout =
  | { mode: "stack" }
  | {
      mode: "grid";
      rows: number;
      ratio: "landscape" | "portrait" | "square" | "mosaic";
    };

export type ReaderListItem = {
  content: ReaderBlock[];
  /** Null for ordinary items; a task item carries its state. */
  checked: boolean | null;
};

export type ReaderTableCell = {
  header: boolean;
  colspan: number | null;
  rowspan: number | null;
  content: ReaderBlock[];
};

export type ReaderNoticeReason =
  "unsupported" | "canvas" | "truncated" | "membersOnly" | "depth";

export type ReaderBlockBase = {
  /** The block as the platform wrote it. */
  source: unknown;
  align: ReaderAlign | null;
};

/** The typed part of a block, without the source and alignment every block carries. */
export type ReaderBlockValue =
  | { kind: "paragraph"; content: ReaderRichText }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; content: ReaderRichText }
  | { kind: "quotation"; children: ReaderBlock[] }
  | {
      kind: "callout";
      emoji: string | null;
      /** The author's color as written; `tint` is the validated form. */
      color: string | null;
      tint: string | null;
      content: ReaderRichText;
    }
  | {
      kind: "list";
      ordered: boolean;
      start: number | null;
      items: ReaderListItem[];
    }
  | { kind: "code"; code: string; language: string | null }
  | { kind: "math"; tex: string }
  | { kind: "table"; rows: ReaderTableCell[][] }
  | { kind: "image"; image: ReaderImage; caption: ReaderRichText | null }
  | {
      kind: "imageGroup";
      images: ReaderImage[];
      caption: ReaderRichText | null;
      layout: ReaderImageGroupLayout;
    }
  | { kind: "divider" }
  | { kind: "break" }
  | {
      kind: "linkCard";
      href: string;
      title: string;
      description: string | null;
      imageUrl: string | null;
    }
  | { kind: "recordPreview"; card: RecordCard }
  | {
      kind: "embed";
      /** The page the embed comes from; the notice points here. */
      href: string;
      embedUrl: string | null;
      youtube: YouTubeReference | null;
      height: number | null;
      aspectRatio: ReaderAspectRatio | null;
    }
  | {
      kind: "html";
      html: string;
      height: number | null;
      aspectRatio: ReaderAspectRatio | null;
    }
  | { kind: "notice"; reason: ReaderNoticeReason };

export type ReaderBlock = ReaderBlockBase & ReaderBlockValue;

export type ReaderBlockKind = ReaderBlock["kind"];

export type ReaderDocument = {
  blocks: ReaderBlock[];
  footnotes: ReaderFootnote[];
  /** True when the bound cut blocks; the last block is then the truncated notice. */
  truncated: boolean;
};

/** Plaintext of the first paragraph and the first image, for list views. */
export type ReaderSummary = {
  firstParagraph: string | null;
  firstImageUrl: string | null;
};
