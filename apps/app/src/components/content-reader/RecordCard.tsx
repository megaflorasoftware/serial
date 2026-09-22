import { useState } from "react";
import type {
  ReaderBlockValue,
  RecordCard as RecordCardData,
} from "@serial/standard-site";
import { REMOTE_IMAGE_PROPS } from "~/lib/remoteMedia";

function PreviewImage({ src, icon = false }: { src: string; icon?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      {...REMOTE_IMAGE_PROPS}
      src={src}
      alt=""
      data-record-image={icon ? "icon" : "cover"}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * A row card's preview: the image sits whole and centred inside a fixed
 * column, so its own corners round rather than the column's. Leaves no gap
 * once the image fails.
 */
export function RowPreviewImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <span data-record-preview>
      <img
        {...REMOTE_IMAGE_PROPS}
        src={src}
        alt=""
        data-record-image="cover"
        onError={() => setFailed(true)}
      />
    </span>
  );
}

export function RecordCard({ card }: { card: RecordCardData }) {
  const date = card.publishedAt ? new Date(card.publishedAt) : null;
  const published =
    date && Number.isFinite(date.getTime())
      ? date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        })
      : null;
  const metadata = [card.author, published].filter(Boolean).join(" · ");
  return (
    <a
      href={card.url}
      target="_blank"
      rel="noopener noreferrer"
      data-record-card={card.size}
    >
      {card.size === "row" && card.imageUrl && (
        <RowPreviewImage key={card.imageUrl} src={card.imageUrl} />
      )}
      {card.size !== "small" && card.size !== "row" && card.imageUrl && (
        <PreviewImage key={card.imageUrl} src={card.imageUrl} />
      )}
      <div data-record-copy>
        {card.publicationName && (
          <p data-record-publication>
            {card.iconUrl && (
              <PreviewImage key={card.iconUrl} src={card.iconUrl} icon />
            )}
            <span>{card.publicationName}</span>
          </p>
        )}
        <p data-record-title>
          {!card.publicationName && card.iconUrl && (
            <PreviewImage key={card.iconUrl} src={card.iconUrl} icon />
          )}
          {card.title}
        </p>
        {card.size !== "small" && card.description && (
          <p data-record-description>{card.description}</p>
        )}
        {metadata && <p data-record-metadata>{metadata}</p>}
      </div>
    </a>
  );
}

function linkHost(href: string): string | null {
  try {
    return new URL(href).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * A Leaflet-style link card: title, description and host on the left, the
 * stored preview on the right. Shares the record card's shell so both read
 * the same way in the article.
 */
export function LinkCard({
  card,
}: {
  card: Extract<ReaderBlockValue, { kind: "linkCard" }>;
}) {
  const host = linkHost(card.href);
  return (
    <a
      href={card.href}
      target="_blank"
      rel="noopener noreferrer"
      data-record-card="row"
      data-reader-link-card
    >
      {card.imageUrl && (
        <RowPreviewImage key={card.imageUrl} src={card.imageUrl} />
      )}
      <div data-record-copy>
        <p data-record-title>{card.title}</p>
        {card.description && <p data-record-description>{card.description}</p>}
        {host && <p data-record-metadata>{host}</p>}
      </div>
    </a>
  );
}
