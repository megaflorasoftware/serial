import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { StreamEvent } from "~/server/jetstream/protocol";
import {
  createSkippedEvents,
  SKIPPED_EVENT_WINDOW_MS,
  startStreamIntake,
} from "~/server/jetstream/intake";
import { legacyResumeLeavesGap } from "~/server/jetstream/service";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import { feeds, user } from "~/server/db/schema";

vi.mock("~/env", () => ({
  env: {
    ATPROTO_JETSTREAM_ENDPOINT: "https://jetstream.example.com",
    BACKGROUND_REFRESH_ENABLED: true,
  },
}));
vi.mock("~/server/api/publisher", () => ({ publisher: { publish: vi.fn() } }));
vi.mock("~/server/logger", () => ({
  captureException: vi.fn(),
  logMessage: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}));

function account(seq: number, did: string): StreamEvent {
  return {
    seq,
    did,
    time: new Date(0).toISOString(),
    kind: "account",
    account: { active: true },
  };
}
const batch = (...events: StreamEvent[]) => ({
  events,
  lastCursor: events.at(-1)!.seq,
});

describe("skipped events", () => {
  it("returns a publisher's events in arrival order and keeps the rest", () => {
    const skipped = createSkippedEvents(0);
    skipped.add(account(1, "did:plc:a"), 1);
    skipped.add(account(2, "did:plc:b"), 2);
    skipped.add(account(3, "did:plc:a"), 3);
    expect(
      skipped.take(new Set(["did:plc:a"])).map((event) => event.seq),
    ).toEqual([1, 3]);
    expect(skipped.take(new Set(["did:plc:a"]))).toEqual([]);
    expect(
      skipped.take(new Set(["did:plc:b"])).map((event) => event.seq),
    ).toEqual([2]);
  });

  it("stops answering for an interval once an event inside it expired", () => {
    const skipped = createSkippedEvents(0, { windowMs: 100, budgetBytes: 1e6 });
    skipped.add(account(1, "did:plc:a"), 10);
    expect(skipped.covers(0, 100)).toBe(true);
    // Everything that arrived before 150 may be gone at 250.
    expect(skipped.covers(0, 250)).toBe(false);
    expect(skipped.covers(150, 250)).toBe(true);
    expect(skipped.take(new Set(["did:plc:a"]))).toEqual([]);
  });

  it("stops answering for an interval once the byte budget evicted an event inside it", () => {
    const size = Buffer.byteLength(JSON.stringify(account(1, "did:plc:a")));
    const skipped = createSkippedEvents(0, {
      windowMs: 1e6,
      budgetBytes: size * 2,
    });
    skipped.add(account(1, "did:plc:a"), 10);
    skipped.add(account(2, "did:plc:a"), 20);
    expect(skipped.covers(0, 20)).toBe(true);
    skipped.add(account(3, "did:plc:a"), 30);
    // The event from 10 was evicted; later arrivals are all still held.
    expect(skipped.covers(10, 30)).toBe(false);
    expect(skipped.covers(11, 30)).toBe(true);
    expect(
      skipped.take(new Set(["did:plc:a"])).map((event) => event.seq),
    ).toEqual([2, 3]);
  });
});

describe("legacy resume", () => {
  const legacy = "https://jetstream.example.com/subscribe";
  const now = Date.parse("2026-09-18T12:00:00Z");
  it("trusts a recent legacy time cursor and no older one", () => {
    expect(legacyResumeLeavesGap(legacy, (now - 60_000) * 1000, now)).toBe(
      false,
    );
    expect(
      legacyResumeLeavesGap(legacy, (now - 2 * 60 * 60 * 1000) * 1000, now),
    ).toBe(true);
  });
  it("leaves a sequence cursor to the service, which rejects one it cannot serve", () => {
    expect(legacyResumeLeavesGap("https://jetstream.example.com", 1, now)).toBe(
      false,
    );
  });
});

describe("stream intake", () => {
  let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
  let time: number;
  const apply = vi.fn<(events: StreamEvent[]) => Promise<void>>(async () => {});
  const distrust = vi.fn<(originIds: number[]) => Promise<void>>(
    async () => {},
  );
  const applied = () =>
    apply.mock.calls.map(([events]) => events.map((event) => event.seq));

  async function follow(did: string) {
    const feed = await insertFeedWithOrigins(fixture.database, {
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
    return { feedId: feed.id, originId: feed.origins[0]!.id };
  }
  const start = (limits?: { windowMs: number; budgetBytes: number }) =>
    startStreamIntake({
      database: fixture.database,
      apply,
      distrust,
      now: () => time,
      limits,
    });

  beforeEach(async () => {
    vi.clearAllMocks();
    time = 1_000_000;
    fixture = await createBookmarkTestDatabase();
    await fixture.database.insert(user).values({
      id: "reader",
      name: "Reader",
      email: "reader@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await follow("did:plc:followed");
  });
  afterEach(() => fixture.cleanup());

  it("applies events for followed publishers and skips everyone else", async () => {
    const intake = await start();
    await intake.accept(
      batch(account(2, "did:plc:stranger"), account(3, "did:plc:followed")),
    );
    await intake.accept(batch(account(4, "did:plc:stranger")));
    expect(applied()).toEqual([[3]]);
    expect(distrust).not.toHaveBeenCalled();
  });

  it("hands a publisher followed mid-stream the events it skipped, in order, before later ones", async () => {
    const intake = await start();
    const joined = await follow("did:plc:newcomer");
    await intake.accept(batch(account(2, "did:plc:newcomer")));
    await intake.accept(batch(account(3, "did:plc:stranger")));
    await intake.accept(batch(account(4, "did:plc:newcomer")));
    expect(applied()).toEqual([]);
    // A live event arriving while the refresh runs waits behind the replay.
    const refreshed = intake.refresh();
    const live = intake.accept(batch(account(5, "did:plc:newcomer")));
    await Promise.all([refreshed, live]);
    expect(applied()).toEqual([[2, 4], [5]]);
    expect(distrust).not.toHaveBeenCalled();
    expect(joined.originId).toBeGreaterThan(0);
  });

  it("needs no replay for another origin of a publisher it already follows", async () => {
    const intake = await start();
    await follow("did:plc:followed");
    await intake.refresh();
    expect(apply).not.toHaveBeenCalled();
    expect(distrust).not.toHaveBeenCalled();
  });

  it("distrusts an origin that joins after the byte budget evicted skipped events", async () => {
    const size = Buffer.byteLength(
      JSON.stringify(account(2, "did:plc:newcomer")),
    );
    const intake = await start({ windowMs: 1e9, budgetBytes: size });
    const joined = await follow("did:plc:newcomer");
    time += 10;
    await intake.accept(batch(account(2, "did:plc:newcomer")));
    time += 10;
    await intake.accept(batch(account(3, "did:plc:newcomer")));
    await intake.refresh();
    expect(distrust).toHaveBeenCalledExactlyOnceWith([joined.originId]);
    expect(apply).not.toHaveBeenCalled();
    // The publisher is followed from here on.
    await intake.accept(batch(account(4, "did:plc:newcomer")));
    expect(applied()).toEqual([[4]]);
  });

  it("distrusts an origin that joins after a refresh was overdue past the skipped window", async () => {
    const intake = await start();
    const joined = await follow("did:plc:newcomer");
    await intake.accept(batch(account(2, "did:plc:newcomer")));
    time += SKIPPED_EVENT_WINDOW_MS + 1;
    await intake.refresh();
    expect(distrust).toHaveBeenCalledExactlyOnceWith([joined.originId]);
    expect(apply).not.toHaveBeenCalled();
  });

  it("marks only the progress made before a refresh as safe to resume from", async () => {
    const intake = await start();
    expect(intake.checkpoint()).toBeUndefined();
    await intake.accept(batch(account(5, "did:plc:stranger")));
    // Accepting an event saves nothing: the checkpoint waits for a refresh.
    expect(intake.checkpoint()).toBeUndefined();
    await intake.refresh();
    expect(intake.checkpoint()).toBe(5);
    await intake.accept(batch(account(6, "did:plc:followed")));
    expect(intake.checkpoint()).toBe(5);
    await intake.refresh();
    expect(intake.checkpoint()).toBe(6);
  });

  it("keeps the earlier checkpoint when a replay fails", async () => {
    const intake = await start();
    await intake.accept(batch(account(5, "did:plc:stranger")));
    await intake.refresh();
    await follow("did:plc:newcomer");
    await intake.accept(batch(account(6, "did:plc:newcomer")));
    apply.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(intake.refresh()).rejects.toThrow("database unavailable");
    expect(intake.checkpoint()).toBe(5);
    // The lost events come back only by resuming before them, so no later
    // refresh may move the checkpoint past them.
    await intake.accept(batch(account(7, "did:plc:followed")));
    await expect(intake.refresh()).rejects.toThrow();
    expect(intake.checkpoint()).toBe(5);
  });

  it("distrusts a followed publisher's origins before progress passes a message that could not be read", async () => {
    const second = await follow("did:plc:followed");
    const intake = await start();
    await intake.accept(batch(account(2, "did:plc:followed")));
    intake.unreadable("did:plc:followed");
    intake.unreadable("did:plc:followed");
    expect(distrust).not.toHaveBeenCalled();
    await intake.accept(batch(account(4, "did:plc:stranger")));
    // Every origin of the publisher, in one write.
    expect(distrust).toHaveBeenCalledTimes(1);
    expect(distrust.mock.calls[0]![0]).toHaveLength(2);
    expect(distrust.mock.calls[0]![0]).toContain(second.originId);
    await intake.accept(batch(account(5, "did:plc:stranger")));
    expect(distrust).toHaveBeenCalledTimes(1);
  });

  it("holds its position at an unreadable message until the distrust lands, which a quiet stream's refresh does", async () => {
    const intake = await start();
    await intake.accept(batch(account(2, "did:plc:followed")));
    intake.unreadable("did:plc:followed");
    distrust.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      intake.accept(batch(account(4, "did:plc:stranger"))),
    ).rejects.toThrow("database unavailable");
    // No batch follows: the refresh distrusts, and resumes before the message.
    await intake.refresh();
    expect(distrust).toHaveBeenCalledTimes(2);
    expect(distrust.mock.calls[1]![0]).toHaveLength(1);
    expect(intake.checkpoint()).toBe(2);
  });

  it("does not vouch for an origin that joins around an unreadable message from a publisher nobody followed", async () => {
    const intake = await start();
    intake.unreadable("did:plc:stranger");
    time += 10;
    await intake.refresh();
    expect(distrust).not.toHaveBeenCalled();
    const joined = await follow("did:plc:newcomer");
    time += 10;
    intake.unreadable("did:plc:newcomer");
    time += 10;
    await intake.refresh();
    expect(distrust).toHaveBeenCalledExactlyOnceWith([joined.originId]);
    // The interval after that refresh holds every skipped event again.
    const later = await follow("did:plc:later");
    await intake.accept(batch(account(6, "did:plc:later")));
    await intake.refresh();
    expect(distrust).toHaveBeenCalledTimes(1);
    expect(applied()).toEqual([[6]]);
    expect(later.originId).toBeGreaterThan(joined.originId);
  });

  it("keeps a deleted origin's publisher followed until the next connection rebuilds the set", async () => {
    const gone = await follow("did:plc:gone");
    const intake = await start();
    await fixture.database.delete(feeds).where(eq(feeds.id, gone.feedId));
    await intake.refresh();
    await intake.accept(batch(account(2, "did:plc:gone")));
    expect(applied()).toEqual([[2]]);
    const next = await start();
    await next.accept(batch(account(3, "did:plc:gone")));
    expect(applied()).toEqual([[2]]);
  });
});
