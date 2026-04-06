import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";

import type { DatabaseFeed } from "~/server/db/schema";
import { fetchAndInsertFeedData } from "~/server/rss/fetchFeeds";

// Mock modules that require env vars
vi.mock("~/server/logger", () => ({
  logMessage: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("~/lib/semaphore", () => ({
  dbSemaphore: { run: <T>(fn: () => T) => fn() },
}));

const FIRESHIP_OLD_XML = readFileSync(
  resolvePath(__dirname, "../../e2e/fixtures/fireship-old.xml"),
  "utf-8",
);
const FIRESHIP_XML = readFileSync(
  resolvePath(__dirname, "../../e2e/fixtures/fireship.xml"),
  "utf-8",
);

const ETAG_V1 = '"fireship-integration-v1"';
const ETAG_V2 = '"fireship-integration-v2"';
const LAST_MODIFIED_V1 = "Sat, 05 Apr 2026 18:00:00 GMT";
const LAST_MODIFIED_V2 = "Sun, 06 Apr 2026 18:00:00 GMT";

let currentContent = FIRESHIP_OLD_XML;
let currentEtag = ETAG_V1;
let currentLastModified = LAST_MODIFIED_V1;

let server: Server;
let baseUrl: string;

function setServerContent(version: "v1" | "v2") {
  if (version === "v1") {
    currentContent = FIRESHIP_OLD_XML;
    currentEtag = ETAG_V1;
    currentLastModified = LAST_MODIFIED_V1;
  } else {
    currentContent = FIRESHIP_XML;
    currentEtag = ETAG_V2;
    currentLastModified = LAST_MODIFIED_V2;
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const ifNoneMatch = req.headers["if-none-match"];
    const ifModifiedSince = req.headers["if-modified-since"];

    if (
      ifNoneMatch === currentEtag ||
      ifModifiedSince === currentLastModified
    ) {
      res.writeHead(304, {
        ETag: currentEtag,
        "Last-Modified": currentLastModified,
      });
      res.end();
      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/atom+xml",
      ETag: currentEtag,
      "Last-Modified": currentLastModified,
    });
    res.end(currentContent);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

function makeFeed(overrides?: Partial<DatabaseFeed>): DatabaseFeed {
  return {
    id: 1,
    userId: "user-1",
    name: "Fireship",
    url: `${baseUrl}/feed`,
    imageUrl: "",
    platform: "youtube",
    openLocation: "serial",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastFetchedAt: null,
    nextFetchAt: null,
    isActive: true,
    etag: null,
    lastModifiedHeader: null,
    ...overrides,
  };
}

function createMockDb() {
  const updateSetCalls: unknown[] = [];
  const insertValuesCalls: unknown[] = [];

  const updateChain = {
    set: vi.fn((val: unknown) => {
      updateSetCalls.push(val);
      return updateChain;
    }),
    where: vi.fn(() => updateChain),
  };

  const insertChain = {
    values: vi.fn((val: unknown) => {
      insertValuesCalls.push(val);
      return insertChain;
    }),
    onConflictDoUpdate: vi.fn(() => insertChain),
    returning: vi.fn(() => []),
  };

  return {
    db: {
      update: vi.fn(() => updateChain),
      insert: vi.fn(() => insertChain),
    },
    updateSetCalls,
    insertValuesCalls,
  };
}

describe("fetchAndInsertFeedData with real RSS server", () => {
  it("inserts feed items on first fetch and stores etag/lastModified", async () => {
    setServerContent("v1");
    const feed = makeFeed();
    const { db, updateSetCalls, insertValuesCalls } = createMockDb();

    const results: Array<{ status: string }> = [];
    for await (const result of fetchAndInsertFeedData({ db: db as any }, [
      feed,
    ])) {
      results.push(result);
    }

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("success");
    expect(db.insert).toHaveBeenCalled();
    expect(insertValuesCalls.length).toBeGreaterThan(0);

    const feedUpdate = updateSetCalls[0] as Record<string, unknown>;
    expect(feedUpdate.etag).toBe(ETAG_V1);
    expect(feedUpdate.lastModifiedHeader).toBe(LAST_MODIFIED_V1);
  });

  it("skips insert on second fetch when etag matches (304)", async () => {
    setServerContent("v1");
    const feed = makeFeed({ etag: ETAG_V1 });
    const { db, insertValuesCalls, updateSetCalls } = createMockDb();

    const results: Array<{ status: string }> = [];
    for await (const result of fetchAndInsertFeedData({ db: db as any }, [
      feed,
    ])) {
      results.push(result);
    }

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("skipped");
    expect(db.insert).not.toHaveBeenCalled();
    expect(insertValuesCalls).toHaveLength(0);

    const feedUpdate = updateSetCalls[0] as Record<string, unknown>;
    expect(feedUpdate).toHaveProperty("lastFetchedAt");
    expect(feedUpdate).toHaveProperty("nextFetchAt");
    expect(feedUpdate).not.toHaveProperty("etag");
    expect(feedUpdate).not.toHaveProperty("lastModifiedHeader");
  });

  it("skips insert on second fetch when Last-Modified matches (304)", async () => {
    setServerContent("v1");
    const feed = makeFeed({ lastModifiedHeader: LAST_MODIFIED_V1 });
    const { db, insertValuesCalls } = createMockDb();

    const results: Array<{ status: string }> = [];
    for await (const result of fetchAndInsertFeedData({ db: db as any }, [
      feed,
    ])) {
      results.push(result);
    }

    expect(results[0]!.status).toBe("skipped");
    expect(db.insert).not.toHaveBeenCalled();
    expect(insertValuesCalls).toHaveLength(0);
  });

  it("full lifecycle: first fetch inserts, second fetch skips", async () => {
    setServerContent("v1");
    const feed = makeFeed();
    const { db: db1, updateSetCalls: updates1 } = createMockDb();

    for await (const result of fetchAndInsertFeedData({ db: db1 as any }, [
      feed,
    ])) {
      expect(result.status).toBe("success");
    }

    const firstUpdate = updates1[0] as Record<string, unknown>;
    expect(firstUpdate.etag).toBe(ETAG_V1);

    // Second fetch with cached etag → 304
    const cachedFeed = makeFeed({ etag: firstUpdate.etag as string });
    const { db: db2 } = createMockDb();

    for await (const result of fetchAndInsertFeedData({ db: db2 as any }, [
      cachedFeed,
    ])) {
      expect(result.status).toBe("skipped");
    }

    expect(db2.insert).not.toHaveBeenCalled();
  });

  it("re-fetches when stale etag does not match", async () => {
    setServerContent("v1");
    const feed = makeFeed({ etag: '"outdated-etag"' });
    const { db } = createMockDb();

    const results: Array<{ status: string }> = [];
    for await (const result of fetchAndInsertFeedData({ db: db as any }, [
      feed,
    ])) {
      results.push(result);
    }

    expect(results[0]!.status).toBe("success");
    expect(db.insert).toHaveBeenCalled();
  });
});

describe("fetchAndInsertFeedData with content update", () => {
  it("inserts new items when feed content updates (ETag changes)", async () => {
    // First fetch with old content
    setServerContent("v1");
    const feed = makeFeed();
    const {
      db: db1,
      updateSetCalls: updates1,
      insertValuesCalls: inserts1,
    } = createMockDb();

    for await (const result of fetchAndInsertFeedData({ db: db1 as any }, [
      feed,
    ])) {
      expect(result.status).toBe("success");
    }

    // Should have inserted 14 items (old content)
    expect(inserts1).toHaveLength(1);
    expect((inserts1[0] as unknown[]).length).toBe(14);
    const firstUpdate = updates1[0] as Record<string, unknown>;
    expect(firstUpdate.etag).toBe(ETAG_V1);

    // Second fetch with cached v1 etag → 304, no insert
    const cachedFeed = makeFeed({ etag: ETAG_V1 });
    const { db: db2 } = createMockDb();

    for await (const result of fetchAndInsertFeedData({ db: db2 as any }, [
      cachedFeed,
    ])) {
      expect(result.status).toBe("skipped");
    }
    expect(db2.insert).not.toHaveBeenCalled();

    // Server publishes a new video
    setServerContent("v2");

    // Third fetch — old etag no longer matches → 200, full insert
    const {
      db: db3,
      updateSetCalls: updates3,
      insertValuesCalls: inserts3,
    } = createMockDb();

    for await (const result of fetchAndInsertFeedData({ db: db3 as any }, [
      cachedFeed,
    ])) {
      expect(result.status).toBe("success");
    }

    // Should have inserted 15 items (new content)
    expect(db3.insert).toHaveBeenCalled();
    expect(inserts3).toHaveLength(1);
    expect((inserts3[0] as unknown[]).length).toBe(15);

    // Should store updated etag
    const thirdUpdate = updates3[0] as Record<string, unknown>;
    expect(thirdUpdate.etag).toBe(ETAG_V2);
    expect(thirdUpdate.lastModifiedHeader).toBe(LAST_MODIFIED_V2);
  });

  it("caches again after fetching updated content", async () => {
    // Fetch old content
    setServerContent("v1");
    const { db: db1 } = createMockDb();
    // eslint-disable-next-line no-unused-vars
    for await (const _result of fetchAndInsertFeedData({ db: db1 as any }, [
      makeFeed(),
    ])) {
      // drain
    }

    // Server updates
    setServerContent("v2");

    // Fetch new content with stale etag
    const { db: db2, updateSetCalls: updates2 } = createMockDb();
    for await (const result of fetchAndInsertFeedData({ db: db2 as any }, [
      makeFeed({ etag: ETAG_V1 }),
    ])) {
      expect(result.status).toBe("success");
    }
    const update = updates2[0] as Record<string, unknown>;
    expect(update.etag).toBe(ETAG_V2);

    // Now cache with new etag → 304
    const { db: db3 } = createMockDb();
    for await (const result of fetchAndInsertFeedData({ db: db3 as any }, [
      makeFeed({ etag: ETAG_V2 }),
    ])) {
      expect(result.status).toBe("skipped");
    }
    expect(db3.insert).not.toHaveBeenCalled();
  });
});
