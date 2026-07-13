import { allReleases } from "content-collections";
import type { Release } from "content-collections";

const releases = allReleases;

function sortReleases(a: Release, b: Release) {
  if (a.publish_date < b.publish_date) return 1;
  return -1;
}

export function getMostRecentRelease() {
  return releases.filter((release) => release.public).sort(sortReleases)[0];
}
