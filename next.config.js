/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
await import("./src/env.js");

import withPWA from "@ducanh2912/next-pwa";

const wrapConfig = withPWA({
  cacheOnFrontEndNav: true,
  aggressiveFrontEndNavCaching: true,
  reloadOnOnline: true,
  dest: "public",
  fallbacks: {
    //image: "/static/images/fallback.png",
    // document: "/offline", // if you want to fallback to a custom page rather than /_offline
    // font: '/static/font/fallback.woff2',
    // audio: ...,
    // video: ...,
  },
  workboxOptions: {
    disableDevLogs: true,
  },
  // ... other options you like
});

/** @type {import("next").NextConfig} */
const config = {};

export default wrapConfig(config);
