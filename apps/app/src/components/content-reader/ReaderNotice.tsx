import { ExternalLinkIcon } from "lucide-react";
import type { ReaderNoticeReason } from "@serial/standard-site";
import { Button } from "~/components/ui/button";

/**
 * Reasons the reader shows a notice instead of content. The block reasons come
 * from the Reader document; `frame` is the reader's own, for a sandboxed frame
 * it will not load offline or in simplified mode.
 */
export type ReaderNoticeKind = ReaderNoticeReason | "frame";

const HEADLINE = "Available on the original site";

/** A delimiter is the one notice whose reason the reader states out loud. */
const HEADLINES: Partial<Record<ReaderNoticeKind, string>> = {
  membersOnly: "The rest of this post is for members",
};

const DESCRIPTIONS: Record<ReaderNoticeKind, string> = {
  unsupported: "This block is not supported in the reader yet.",
  canvas: "This page is a canvas layout, which the reader does not show yet.",
  truncated: "The rest of this document is longer than the reader can show.",
  membersOnly: "The rest of this document is for members of the publication.",
  depth: "This section is nested too deeply for the reader to show.",
  frame: "Embedded content is not shown offline or in simplified mode.",
};

export type ReaderNoticeProps = {
  kind: ReaderNoticeKind;
  /** Where the content lives: the document page, or the embed's own site. */
  href: string;
  originActionLabel: string;
};

/**
 * Modeled on the custom video player's error overlay: a generic visible
 * headline, the specific message for screen readers, and one outline button
 * with the external-link icon to the original site.
 */
export function ReaderNotice({
  kind,
  href,
  originActionLabel,
}: ReaderNoticeProps) {
  return (
    <div role="alert" data-reader-notice={kind}>
      <div>
        <p data-reader-notice-headline>{HEADLINES[kind] ?? HEADLINE}</p>
        <p className="sr-only">{DESCRIPTIONS[kind]}</p>
      </div>
      <Button variant="outline" asChild>
        <a href={href} target="_blank" rel="noopener noreferrer">
          <span>{originActionLabel}</span>
          <ExternalLinkIcon aria-hidden="true" size={16} />
        </a>
      </Button>
    </div>
  );
}
