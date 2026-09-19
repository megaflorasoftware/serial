export type ItemObservation = {
  kind: "rss" | "atproto";
  key: string;
  url: string;
  title: string;
  author: string;
  description: string;
  thumbnail: string;
  pageImageUrl?: string;
  content: string;
  /** Set when the body is a retained Document source rather than HTML. */
  sourceCid?: string;
  firstParagraph: string;
  firstImageUrl: string;
  publishedAt: string;
  tags: string[];
  publicationName?: string;
};
