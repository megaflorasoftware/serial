import { AtpAgent } from "@atproto/api";
import { createEnv } from "@t3-oss/env-core";
import { allReleases } from "content-collections";
import { z } from "zod";
import { parsePublicationUri, STANDARD_SITE } from "../src/lib/standard-site";
import {
  buildPublicationRecord,
  planDocumentSync,
} from "../src/lib/standard-site/records";
import type { StandardSiteRecord } from "../src/lib/standard-site/records";

const syncEnv = createEnv({
  server: {
    STANDARD_SITE_PDS_URL: z.url(),
    STANDARD_SITE_IDENTIFIER: z.string().min(1),
    STANDARD_SITE_APP_PASSWORD: z.string().min(1),
    VITE_PUBLIC_STANDARD_SITE_PUBLICATION_URI: z.string().min(1),
  },
  runtimeEnv: {
    STANDARD_SITE_PDS_URL: process.env.STANDARD_SITE_PDS_URL,
    STANDARD_SITE_IDENTIFIER: process.env.STANDARD_SITE_IDENTIFIER,
    STANDARD_SITE_APP_PASSWORD: process.env.STANDARD_SITE_APP_PASSWORD,
    VITE_PUBLIC_STANDARD_SITE_PUBLICATION_URI:
      process.env.VITE_PUBLIC_STANDARD_SITE_PUBLICATION_URI,
  },
  emptyStringAsUndefined: true,
});

const isDryRun = process.argv.includes("--dry-run");
const publicationUri = syncEnv.VITE_PUBLIC_STANDARD_SITE_PUBLICATION_URI;
const publication = parsePublicationUri(publicationUri);
const releases = allReleases
  .filter((release) => release.public)
  .sort((a, b) => a.publish_date.localeCompare(b.publish_date));

async function listDocumentRecords(agent: AtpAgent, repo: string) {
  const records: StandardSiteRecord[] = [];
  let cursor: string | undefined;

  do {
    const response = await agent.com.atproto.repo.listRecords({
      repo,
      collection: STANDARD_SITE.documentCollection,
      limit: 100,
      cursor,
    });

    records.push(...response.data.records);
    cursor = response.data.cursor;
  } while (cursor);

  return records;
}

async function syncStandardSite() {
  const agent = new AtpAgent({ service: syncEnv.STANDARD_SITE_PDS_URL });
  await agent.login({
    identifier: syncEnv.STANDARD_SITE_IDENTIFIER,
    password: syncEnv.STANDARD_SITE_APP_PASSWORD,
  });

  if (agent.did !== publication.did) {
    throw new Error(
      `Authenticated DID ${agent.did ?? "(missing)"} does not match publication DID ${publication.did}.`,
    );
  }

  const existingRecords = await listDocumentRecords(agent, publication.did);
  const plan = planDocumentSync(releases, publicationUri, existingRecords);

  console.log(
    `${isDryRun ? "Would sync" : "Syncing"} publication, ${plan.upserts.length} release documents, and ${plan.deletes.length} stale document deletions.`,
  );

  if (isDryRun) {
    for (const { rkey, record } of plan.upserts) {
      console.log(
        `PUT ${STANDARD_SITE.documentCollection}/${rkey} ${record.path}`,
      );
    }
    for (const rkey of plan.deletes) {
      console.log(`DELETE ${STANDARD_SITE.documentCollection}/${rkey}`);
    }
    return;
  }

  await agent.com.atproto.repo.putRecord({
    repo: publication.did,
    collection: STANDARD_SITE.publicationCollection,
    rkey: publication.rkey,
    record: buildPublicationRecord(),
  });

  for (const { rkey, record } of plan.upserts) {
    await agent.com.atproto.repo.putRecord({
      repo: publication.did,
      collection: STANDARD_SITE.documentCollection,
      rkey,
      record,
    });
  }

  for (const rkey of plan.deletes) {
    await agent.com.atproto.repo.deleteRecord({
      repo: publication.did,
      collection: STANDARD_SITE.documentCollection,
      rkey,
    });
  }
}

await syncStandardSite();
