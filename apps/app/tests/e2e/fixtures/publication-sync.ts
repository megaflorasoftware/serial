import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import * as schema from "../../../src/server/db/schema";
import {
  PUBLICATIONS_PDS_PORT,
  PUBLICATIONS_TURSO_PORT,
  SELF_HOSTED_RSS_SERVER_PORT,
} from "./ports";

export const SUBSCRIPTION_COLLECTION = "site.standard.graph.subscription";
export const PUBLICATION_COLLECTION = "site.standard.publication";
export async function withPublicationDatabase<T>(
  operation: (db: ReturnType<typeof drizzle<typeof schema>>) => Promise<T>,
) {
  const client = createClient({
    url: `http://127.0.0.1:${PUBLICATIONS_TURSO_PORT}`,
  });
  try {
    return await operation(drizzle({ client, schema }));
  } finally {
    client.close();
  }
}
export async function readPublicationConnection(did: string) {
  return withPublicationDatabase((db) =>
    db
      .select()
      .from(schema.atprotoConnections)
      .where(eq(schema.atprotoConnections.did, did))
      .get(),
  );
}
export async function pdsControl(input: {
  operation: "put" | "delete" | "inspect" | "pause" | "release";
  repo: string;
  collection?: string;
  rkey?: string;
  value?: Record<string, unknown>;
}) {
  const response = await fetch(
    `http://127.0.0.1:${PUBLICATIONS_PDS_PORT}/control`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) throw new Error(`PDS control failed: ${response.status}`);
  return (await response.json()) as {
    records: Array<{ uri: string; value: Record<string, unknown> }>;
    writes: Array<{ method: string; uri: string }>;
    waiting: boolean;
  };
}
export async function seedPublication(repo: string, rkey: string) {
  const url = `http://127.0.0.1:${SELF_HOSTED_RSS_SERVER_PORT}/publications/${rkey}`;
  await pdsControl({
    operation: "put",
    repo,
    collection: PUBLICATION_COLLECTION,
    rkey,
    value: { $type: PUBLICATION_COLLECTION, name: `Publication ${rkey}`, url },
  });
  return { uri: `at://${repo}/${PUBLICATION_COLLECTION}/${rkey}`, url };
}
export async function seedRemoteSubscription(
  repo: string,
  rkey: string,
  publication: string,
) {
  await pdsControl({
    operation: "put",
    repo,
    collection: SUBSCRIPTION_COLLECTION,
    rkey,
    value: {
      $type: SUBSCRIPTION_COLLECTION,
      publication,
      createdAt: new Date().toISOString(),
    },
  });
}
export async function seedLocalPublication(
  userId: string,
  publication: { uri: string; url: string },
) {
  return withPublicationDatabase(async (db) => {
    const [feed] = await db
      .insert(schema.feeds)
      .values({
        userId,
        name: "Local publication",
        nameEditedAt: new Date(),
        platform: "website",
        siteUrl: publication.url,
        isActive: true,
      })
      .returning();
    if (!feed) throw new Error("Feed insert failed");
    const [origin] = await db
      .insert(schema.feedOrigins)
      .values({
        userId,
        feedId: feed.id,
        kind: "atproto",
        locator: publication.uri,
        nextFetchAt: new Date("2099-01-01"),
      })
      .returning({ id: schema.feedOrigins.id });
    await db.insert(schema.feedOriginAtproto).values({
      originId: origin!.id,
      publicationDid: publication.uri.split("/")[2]!,
    });
    return feed;
  });
}
export async function localPublicationOrigins(userId: string) {
  return withPublicationDatabase((db) =>
    db
      .select({
        locator: schema.feedOrigins.locator,
        active: schema.feeds.isActive,
        id: schema.feeds.id,
      })
      .from(schema.feedOrigins)
      .innerJoin(schema.feeds, eq(schema.feedOrigins.feedId, schema.feeds.id))
      .where(eq(schema.feedOrigins.userId, userId)),
  );
}

export async function fillPublicationQuota(userId: string, count: number) {
  await withPublicationDatabase(async (db) => {
    for (let offset = 0; offset < count; offset += 100) {
      await db.insert(schema.feeds).values(
        Array.from({ length: Math.min(100, count - offset) }, (_, index) => ({
          userId,
          name: `Quota feed ${offset + index}`,
          platform: "website",
          isActive: true,
        })),
      );
    }
  });
}

export async function resumePublicationOnboarding(userId: string) {
  const { savedOnboardingStep } =
    await import("../../../src/lib/onboarding/progress");
  await withPublicationDatabase((db) =>
    db
      .update(schema.user)
      .set({
        onboardingComplete: false,
        onboardingStep: savedOnboardingStep("atmosphere-sync-setup"),
      })
      .where(eq(schema.user.id, userId)),
  );
}
export async function readPublicationUser(userId: string) {
  return withPublicationDatabase((db) =>
    db.select().from(schema.user).where(eq(schema.user.id, userId)).get(),
  );
}
