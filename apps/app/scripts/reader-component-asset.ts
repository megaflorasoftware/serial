import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Identify the lazy component, excluding the route definition needed to boot. */
export function readerComponentAsset(outputDirectory = ".output/public") {
  const assetsDirectory = path.join(outputDirectory, "assets");
  for (const filename of readdirSync(assetsDirectory)) {
    if (!filename.endsWith(".js.map")) continue;
    const map = JSON.parse(
      readFileSync(path.join(assetsDirectory, filename), "utf8"),
    ) as { sources: string[] };
    if (
      map.sources.some((source) =>
        source.endsWith("/src/app/_app.read.$id.tsx?tsr-split=component"),
      )
    ) {
      return `assets/${filename.slice(0, -4)}`;
    }
  }
  throw new Error(
    "The production test build has no reader component source map",
  );
}
