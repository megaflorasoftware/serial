import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { StreamTransport } from "~/server/jetstream/transport";
import {
  refreshStreamOrigin,
  startStreamWorker,
} from "~/server/jetstream/service";
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
vi.mock("~/server/jetstream/endpoint", () => ({
  resolveStreamService: async (url: string) => url,
}));
vi.mock("~/server/jetstream/transport", () => ({
  createStreamTransport: () => state.transport,
  retryStream: vi.fn(async () => {}),
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

it.each([true, false])(
  "restarts and reconnects live without repository/archive recovery, archive=%s",
  async (hasReplay) => {
    fixture = await createBookmarkTestDatabase();
    const database = fixture.database;
    const service = "https://jetstream.example.com";
    const shutdown = new AbortController();
    const now = new Date();
    await database.insert(user).values({
      id: "reader",
      name: "Reader",
      email: "reader@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    const locator = "at://did:plc:alice/site.standard.publication/site";
    const feed = await insertFeedWithOrigins(database, {
      userId: "reader",
      isActive: true,
      details: {
        name: "Publication",
        platform: "website",
        imageUrl: "",
        origins: [{ kind: "atproto", locator }],
      },
    });
    await database.update(feedOriginAtproto).set({
      initialized: true,
      streamService: service,
      streamSeq: "1",
      streamMode: "live",
      publicationRecord: {
        uri: locator,
        cid: "pub",
        value: { name: "Publication", url: "https://example.com" },
      },
    });
    await database
      .insert(atprotoStreamState)
      .values({ id: "primary", service, seq: "1" });
    const before = await database.select().from(feedOriginAtproto);
    let attempts = 0;
    const recover = vi.fn(() => {
      throw new Error("Recovery must wait for a normal fetch");
    });
    const tip = vi.fn(async () => 1);
    state.transport = {
      service,
      hasReplay,
      recover,
      tip,
      report: vi.fn(),
      async *stream(_after, _signal, _dids, onOpen) {
        await onOpen?.();
        expect(
          (await database.select().from(atprotoStreamState))[0]?.connected,
        ).toBe(true);
        attempts++;
        yield { events: [], lastCursor: attempts + 1 };
        if (attempts === 1) throw new Error("upstream disconnected");
        shutdown.abort();
      },
    };
    try {
      await startStreamWorker(database, shutdown.signal);
      expect(attempts).toBe(2);
      expect(recover).not.toHaveBeenCalled();
      expect(tip).not.toHaveBeenCalled();
      expect(await database.select().from(feedOriginAtproto)).toEqual(before);
      expect(
        (await database.select().from(atprotoStreamState))[0],
      ).toMatchObject({ connected: false });
      expect(
        (await database.select().from(atprotoStreamState))[0]!.generation,
      ).toBeGreaterThan(0);
      expect(feed.origins).toHaveLength(1);
    } finally {
      shutdown.abort();
    }
  },
);

it("reports a pending recovery retry as a fetch error instead of an empty refresh", async () => {
  fixture = await createBookmarkTestDatabase();
  const database = fixture.database;
  const service = "https://jetstream.example.com";
  const now = new Date();
  await database.insert(user).values({
    id: "reader",
    name: "Reader",
    email: "reader@example.com",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
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
          locator: "at://did:plc:alice/site.standard.publication/site",
        },
      ],
    },
  });
  await database
    .insert(atprotoStreamState)
    .values({ id: "primary", service, seq: "1" });
  const tip = vi.fn(async () => {
    throw new Error("Jetstream unavailable");
  });
  state.transport = {
    service,
    hasReplay: false,
    recover: vi.fn(),
    tip,
    report: vi.fn(),
    async *stream() {},
  };
  const fetchable = { feed, origin: feed.origins[0]! };
  const first = await refreshStreamOrigin(database, fetchable);
  expect(first.status).toBe("error");
  const origin = await database.select().from(feedOriginAtproto).get();
  expect(origin?.recoveryRetryAt?.getTime()).toBeGreaterThan(Date.now());
  // Recovery backoff still owns scheduling; the generic fetch schedule is untouched.
  expect(fetchable.origin.nextFetchAt).toBeNull();
  tip.mockClear();
  const second = await refreshStreamOrigin(database, fetchable);
  expect(second.status).toBe("error");
  expect(tip).not.toHaveBeenCalled();
});
