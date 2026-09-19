import { useState } from "react";
import type { RecordCard as RecordCardData } from "@serial/standard-site";
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
      {card.size !== "small" && card.imageUrl && (
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
