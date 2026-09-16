export type ItemObservation = {
  kind: "rss" | "atproto";
  key: string;
  url: string;
  title: string;
  author: string;
  description: string;
  thumbnail: string;
  content: string;
  firstParagraph: string;
  firstImageUrl: string;
  publishedAt: string;
  tags: string[];
  publicationName?: string;
};
