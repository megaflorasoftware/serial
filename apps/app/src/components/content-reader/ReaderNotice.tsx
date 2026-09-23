import { ExternalLinkIcon } from "lucide-react";
import type { ReaderNoticeReason } from "@serial/standard-site";
import { Button } from "~/components/ui/button";

/**
 * Reasons the reader shows a notice instead of content. The block reasons come
 * from the Reader document; `embed` and `frame` are the reader's own, for a
 * src frame it does not admit yet and a sandboxed frame it will not load
 * offline or in simplified mode.
 */
export type ReaderNoticeKind = ReaderNoticeReason | "embed" | "frame";

const HEADLINE = "Available on the original site";

/** Interactive content names itself; a delimiter states its reason out loud. */
const HEADLINES: Partial<Record<ReaderNoticeKind, string>> = {
  embed: "This interactive content is available on the original site",
  frame: "This interactive content is available on the original site",
  membersOnly: "The rest of this post is for members",
};

const DESCRIPTIONS: Record<ReaderNoticeKind, string> = {
  unsupported: "This block is not supported in the reader yet.",
  canvas: "This page is a canvas layout, which the reader does not show yet.",
  truncated: "The rest of this document is longer than the reader can show.",
  membersOnly: "The rest of this document is for members of the publication.",
  depth: "This section is nested too deeply for the reader to show.",
  embed: "Embedded content from another site is not shown in the reader yet.",
  frame: "Embedded content is not shown offline or in simplified mode.",
};

export type ReaderNoticeProps = {
  kind: ReaderNoticeKind;
  /** The document page; the reader never sends people to an embed's own URL. */
  href: string;
  originActionLabel: string;
};

/**
 * Modeled on the custom video player's error overlay: a generic visible
 * headline, the specific message for screen readers, and one primary button
 * with the external-link icon to the original site. Unlike the overlay, many
 * notices can sit in one document, so they are notes rather than alerts.
 */
export function ReaderNotice({
  kind,
  href,
  originActionLabel,
}: ReaderNoticeProps) {
  return (
    <div role="note" data-reader-notice={kind}>
      <div>
        <p data-reader-notice-headline>{HEADLINES[kind] ?? HEADLINE}</p>
        <p className="sr-only">{DESCRIPTIONS[kind]}</p>
      </div>
      <Button asChild>
        <a href={href} target="_blank" rel="noopener noreferrer">
          <span>{originActionLabel}</span>
          <ExternalLinkIcon aria-hidden="true" size={16} />
        </a>
      </Button>
    </div>
  );
}
