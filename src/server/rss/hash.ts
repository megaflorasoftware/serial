import { createHash } from "node:crypto";

export function computeItemHash(item: {
  contentId: string;
  title: string;
  author: string;
  content?: string | null;
  thumbnail?: string | null;
  postedAt?: Date | null;
  progress?: number | null;
  duration?: number | null;
}): string {
  const data = [
    item.contentId,
    item.title,
    item.author,
    item.content ?? "",
    item.thumbnail ?? "",
    item.postedAt?.getTime() ?? "",
    item.progress ?? 0,
    item.duration ?? 0,
  ].join("\0");

  return createHash("sha256").update(data).digest("hex");
}
