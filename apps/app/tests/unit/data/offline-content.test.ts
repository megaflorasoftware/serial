import { describe, expect, it } from "vitest";
import type { ApplicationFeedItem } from "~/server/db/schema";
import {
  canOpenContent,
  canOpenOfflineContent,
  retainEligibleFeedBody,
  stripIneligibleFeedBodyForPersistence,
} from "~/lib/data/offline-content";
import { canMutate } from "~/lib/data/offline-mutations";

function archivedTextItem() {
  return {
    id: "item-1",
    contentType: "text",
    isWatched: true,
    body: { form: "html", html: "<p>Archived body</p>", revision: "hash-1" },
    contentSnippet: "Archived",
    contentHash: "hash-1",
  } as unknown as ApplicationFeedItem;
}

function archivedSourceItem() {
  return {
    ...archivedTextItem(),
    body: {
      form: "source",
      source: {
        uri: "at://did:plc:alice/site.standard.document/post",
        cid: "bafy",
        record: "{}",
        blobs: [],
      },
      references: [],
      revision: "bafy",
    },
  } as unknown as ApplicationFeedItem;
}

describe("archived body handling", () => {
  it("keeps an archived body in the live store for online reading", () => {
    const item = archivedTextItem();

    expect(retainEligibleFeedBody(undefined, item)).toBe(item);
  });

  it("strips an archived body from the persisted snapshot", () => {
    const item = archivedTextItem();

    const persisted = stripIneligibleFeedBodyForPersistence(item);

    expect(persisted.body).toBeNull();
    expect(persisted.contentSnippet).toBe("Archived");
    expect(item.body).not.toBeNull();
    // Stable identity across flushes so the normalized IDB diff sees no
    // change without a real update.
    expect(stripIneligibleFeedBodyForPersistence(item)).toBe(persisted);
  });

  it("strips an archived Document source from the persisted snapshot", () => {
    const item = archivedSourceItem();

    expect(stripIneligibleFeedBodyForPersistence(item).body).toBeNull();
  });

  it("passes through items whose body is already eligible or unloaded", () => {
    const eligible = { ...archivedTextItem(), isWatched: false };
    const eligibleSource = { ...archivedSourceItem(), isWatched: false };
    const unloaded = { ...archivedTextItem(), body: null };

    expect(stripIneligibleFeedBodyForPersistence(eligible)).toBe(eligible);
    expect(stripIneligibleFeedBodyForPersistence(eligibleSource)).toBe(
      eligibleSource,
    );
    expect(stripIneligibleFeedBodyForPersistence(unloaded)).toBe(unloaded);
  });
});

describe("offline content capability", () => {
  it("opens normal destinations until disconnection is established", () => {
    expect(
      canOpenContent({
        connectionState: "unknown",
        contentType: "video",
        hasBody: false,
      }),
    ).toBe(true);
    expect(
      canOpenContent({
        connectionState: "connected",
        contentType: "text",
        hasBody: false,
      }),
    ).toBe(true);
  });

  it("opens only retained text while disconnected", () => {
    expect(canOpenOfflineContent({ contentType: "text", hasBody: true })).toBe(
      true,
    );
    expect(
      canOpenContent({
        connectionState: "disconnected",
        contentType: "text",
        hasBody: false,
      }),
    ).toBe(false);
    expect(
      canOpenContent({
        connectionState: "disconnected",
        contentType: "video",
        hasBody: true,
      }),
    ).toBe(false);
  });
});

describe("offline mutation gate", () => {
  it("blocks mutations only after disconnection is established", () => {
    expect(canMutate("unknown")).toBe(true);
    expect(canMutate("connected")).toBe(true);
    expect(canMutate("disconnected")).toBe(false);
  });
});
