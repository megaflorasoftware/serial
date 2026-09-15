import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

const MIGRATIONS_DIRECTORY = "src/server/db/migrations";
const POST_MIGRATIONS_DIRECTORY = "src/server/db/post-migrations";
const CREATE_ORIGINS_TAG = "0049_dapper_miss_america";
const DROP_COLUMNS_TAG = "0050_unknown_vampiro";
const BACKFILL_FILE = "001_backfill_rss_feed_origins.sql";

type Journal = { entries: Array<{ idx: number; tag: string }> };

function statements(content: string) {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function readJournal(): Journal {
  return JSON.parse(
    readFileSync(`${MIGRATIONS_DIRECTORY}/meta/_journal.json`, "utf8"),
  ) as Journal;
}

async function applyJournalRange(
  client: ReturnType<typeof createClient>,
  entries: Journal["entries"],
  from: number,
  through: number,
  options: { withPostMigrations: boolean },
) {
  for (const entry of entries.filter(
    ({ idx }) => idx >= from && idx <= through,
  )) {
    for (const statement of statements(
      readFileSync(`${MIGRATIONS_DIRECTORY}/${entry.tag}.sql`, "utf8"),
    )) {
      await client.execute(statement);
    }
    if (!options.withPostMigrations) continue;
    let postFiles: string[];
    try {
      postFiles = readdirSync(`${POST_MIGRATIONS_DIRECTORY}/${entry.tag}`)
        .filter((file) => file.endsWith(".sql"))
        .sort();
    } catch {
      continue;
    }
    for (const file of postFiles) {
      for (const statement of statements(
        readFileSync(
          `${POST_MIGRATIONS_DIRECTORY}/${entry.tag}/${file}`,
          "utf8",
        ),
      )) {
        await client.execute(statement);
      }
    }
  }
}

async function columnNames(
  client: ReturnType<typeof createClient>,
  table: string,
) {
  return (await client.execute(`PRAGMA table_info(${table})`)).rows.map(
    (row) => row.name,
  );
}

describe("feed origins migration", () => {
  const cleanupDirectories: string[] = [];

  afterEach(() => {
    for (const directory of cleanupDirectories.splice(0)) {
      rmSync(directory, { recursive: true });
    }
  });

  function openFreshClient() {
    const directory = mkdtempSync(join(tmpdir(), "serial-feed-origins-"));
    cleanupDirectories.push(directory);
    return createClient({ url: `file:${directory}/database.sqlite` });
  }

  it("keeps the backfill on the create migration and the drop in a second file", () => {
    const journal = readJournal();
    const tags = journal.entries.map(({ tag }) => tag);
    expect(tags.indexOf(DROP_COLUMNS_TAG)).toBe(
      tags.indexOf(CREATE_ORIGINS_TAG) + 1,
    );
    expect(
      readdirSync(`${POST_MIGRATIONS_DIRECTORY}/${CREATE_ORIGINS_TAG}`).filter(
        (file) => file.endsWith(".sql"),
      ),
    ).toEqual([BACKFILL_FILE]);
    expect(() =>
      readdirSync(`${POST_MIGRATIONS_DIRECTORY}/${DROP_COLUMNS_TAG}`),
    ).toThrow();
  });

  it("moves legacy fetch state onto one RSS origin per feed and drops the columns", async () => {
    const client = openFreshClient();
    const journal = readJournal();
    const createIndex = journal.entries.find(
      ({ tag }) => tag === CREATE_ORIGINS_TAG,
    )!.idx;

    try {
      await applyJournalRange(client, journal.entries, 0, createIndex - 1, {
        withPostMigrations: true,
      });

      const now = 1_700_000_000;
      await client.execute({
        sql: `INSERT INTO serial_user
          (id, name, email, email_verified, created_at, updated_at)
          VALUES ('legacy-user', 'Legacy User', 'legacy@example.com', 1, ?, ?)`,
        args: [now, now],
      });
      await client.execute({
        sql: `INSERT INTO serial_feed
          (id, user_id, name, url, image_url, platform, open_location,
           created_at, updated_at, last_fetched_at, next_fetch_at, is_active,
           etag, last_modified_header)
          VALUES
          (1, 'legacy-user', 'Fetched', 'https://example.com/a.xml', 'https://example.com/a.png',
           'website', 'serial', ?, ?, ?, ?, 1, '"etag-a"', 'Mon, 01 Jan 2024 00:00:00 GMT'),
          (2, 'legacy-user', 'Never fetched', 'https://example.com/b.xml', '',
           'youtube', 'serial', ?, ?, NULL, NULL, 0, NULL, NULL),
          (3, 'legacy-user', 'Duplicate', 'https://example.com/a.xml', '',
           'website', 'serial', ?, ?, NULL, NULL, 1, NULL, NULL)`,
        args: [now, now, now - 60, now + 3600, now, now, now, now],
      });

      await applyJournalRange(
        client,
        journal.entries,
        createIndex,
        createIndex,
        {
          withPostMigrations: true,
        },
      );

      const origins = (
        await client.execute(
          `SELECT feed_id, user_id, kind, locator, etag, last_modified_header,
                  last_fetched_at, next_fetch_at, source_name, source_image_url
           FROM serial_feed_origin ORDER BY feed_id`,
        )
      ).rows;
      expect(origins).toHaveLength(3);
      expect(origins[0]).toMatchObject({
        feed_id: 1,
        user_id: "legacy-user",
        kind: "rss",
        locator: "https://example.com/a.xml",
        etag: '"etag-a"',
        last_modified_header: "Mon, 01 Jan 2024 00:00:00 GMT",
        last_fetched_at: now - 60,
        next_fetch_at: now + 3600,
        source_name: "Fetched",
        source_image_url: "https://example.com/a.png",
      });
      expect(origins[1]).toMatchObject({
        feed_id: 2,
        kind: "rss",
        locator: "https://example.com/b.xml",
        etag: null,
        last_fetched_at: null,
        next_fetch_at: null,
      });
      // Legacy duplicate URLs per user survive the backfill untouched.
      expect(origins[2]).toMatchObject({
        feed_id: 3,
        locator: "https://example.com/a.xml",
      });

      // Re-running the backfill is idempotent.
      for (const statement of statements(
        readFileSync(
          `${POST_MIGRATIONS_DIRECTORY}/${CREATE_ORIGINS_TAG}/${BACKFILL_FILE}`,
          "utf8",
        ),
      )) {
        await client.execute(statement);
      }
      expect(
        (
          await client.execute(
            "SELECT count(*) AS value FROM serial_feed_origin",
          )
        ).rows[0]?.value,
      ).toBe(3);

      const feedColumnsBeforeDrop = await columnNames(client, "serial_feed");
      expect(feedColumnsBeforeDrop).toContain("url");
      expect(feedColumnsBeforeDrop).toContain("site_url");
      expect(feedColumnsBeforeDrop).toContain("name_edited_at");

      await applyJournalRange(
        client,
        journal.entries,
        createIndex + 1,
        journal.entries.at(-1)!.idx,
        { withPostMigrations: true },
      );

      const feedColumns = await columnNames(client, "serial_feed");
      for (const dropped of [
        "url",
        "etag",
        "last_modified_header",
        "last_fetched_at",
        "next_fetch_at",
      ]) {
        expect(feedColumns).not.toContain(dropped);
      }
      expect(feedColumns).toContain("is_active");

      // Deleting a Feed removes its origins.
      await client.execute("DELETE FROM serial_feed WHERE id = 1");
      expect(
        (
          await client.execute(
            "SELECT count(*) AS value FROM serial_feed_origin WHERE feed_id = 1",
          )
        ).rows[0]?.value,
      ).toBe(0);
    } finally {
      client.close();
    }
  });

  it("applies the complete chain to a fresh database", async () => {
    const client = openFreshClient();
    const journal = readJournal();
    try {
      await applyJournalRange(
        client,
        journal.entries,
        0,
        journal.entries.at(-1)!.idx,
        { withPostMigrations: true },
      );
      expect(await columnNames(client, "serial_feed_origin")).toEqual(
        expect.arrayContaining(["feed_id", "kind", "locator", "next_fetch_at"]),
      );
      const indexes = (
        await client.execute("PRAGMA index_list(serial_feed_origin)")
      ).rows.map((row) => row.name);
      expect(indexes).toEqual(
        expect.arrayContaining([
          "feed_origin_feed_id_kind_unique",
          "feed_origin_user_id_kind_locator_idx",
          "feed_origin_user_id_next_fetch_at_idx",
        ]),
      );
    } finally {
      client.close();
    }
  });
});
