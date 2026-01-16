import configuration from "../../content-collections.ts";
import { GetTypeByName } from "@content-collections/core";

export type Release = GetTypeByName<typeof configuration, "releases">;
export declare const allReleases: Array<Release>;

export {};
