import dayjs from "dayjs";
import satori from "satori";
import sharp from "sharp";
import serialLogoDataUrl from "../../../public/icon-256.png?inline";
import outfitBoldDataUrl from "./assets/Outfit-Bold.ttf?inline";
import outfitRegularDataUrl from "./assets/Outfit-Regular.ttf?inline";

import type { Release } from "content-collections";

type ReleaseOgData = Pick<
  Release,
  "description" | "publish_date" | "slug" | "title"
>;

export const RELEASE_OG_IMAGE_SIZE = {
  width: 1200,
  height: 630,
} as const;

const RELEASE_OG_COLORS = {
  background: "#ffffff",
  foreground: "#1d1b1a",
  muted: "#efefeb",
  mutedForeground: "#777777",
} as const;

const RELEASE_OG_TEXT_LIMITS = {
  title: 100,
  description: 190,
} as const;

function decodeFontDataUrl(dataUrl: string) {
  const encodedFont = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Buffer.from(encodedFont, "base64");
}

const OUTFIT_FONTS = {
  regular: decodeFontDataUrl(outfitRegularDataUrl),
  bold: decodeFontDataUrl(outfitBoldDataUrl),
} as const;

function truncateText(text: string, maximumLength: number) {
  if (text.length <= maximumLength) return text;

  const truncatedText = text.slice(0, maximumLength - 1).trimEnd();
  return `${truncatedText}…`;
}

function NotebookTextIcon() {
  return (
    <svg
      width="52"
      height="52"
      viewBox="0 0 24 24"
      fill="none"
      stroke={RELEASE_OG_COLORS.mutedForeground}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 6h4" />
      <path d="M2 10h4" />
      <path d="M2 14h4" />
      <path d="M2 18h4" />
      <rect width="16" height="20" x="4" y="2" rx="2" />
      <path d="M9.5 8h5" />
      <path d="M9.5 12H16" />
      <path d="M9.5 16H14" />
    </svg>
  );
}

function ReleaseOgImage({ release }: { release: ReleaseOgData }) {
  const title = truncateText(release.title, RELEASE_OG_TEXT_LIMITS.title);
  const description = release.description
    ? truncateText(release.description, RELEASE_OG_TEXT_LIMITS.description)
    : undefined;

  return (
    <div
      style={{
        alignItems: "center",
        backgroundColor: RELEASE_OG_COLORS.background,
        color: RELEASE_OG_COLORS.foreground,
        display: "flex",
        flexDirection: "column",
        fontFamily: "Outfit",
        height: "100%",
        justifyContent: "center",
        padding: "64px 80px",
        position: "relative",
        textAlign: "center",
        width: "100%",
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          flexDirection: "column",
          maxWidth: "1020px",
        }}
      >
        <div
          style={{
            alignItems: "center",
            backgroundColor: RELEASE_OG_COLORS.muted,
            borderRadius: "20px",
            display: "flex",
            height: "92px",
            justifyContent: "center",
            marginBottom: "28px",
            width: "92px",
          }}
        >
          <NotebookTextIcon />
        </div>
        <div
          style={{
            display: "flex",
            fontSize: title.length > 60 ? "56px" : "64px",
            fontWeight: 700,
            letterSpacing: "-1.5px",
            lineHeight: 1.08,
          }}
        >
          {title}
        </div>
        {description && (
          <div
            style={{
              display: "flex",
              fontSize: "30px",
              lineHeight: 1.25,
              marginTop: "18px",
              maxWidth: "960px",
            }}
          >
            {description}
          </div>
        )}
        <div
          style={{
            color: RELEASE_OG_COLORS.mutedForeground,
            display: "flex",
            fontSize: "28px",
            lineHeight: 1.2,
            marginTop: "14px",
          }}
        >
          {dayjs(release.publish_date).format("MMMM DD, YYYY")}
        </div>
      </div>
      <div
        style={{
          alignItems: "center",
          bottom: "36px",
          color: RELEASE_OG_COLORS.foreground,
          display: "flex",
          fontSize: "24px",
          fontWeight: 700,
          gap: "10px",
          letterSpacing: "0.5px",
          position: "absolute",
        }}
      >
        <img
          src={serialLogoDataUrl}
          alt=""
          width={32}
          height={32}
          style={{ borderRadius: "8px", height: 32, width: 32 }}
        />
        Serial
      </div>
    </div>
  );
}

export async function renderReleaseOgImage(release: ReleaseOgData) {
  const svg = await satori(<ReleaseOgImage release={release} />, {
    ...RELEASE_OG_IMAGE_SIZE,
    fonts: [
      {
        name: "Outfit",
        data: OUTFIT_FONTS.regular,
        weight: 400,
        style: "normal",
      },
      {
        name: "Outfit",
        data: OUTFIT_FONTS.bold,
        weight: 700,
        style: "normal",
      },
    ],
  });

  return sharp(Buffer.from(svg)).png().toBuffer();
}
