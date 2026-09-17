// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { setMany } from "idb-keyval";
import { createNormalizedIDBStorage } from "~/lib/data/normalized-idb-storage";

const indexedDb = vi.hoisted(() => ({
  entries: new Map<IDBValidKey, unknown>(),
}));

function cloneStoredValue<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

vi.mock("idb-keyval", () => ({
  clear: vi.fn(() => Promise.resolve(indexedDb.entries.clear())),
  del: vi.fn((key: IDBValidKey) =>
    Promise.resolve(indexedDb.entries.delete(key)),
  ),
  delMany: vi.fn((keys: IDBValidKey[]) => {
    for (const key of keys) indexedDb.entries.delete(key);
    return Promise.resolve();
  }),
  get: vi.fn((key: IDBValidKey) =>
    Promise.resolve(cloneStoredValue(indexedDb.entries.get(key))),
  ),
  getMany: vi.fn((keys: IDBValidKey[]) =>
    Promise.resolve(
      keys.map((key) => cloneStoredValue(indexedDb.entries.get(key))),
    ),
  ),
  keys: vi.fn(() => Promise.resolve([...indexedDb.entries.keys()])),
  set: vi.fn((key: IDBValidKey, value: unknown) => {
    indexedDb.entries.set(key, cloneStoredValue(value));
    return Promise.resolve();
  }),
  setMany: vi.fn((entries: Array<[IDBValidKey, unknown]>) => {
    for (const [key, value] of entries) {
      indexedDb.entries.set(key, cloneStoredValue(value));
    }
    return Promise.resolve();
  }),
}));

afterEach(() => {
  indexedDb.entries.clear();
});

describe("normalized IndexedDB in-place record updates", () => {
  it("waits for a queued write to finish when explicitly flushed", async () => {
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    vi.mocked(setMany).mockImplementationOnce(async (entries) => {
      markWriteStarted();
      await writeBlocked;
      for (const [key, value] of entries) {
        indexedDb.entries.set(key, cloneStoredValue(value));
      }
    });
    const storage = createNormalizedIDBStorage<{
      records: Record<string, { id: string }>;
    }>({ recordFields: ["records"] });
    storage.setItem("awaited-flush", {
      state: { records: { first: { id: "first" } } },
    });

    let completed = false;
    const flush = storage.flushAndWait().then(() => {
      completed = true;
    });
    await writeStarted;
    expect(completed).toBe(false);

    releaseWrite();
    await flush;
    expect(await storage.getItem("awaited-flush")).toEqual({
      state: { records: { first: { id: "first" } } },
      version: undefined,
    });
  });

  it("rejects an explicit flush when persistence fails", async () => {
    const failure = new Error("write failed");
    vi.mocked(setMany).mockRejectedValueOnce(failure);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = createNormalizedIDBStorage<{
      records: Record<string, { id: string }>;
    }>({ recordFields: ["records"] });
    storage.setItem("failed-flush", {
      state: { records: { first: { id: "first" } } },
    });

    await expect(storage.flushAndWait()).rejects.toBe(failure);
    expect(warning).toHaveBeenCalledWith(
      "[normalized-idb-storage] write failed:",
      "failed-flush",
      failure,
    );
    warning.mockRestore();
  });

  it("projects a queued flush before its mutable source can change", async () => {
    type Cache = {
      records: Record<string, { id: string }>;
      retainedIds: string[];
    };
    const records = { first: { id: "first" } } as Cache["records"];
    const prepareWrite = vi.fn((state: Cache): Cache => ({
      records: Object.fromEntries(
        Object.entries(state.records).filter(([id]) =>
          state.retainedIds.includes(id),
        ),
      ),
      retainedIds: state.retainedIds,
    }));
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let markFirstWriteStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });
    vi.mocked(setMany).mockImplementationOnce(async (entries) => {
      markFirstWriteStarted();
      await firstWriteBlocked;
      for (const [key, value] of entries) {
        indexedDb.entries.set(key, cloneStoredValue(value));
      }
    });
    const storage = createNormalizedIDBStorage<Cache>({
      recordFields: ["records"],
      prepareWrite,
    });

    storage.setItem("queued-projection", {
      state: { records, retainedIds: ["first"] },
    });
    window.dispatchEvent(new Event("pagehide"));
    await firstWriteStarted;

    records.second = { id: "second" };
    storage.setItem("queued-projection", {
      state: { records, retainedIds: ["second"] },
    });
    window.dispatchEvent(new Event("pagehide"));
    expect(prepareWrite).toHaveBeenCalledTimes(2);

    delete records.second;
    releaseFirstWrite();
    await vi.waitFor(async () =>
      expect(await storage.getItem("queued-projection")).toEqual({
        state: {
          records: { second: { id: "second" } },
          retainedIds: ["second"],
        },
        version: undefined,
      }),
    );
  });

  it("projects only the latest pending state when flushing and cancels removed writes", async () => {
    type Cache = {
      records: Record<string, { id: string; archived: boolean }>;
    };
    const prepareWrite = vi.fn((state: Cache): Cache => ({
      records: Object.fromEntries(
        Object.entries(state.records).filter(([, item]) => !item.archived),
      ),
    }));
    const storage = createNormalizedIDBStorage<Cache>({
      recordFields: ["records"],
      prepareWrite,
    });
    storage.setItem("projected", {
      state: { records: { old: { id: "old", archived: false } } },
    });
    storage.setItem("projected", {
      state: {
        records: {
          latest: { id: "latest", archived: false },
          removed: { id: "removed", archived: true },
        },
      },
    });
    expect(prepareWrite).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() =>
      expect(indexedDb.entries.has("projected::normalized:v1::root")).toBe(
        true,
      ),
    );
    expect(prepareWrite).toHaveBeenCalledTimes(1);
    expect(await storage.getItem("projected")).toEqual({
      state: {
        records: { latest: { id: "latest", archived: false } },
      },
      version: undefined,
    });
    storage.setItem("projected", {
      state: {
        records: { canceled: { id: "canceled", archived: false } },
      },
    });
    await storage.removeItem("projected");
    window.dispatchEvent(new Event("pagehide"));
    expect(prepareWrite).toHaveBeenCalledTimes(1);
    expect(await storage.getItem("projected")).toBeNull();
  });

  it("persists a replaced entity from a stable dictionary", async () => {
    const records = { item: { id: "item", archived: false } };
    const storage = createNormalizedIDBStorage<{
      records: Record<string, { id: string; archived: boolean }>;
    }>({ recordFields: ["records"] });
    const recordKey =
      "test-store::normalized:v1::record:records:" + encodeURIComponent("item");

    storage.setItem("test-store", { state: { records } });
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() =>
      expect(indexedDb.entries.get(recordKey)).toEqual({
        id: "item",
        archived: false,
      }),
    );

    records.item = { id: "item", archived: true };
    storage.setItem("test-store", { state: { records } });
    window.dispatchEvent(new Event("pagehide"));

    await vi.waitFor(() =>
      expect(indexedDb.entries.get(recordKey)).toEqual({
        id: "item",
        archived: true,
      }),
    );
  });
});
