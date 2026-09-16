import rss from "@astrojs/rss";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { render } from "astro:content";
import sanitizeHtml from "sanitize-html";
import { getAllReleases } from "../../lib/content";
import { RELEASES } from "../../lib/releases";

function resolveSiteUrl(site, value) {
  if (!value || !value.startsWith("/")) return value;
  return new URL(value, site).toString();
}

function resolveAttribute(site, attribute) {
  return (tagName, attributes) => ({
    tagName,
    attribs: {
      ...attributes,
      [attribute]: resolveSiteUrl(site, attributes[attribute]),
    },
  });
}

export async function GET(context) {
  const container = await AstroContainer.create();
  const releases = await getAllReleases();
  const releasesUrl = `${RELEASES.url}/`;
  const iconUrl = new URL("/icon-256.png", context.site).toString();

  const items = await Promise.all(
    releases.map(async (release) => {
      const { Content } = await render(release);
      const content = await container.renderToString(Content);

      return {
        title: release.data.title,
        description: release.data.description,
        pubDate: new Date(`${release.data.publish_date}T00:00:00Z`),
        link: `${releasesUrl}${release.id}/`,
        content: sanitizeHtml(content, {
          allowedTags: sanitizeHtml.defaults.allowedTags.concat([
            "img",
            "figure",
            "figcaption",
          ]),
          allowedAttributes: {
            ...sanitizeHtml.defaults.allowedAttributes,
            img: ["src", "alt", "width", "height"],
          },
          transformTags: {
            a: resolveAttribute(context.site, "href"),
            img: resolveAttribute(context.site, "src"),
          },
          exclusiveFilter: (frame) =>
            frame.tag === "a" && !frame.text.trim(),
        }),
      };
    }),
  );

  return rss({
    title: RELEASES.name,
    description: RELEASES.description,
    site: releasesUrl,
    items,
    customData: `
      <language>en-us</language>
      <image>
        <url>${iconUrl}</url>
        <title>${RELEASES.name}</title>
        <link>${releasesUrl}</link>
      </image>
    `,
  });
}
