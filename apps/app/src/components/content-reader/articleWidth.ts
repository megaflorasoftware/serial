const ARTICLE_WIDTH_CLASS_NAMES = [
  "max-w-xl",
  "max-w-2xl",
  "max-w-3xl",
  "max-w-4xl",
  "max-w-5xl",
  "max-w-6xl",
  "max-w-7xl",
] as const;

export function getArticleWidthClassName(zoom: number) {
  return ARTICLE_WIDTH_CLASS_NAMES[zoom] ?? ARTICLE_WIDTH_CLASS_NAMES[0];
}
