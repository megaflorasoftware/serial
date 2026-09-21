import type { ReaderBlock, ReaderDocument, ReaderFootnote } from "./model";
import { notice } from "./context";

/** The Reader document the reader accepts: measured on the typed part, `source` excluded. */
export const READER_DOCUMENT_BUDGET_BYTES = 512 * 1024;
export const READER_DOCUMENT_BLOCK_LIMIT = 5_000;

function withoutSource(key: string, value: unknown) {
  return key === "source" ? undefined : value;
}

/** Serialized size of a block's typed part, as the reader would store it. */
export function readerBlockBytes(block: ReaderBlock) {
  return new TextEncoder().encode(JSON.stringify(block, withoutSource))
    .byteLength;
}

export function readerDocumentBytes(document: ReaderDocument) {
  return new TextEncoder().encode(JSON.stringify(document, withoutSource))
    .byteLength;
}

/** Blocks nested inside a block, counted toward the block limit. */
function countBlocks(block: ReaderBlock): number {
  switch (block.kind) {
    case "quotation":
      return (
        1 + block.children.reduce((sum, child) => sum + countBlocks(child), 0)
      );
    case "list":
      return (
        1 +
        block.items.reduce(
          (sum, item) =>
            sum +
            item.content.reduce(
              (inner, child) => inner + countBlocks(child),
              0,
            ),
          0,
        )
      );
    case "table":
      return (
        1 +
        block.rows.reduce(
          (sum, row) =>
            sum +
            row.reduce(
              (inner, cell) =>
                inner +
                cell.content.reduce(
                  (deep, child) => deep + countBlocks(child),
                  0,
                ),
              0,
            ),
          0,
        )
      );
    default:
      return 1;
  }
}

/**
 * Cuts the document at the top-level block boundary where it crosses either
 * bound and appends the truncated notice. Footnotes referenced only by cut
 * blocks are dropped with them; the numbering of the kept ones does not move.
 */
export function boundReaderDocument(
  blocks: ReaderBlock[],
  footnotes: ReaderFootnote[],
  limits: { bytes?: number; blocks?: number } = {},
): ReaderDocument {
  const byteLimit = limits.bytes ?? READER_DOCUMENT_BUDGET_BYTES;
  const blockLimit = limits.blocks ?? READER_DOCUMENT_BLOCK_LIMIT;
  const kept: ReaderBlock[] = [];
  // Two bytes for the surrounding array brackets, one comma per block.
  let bytes = 2;
  let count = 0;
  for (const block of blocks) {
    const size = readerBlockBytes(block) + (kept.length ? 1 : 0);
    const nested = countBlocks(block);
    if (bytes + size > byteLimit || count + nested > blockLimit) {
      kept.push(notice(null, "truncated"));
      return {
        blocks: kept,
        footnotes: keptFootnotes(kept, footnotes),
        truncated: true,
      };
    }
    kept.push(block);
    bytes += size;
    count += nested;
  }
  return { blocks: kept, footnotes, truncated: false };
}

function referencedFootnotes(blocks: ReaderBlock[], numbers: Set<number>) {
  for (const block of blocks) {
    switch (block.kind) {
      case "paragraph":
      case "heading":
      case "callout":
        for (const inline of block.content)
          if (inline.kind === "footnote") numbers.add(inline.number);
        break;
      case "image":
      case "imageGroup":
        for (const inline of block.caption ?? [])
          if (inline.kind === "footnote") numbers.add(inline.number);
        break;
      case "quotation":
        referencedFootnotes(block.children, numbers);
        break;
      case "list":
        for (const item of block.items)
          referencedFootnotes(item.content, numbers);
        break;
      case "table":
        for (const row of block.rows)
          for (const cell of row) referencedFootnotes(cell.content, numbers);
        break;
      default:
        break;
    }
  }
  return numbers;
}

function keptFootnotes(blocks: ReaderBlock[], footnotes: ReaderFootnote[]) {
  const numbers = referencedFootnotes(blocks, new Set<number>());
  // A footnote referenced from another footnote's text stays with its parent.
  let changed = true;
  while (changed) {
    changed = false;
    for (const footnote of footnotes) {
      if (!numbers.has(footnote.number)) continue;
      for (const inline of footnote.content) {
        if (inline.kind === "footnote" && !numbers.has(inline.number)) {
          numbers.add(inline.number);
          changed = true;
        }
      }
    }
  }
  return footnotes.filter((footnote) => numbers.has(footnote.number));
}
