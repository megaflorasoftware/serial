import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { StreamTransport } from "~/server/jetstream/transport";
import { startStreamWorker } from "~/server/jetstream/service";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import {
  atprotoStreamState,
  feedOriginAtproto,
  feedOriginAtprotoDocuments,
  user,
} from "~/server/db/schema";

const state = vi.hoisted(() => ({
  transport: undefined as StreamTransport | undefined,
}));
vi.mock("~/env", () => ({
  env: {
    ATPROTO_JETSTREAM_ENDPOINT: "https://jetstream.example.com",
    BACKGROUND_REFRESH_ENABLED: true,
  },
}));
vi.mock("~/server/jetstream/transport", () => ({
  createStreamTransport: () => state.transport,
  retryStream: vi.fn(),
}));
vi.mock("~/server/api/publisher", () => ({ publisher: { publish: vi.fn() } }));
vi.mock("~/server/subscriptions/helpers", () => ({
  getUserPlanId: async () => "pro",
}));
vi.mock("~/server/logger", () => ({
  captureException: vi.fn(),
  logMessage: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}));
let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>> | undefined;
afterEach(() => fixture?.cleanup());

it("receives events for a Publication followed after the connection starts", async () => {
  fixture = await createBookmarkTestDatabase();
  const database = fixture.database;
  const shutdown = new AbortController();
  const service = "https://jetstream.example.com";
  await database.insert(user).values({
    id: "reader",
    name: "Reader",
    email: "reader@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const follow = async (did: string) => {
    const feed = await insertFeedWithOrigins(database, {
      userId: "reader",
      isActive: true,
      details: {
        name: "Feed",
        platform: "website",
        imageUrl: "",
        origins: [
          {
            kind: "atproto",
            locator: `at://${did}/site.standard.publication/site`,
          },
        ],
      },
    });
    const originId = feed.origins[0]!.id;
    // Catch-up mode retains staged events while its own bootstrap finishes.
    await database
      .update(feedOriginAtproto)
      .set({ streamService: service, streamSeq: "1", streamMode: "catchup" })
      .where(eq(feedOriginAtproto.originId, originId));
    return originId;
  };
  await follow("did:plc:original");
  await database
    .insert(atprotoStreamState)
    .values({ id: "primary", service, seq: "1" });
  let newcomer = 0;
  state.transport = {
    service,
    hasReplay: true,
    report: vi.fn(),
    tip: async () => 1,
    recover() {
      throw new Error("Bootstrap deferred in this fixture");
    },
    async *stream(_after, _signal, dids) {
      const did = "did:plc:newcomer";
      newcomer = await follow(did);
      if (!dids || dids.includes(did))
        yield {
          lastCursor: 2,
          events: [
            {
              seq: 2,
              did,
              time: new Date().toISOString(),
              kind: "commit",
              commit: {
                operation: "create",
                collection: "site.standard.document",
                rkey: "post",
                rev: "2222222222222",
                cid: "cid",
                record: {
                  site: `at://${did}/site.standard.publication/site`,
                  title: "New item",
                  path: "/post",
                  publishedAt: new Date().toISOString(),
                },
              },
            },
          ],
        };
      shutdown.abort();
    },
  };
  // Skip actual PDS bootstrap in the independent background sweep.
  await database
    .update(feedOriginAtproto)
    .set({ recoveryRetryAt: new Date(Date.now() + 60000) });
  try {
    await startStreamWorker(database, shutdown.signal);
    expect(
      await database
        .select()
        .from(feedOriginAtprotoDocuments)
        .where(eq(feedOriginAtprotoDocuments.originId, newcomer)),
    ).toHaveLength(1);
  } finally {
    shutdown.abort();
  }
});
