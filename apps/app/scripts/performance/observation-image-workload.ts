import { enrichObservationImages } from "~/server/rss/observationImages";
import { rssObservation } from "~/server/rss/itemObservation";

export function createObservationImageWorkload() {
  const observations = Array.from({ length: 100 }, (_, i) =>
    rssObservation({
      id: `${i}`,
      title: "Article",
      author: "Author",
      url: `https://example.com/${i}`,
      publishedDate: "2026-09-15T12:00:00Z",
      content: "<p>Body</p>",
    }),
  );
  let requests = 0;
  return {
    get requests() {
      return requests;
    },
    prepare() {
      requests = 0;
    },
    run() {
      return enrichObservationImages(observations, async (url) => {
        requests++;
        return {
          url,
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          text: '<meta property="og:image" content="https://example.com/image.png">',
        };
      });
    },
  };
}
