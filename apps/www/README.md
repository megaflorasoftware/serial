# Serial website

The public marketing website for [Serial](https://github.com/megaflorasoftware/serial), served at [serial.tube](https://serial.tube). The application is in the same monorepo under `apps/app` and is hosted at [app.serial.tube](https://app.serial.tube).

Built with [Astro](https://astro.build) and Tailwind CSS 4.

## Pages

- `/` — landing page (formerly `/welcome` in the app)
- `/pricing` — main-instance pricing
- `/guides`, `/guides/[slug]` — guide articles (content in `src/content/guides`)
- `/releases`, `/releases/[slug]` — release notes
- `/releases/rss.xml` — release notes RSS feed
- `/sitemap.xml`, `/.well-known/site.standard.publication`
- `/api/og/{releases,guides}/[slug].png` — generated Open Graph images

## Content

Guides live in `src/content/guides` and release notes in `src/content/releases`, both loaded through Astro content collections (`src/content.config.ts`).

## Signed-in call to action

The site is fully static and never redirects. A small script in `src/layouts/Site.astro` sends one credentialed request per tab to the app's Better Auth session endpoint (`WWW_APP_URL` + `/api/auth/get-session`). When the visitor has a session, every `AppLink` call-to-action is relabelled from "Get Started" to "Open Serial"; any failure leaves the static copy untouched. This relies on the production app setting `COOKIE_DOMAIN=.serial.tube`, which both scopes the session cookie to the `www` host and makes the app return credentialed CORS headers for it. Cached HTML is identical for every visitor, so no CDN rule or edge script is involved.

## Deployment

Pushes to `main` run `.github/workflows/deploy-www.yml`, which builds the site, reconciles `apps/www/dist/` with Bunny Storage, and purges the Bunny pull-zone cache. Required repo secrets: `WWW_BUNNY_STORAGE_ZONE_ENDPOINT`, `WWW_BUNNY_STORAGE_ZONE_NAME`, `WWW_BUNNY_STORAGE_ZONE_PASSWORD`, `WWW_BUNNY_API_KEY`, `WWW_BUNNY_PULL_ZONE_ID`; repo variables: `WWW_APP_URL`, `WWW_SUPPORT_EMAIL_ADDRESS`, `WWW_STANDARD_SITE_PUBLICATION_URI`, `WWW_UMAMI_WEBSITE_ID`, `WWW_UMAMI_SRC`. The canonical host is `www.serial.tube` — redirect the apex domain to it at the DNS/CDN level.

## Development

```sh
pnpm install
pnpm --filter @serial/www dev
pnpm --filter @serial/www build # static output in apps/www/dist/
```

Environment variables are documented in `.env.example`.

## Standard.Site sync

`pnpm --filter @serial/www standard-site:sync` publishes the same public release notes as RSS under the `Serial Releases` publication at `https://www.serial.tube/releases`, reading the markdown in `src/content/releases` directly. Guides are excluded; sync removes previously published guide documents while retaining the publication and release record identities. Publication verification is served at `/.well-known/site.standard.publication/releases`. Use `--dry-run` to preview and `--allow-large-delete` to override the delete guard. Requires the `WWW_STANDARD_SITE_*` variables from `.env.example`. The GitHub workflow always supports manual runs when credentials are configured; automatic push-triggered syncs also require the repository variable `WWW_STANDARD_SITE_SYNC_ENABLED=true`.
