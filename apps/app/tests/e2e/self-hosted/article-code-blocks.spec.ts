import { expect, test } from "@playwright/test";
import { signIn } from "../fixtures/auth";
import {
  SELF_HOSTED_APP_PORT,
  SELF_HOSTED_TURSO_PORT,
} from "../fixtures/ports";
import {
  cleanupUser,
  seedArticleData,
  seedBookmarkProjectionData,
  setFeedItemContent,
} from "../fixtures/seed-db";

const longLine = `const message = "${"A long line of code. ".repeat(18)}";`;
const articleHtml = `<p>Code examples retain their formatting in the reader.</p>
  <pre id="short"><code class="language-javascript">const answer = 42;\nconsole.log(answer);</code></pre>
  <pre id="wide"><code class="language-javascript">${longLine}</code></pre>
  <p>Images that cannot load keep their place in the article.</p>
  <img src="https://images.example.com/unavailable.jpg" alt="Unavailable illustration">`;

test.describe("article code and image layout", () => {
  test.use({ serviceWorkers: "block" });
  let email: string;
  test.afterEach(async () => {
    if (email) await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
  });

  for (const kind of ["full", "simplified", "bookmark"] as const) {
    test(`${kind} code fills the reader and scrolls within its block`, async ({
      page,
    }) => {
      const fixture = await seedArticleData(
        SELF_HOSTED_TURSO_PORT,
        SELF_HOSTED_APP_PORT,
      );
      email = fixture.email;
      await setFeedItemContent(
        SELF_HOSTED_TURSO_PORT,
        fixture.feedItemId,
        articleHtml,
      );
      const contentId =
        kind === "bookmark"
          ? (
              await seedBookmarkProjectionData(
                SELF_HOSTED_TURSO_PORT,
                email,
                fixture.feedItemId,
                articleHtml,
              )
            ).bookmarkId
          : fixture.feedItemId;
      await page.addInitScript(
        (style) => {
          localStorage.setItem(
            "serial-flag-article-style",
            JSON.stringify(style),
          );
        },
        kind === "simplified" ? "simplified" : "full",
      );
      await page.route("https://images.example.com/**", (route) =>
        route.abort(),
      );
      await signIn({ page, email, password: fixture.password });
      await page.goto(`/read/${contentId}`);
      const blocks = page.locator("pre");
      await expect(blocks).toHaveCount(2);
      await expect(blocks.first().locator(".hljs-keyword")).toBeVisible();
      await expect(blocks.last()).toHaveText(longLine);

      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const geometry = await blocks.first().evaluate((short) => {
          const wide = document.querySelectorAll("pre")[1]!;
          const parent = short.parentElement!;
          const style = getComputedStyle(parent);
          const available =
            parent.clientWidth -
            parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight);
          wide.scrollLeft = 100;
          const scrollContainer = document.querySelector(
            '[data-slot="sidebar-inset"]',
          )!;
          return {
            short: short.getBoundingClientRect().width,
            wide: wide.getBoundingClientRect().width,
            available,
            scrollLeft: wide.scrollLeft,
            pageOverflow:
              scrollContainer.scrollWidth - scrollContainer.clientWidth,
            whiteSpace: getComputedStyle(wide).whiteSpace,
          };
        });
        expect(
          Math.abs(geometry.short - geometry.available),
        ).toBeLessThanOrEqual(1);
        expect(geometry.wide).toBe(geometry.short);
        expect(geometry.scrollLeft).toBeGreaterThan(0);
        expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
        expect(geometry.whiteSpace).toBe("pre");

        if (kind !== "simplified") {
          const placeholder = page.locator("[data-image-fallback]");
          await placeholder.scrollIntoViewIfNeeded();
          await expect(placeholder).toBeVisible();
          const box = await placeholder.boundingBox();
          expect(box).not.toBeNull();
          expect(Math.abs(box!.width - geometry.available)).toBeLessThanOrEqual(
            1,
          );
          expect(Math.abs(box!.width / box!.height - 16 / 9)).toBeLessThan(
            0.02,
          );
        }
      }
      const token = blocks.first().locator(".hljs-keyword");
      await page.evaluate(() =>
        document.documentElement.classList.remove("dark"),
      );
      const light = await token.evaluate(
        (node) => getComputedStyle(node).color,
      );
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      expect(
        await token.evaluate((node) => getComputedStyle(node).color),
      ).not.toBe(light);

      await blocks.last().evaluate((node) => {
        node.scrollLeft = 0;
      });
      await blocks.last().focus();
      await page.keyboard.press("ArrowRight");
      await expect
        .poll(() => blocks.last().evaluate((node) => node.scrollLeft))
        .toBeGreaterThan(0);
    });
  }
});
