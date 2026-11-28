import { ExternalLinkIcon } from "lucide-react";
import type { ReaderNoticeReason } from "@serial/standard-site";
import { Button } from "~/components/ui/button";

/**
 * Reasons the reader shows a notice instead of content. The block reasons come
 * from the Reader document; `externalContent` is the reader's own, for any
 * External content it is not showing: hidden by preference, a never-online
 * visit, or a source it does not admit. Recognized YouTube videos use their
 * own headline and link to the video.
 */
export type ReaderNoticeKind =
  ReaderNoticeReason | "externalContent" | "youtube";

const HEADLINE = "Available on the original site";

/** Interactive content names itself; a delimiter states its reason out loud. */
const HEADLINES: Partial<Record<ReaderNoticeKind, string>> = {
  externalContent: "This interactive content is available on the original site",
  youtube: "This video is available on YouTube",
  membersOnly: "The rest of this post is for members",
};

/** Block reasons explain themselves to screen readers; External content has said all it says. */
const DESCRIPTIONS: Partial<Record<ReaderNoticeKind, string>> = {
  unsupported: "This block is not supported in the reader yet.",
  canvas: "This page is a canvas layout, which the reader does not show yet.",
  truncated: "The rest of this document is longer than the reader can show.",
  membersOnly: "The rest of this document is for members of the publication.",
  depth: "This section is nested too deeply for the reader to show.",
};

export type ReaderNoticeProps = {
  kind: ReaderNoticeKind;
  /** The document page, or the video page for a YouTube notice. */
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
    <div role="note" data-reader-notice={kind} data-article-block="">
      <div>
        <p data-reader-notice-headline>{HEADLINES[kind] ?? HEADLINE}</p>
        {DESCRIPTIONS[kind] && <p className="sr-only">{DESCRIPTIONS[kind]}</p>}
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
