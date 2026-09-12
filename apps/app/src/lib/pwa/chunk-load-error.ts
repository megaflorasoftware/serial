// The browser-specific messages a failed dynamic `import()` produces
// (Chrome, Firefox, Safari) plus Vite's stylesheet preload failure. These
// mirror the router's own module-not-found detection, which it does not
// export.
const CHUNK_LOAD_ERROR_PREFIXES = [
  "Failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "Importing a module script failed",
  "Unable to preload CSS",
];

export function isChunkLoadError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : undefined;
  if (typeof message !== "string") return false;
  return CHUNK_LOAD_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix));
}
