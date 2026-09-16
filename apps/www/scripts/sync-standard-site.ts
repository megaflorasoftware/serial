import { readFile } from "node:fs/promises";
import { AtpAgent } from "@atproto/api";
import { z } from "zod";
import { parsePublicationUri, STANDARD_SITE } from "../src/lib/standard-site";
import { loadReleaseDocuments } from "./lib/standard-site-content";
import {
  assertStandardSiteSyncPlanIsSafe,
  planStandardSiteSync,
} from "../src/lib/standard-site/records";
import type { StandardSiteRecord } from "../src/lib/standard-site/records";

const syncEnvSchema = z.object({
  WWW_STANDARD_SITE_PDS_URL: z.url(),
  WWW_STANDARD_SITE_IDENTIFIER: z.string().min(1),
  WWW_STANDARD_SITE_APP_PASSWORD: z.string().min(1),
  WWW_STANDARD_SITE_PUBLICATION_URI: z.string().min(1),
});

const syncEnv = syncEnvSchema.parse(process.env);

const isDryRun = process.argv.includes("--dry-run");
const allowLargeDelete = process.argv.includes("--allow-large-delete");
const publicationUri = syncEnv.WWW_STANDARD_SITE_PUBLICATION_URI;
const publication = parsePublicationUri(publicationUri);
const publicationIcon = {
  mimeType: "image/png",
  url: new URL("../public/icon-256.png", import.meta.url),
} as const;

async function listRecords(agent: AtpAgent, repo: string, collection: string) {
  const records: StandardSiteRecord[] = [];
  let cursor: string | undefined;

  do {
    const response = await agent.com.atproto.repo.listRecords({
      repo,
      collection,
      limit: 100,
      cursor,
    });

    records.push(...response.data.records);
    cursor = response.data.cursor;
  } while (cursor);

  return records;
}

async function syncStandardSite() {
  const documents = await loadReleaseDocuments();
  const agent = new AtpAgent({ service: syncEnv.WWW_STANDARD_SITE_PDS_URL });
  await agent.login({
    identifier: syncEnv.WWW_STANDARD_SITE_IDENTIFIER,
    password: syncEnv.WWW_STANDARD_SITE_APP_PASSWORD,
  });

  if (agent.did !== publication.did) {
    throw new Error(
      `Authenticated DID ${agent.did ?? "(missing)"} does not match publication DID ${publication.did}.`,
    );
  }

  const publicationIconBytes = await readFile(publicationIcon.url);
  const publicationIconResponse = await agent.uploadBlob(publicationIconBytes, {
    encoding: publicationIcon.mimeType,
  });
  const [existingPublications, existingDocuments] = await Promise.all([
    listRecords(agent, publication.did, STANDARD_SITE.publicationCollection),
    listRecords(agent, publication.did, STANDARD_SITE.documentCollection),
  ]);
  const plan = planStandardSiteSync({
    documents,
    publicationUri,
    publicationIcon: publicationIconResponse.data.blob,
    existingPublications,
    existingDocuments,
  });

  if (!isDryRun) {
    assertStandardSiteSyncPlanIsSafe(plan, { allowLargeDelete });
  }

  console.log(
    `${isDryRun ? "Would apply" : "Applying"} ${plan.creates} creates, ${plan.updates} updates, and ${plan.deletes} deletes.`,
  );

  if (isDryRun) {
    for (const write of plan.writes) {
      const operation = write.$type.split("#").at(-1)?.toUpperCase();
      console.log(`${operation} ${write.collection}/${write.rkey}`);
    }
    return;
  }

  if (!plan.writes.length) return;

  await agent.com.atproto.repo.applyWrites({
    repo: publication.did,
    writes: plan.writes,
  });
}

await syncStandardSite();
