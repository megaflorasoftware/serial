import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

const MIGRATIONS_DIRECTORY = "src/server/db/migrations";
const POST_MIGRATIONS_DIRECTORY = "src/server/db/post-migrations";
const FEATURE_TAG = "0049_publication_subscriptions";

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
    const migrationStatements = statements(
      readFileSync(`${MIGRATIONS_DIRECTORY}/${entry.tag}.sql`, "utf8"),
    );
    const postDirectory = `${POST_MIGRATIONS_DIRECTORY}/${entry.tag}`;
    if (options.withPostMigrations && existsSync(postDirectory)) {
      for (const file of readdirSync(postDirectory)
        .filter((file) => file.endsWith(".sql"))
        .sort()) {
        migrationStatements.push(
          ...statements(readFileSync(`${postDirectory}/${file}`, "utf8")),
        );
      }
    }
    // Match production's atomic schema + data transaction for each journal entry.
    await client.batch(migrationStatements, "write");
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

describe("publication subscriptions migration", () => {
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

  it("keeps one migration and final snapshot without separate backfills", () => {
    const journal = readJournal();
    expect(journal.entries.filter(({ idx }) => idx >= 49)).toEqual([
      expect.objectContaining({ idx: 49, tag: FEATURE_TAG }),
    ]);
    expect(
      readdirSync(POST_MIGRATIONS_DIRECTORY).filter(
        (name) => Number(name.slice(0, 4)) >= 49,
      ),
    ).toEqual([]);
    expect(
      readdirSync(`${MIGRATIONS_DIRECTORY}/meta`).filter((name) =>
        /^00(49|5[0-9]|6[01])_snapshot/.test(name),
      ),
    ).toEqual(["0049_snapshot.json"]);
    const snapshot = JSON.parse(
      readFileSync(`${MIGRATIONS_DIRECTORY}/meta/0049_snapshot.json`, "utf8"),
    ) as { prevId: string };
    const previous = JSON.parse(
      readFileSync(`${MIGRATIONS_DIRECTORY}/meta/0048_snapshot.json`, "utf8"),
    ) as { id: string };
    expect(snapshot.prevId).toBe(previous.id);
  });

  it("moves legacy fetch state onto one RSS origin per feed and drops the columns", async () => {
    const client = openFreshClient();
    const journal = readJournal();
    const createIndex = journal.entries.find(
      ({ tag }) => tag === FEATURE_TAG,
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
           'website', 'serial', ?, ?, NULL, NULL, 1, NULL, NULL),
          (4, 'legacy-user', '', '', '',
           'website', 'serial', ?, ?, NULL, NULL, 0, NULL, NULL)`,
        args: [now, now, now - 60, now + 3600, now, now, now, now, now, now],
      });

      await client.execute(`INSERT INTO serial_atproto_connections
        (id, user_id, did, created_at, updated_at)
        VALUES ('connection', 'legacy-user', 'did:plc:legacy', ${now}, ${now})`);
      for (const [id, feedId, content] of [
        ["body", 1, "<p>Article</p>"],
        ["empty", 1, ""],
        ["whitespace", 3, " "],
        ["video", 2, "Video description"],
      ] as const) {
        await client.execute({
          sql: `INSERT INTO serial_feed_item
            (id, feed_id, content_id, title, author, url, content, posted_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'Author', ?, ?, ?, ?, ?)`,
          args: [
            id,
            feedId,
            id,
            id,
            `https://example.com/${id}`,
            content,
            now,
            now,
            now,
          ],
        });
      }
      const beforeMigration = Math.floor(Date.now() / 1000);

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
      expect(origins).toHaveLength(4);
      expect(origins[0]).toMatchObject({
        feed_id: 1,
        user_id: "legacy-user",
        kind: "rss",
        locator: "https://example.com/a.xml",
        etag: null,
        last_modified_header: null,
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

      expect(origins[3]).toMatchObject({
        feed_id: 4,
        locator: "",
        source_name: "",
      });
      const legacyFeeds = (
        await client.execute(
          "SELECT id, name, name_edited_at, site_url, is_active, created_at, updated_at FROM serial_feed ORDER BY id",
        )
      ).rows;
      for (const feed of legacyFeeds.slice(0, 3)) {
        expect(Number(feed.name_edited_at)).toBeGreaterThanOrEqual(
          beforeMigration,
        );
        expect(Number(feed.name_edited_at)).toBeLessThanOrEqual(
          Math.floor(Date.now() / 1000),
        );
        expect(feed).toMatchObject({
          site_url: null,
          created_at: now,
          updated_at: now,
        });
      }
      expect(legacyFeeds[1]).toMatchObject({
        name: "Never fetched",
        is_active: 0,
      });
      expect(legacyFeeds[3]).toMatchObject({
        name: "",
        name_edited_at: null,
        is_active: 0,
      });
      expect(
        (
          await client.execute(
            "SELECT id, body_source, source_kind, atproto_uri, tags FROM serial_feed_item ORDER BY id",
          )
        ).rows,
      ).toEqual([
        {
          id: "body",
          body_source: "rss",
          source_kind: "rss",
          atproto_uri: null,
          tags: "[]",
        },
        {
          id: "empty",
          body_source: "none",
          source_kind: "rss",
          atproto_uri: null,
          tags: "[]",
        },
        {
          id: "video",
          body_source: "rss",
          source_kind: "rss",
          atproto_uri: null,
          tags: "[]",
        },
        {
          id: "whitespace",
          body_source: "rss",
          source_kind: "rss",
          atproto_uri: null,
          tags: "[]",
        },
      ]);
      expect(
        (
          await client.execute(
            "SELECT item_id, feed_id, page_url, image_url, next_check_at FROM serial_feed_item_page_image ORDER BY item_id",
          )
        ).rows,
      ).toEqual([
        {
          item_id: "body",
          feed_id: 1,
          page_url: "https://example.com/body",
          image_url: null,
          next_check_at: 0,
        },
        {
          item_id: "empty",
          feed_id: 1,
          page_url: "https://example.com/empty",
          image_url: null,
          next_check_at: 0,
        },
        {
          item_id: "whitespace",
          feed_id: 3,
          page_url: "https://example.com/whitespace",
          image_url: null,
          next_check_at: 0,
        },
      ]);
      expect(
        (
          await client.execute(
            "SELECT onboarding_complete, onboarding_step FROM serial_user",
          )
        ).rows,
      ).toEqual([{ onboarding_complete: 1, onboarding_step: null }]);
      expect(
        (
          await client.execute(
            "SELECT import_subscriptions, export_subscriptions, import_as_inactive, sync_settings_version, subscription_backfill_started FROM serial_atproto_connections",
          )
        ).rows,
      ).toEqual([
        {
          import_subscriptions: 0,
          export_subscriptions: 0,
          import_as_inactive: 0,
          sync_settings_version: 0,
          subscription_backfill_started: 0,
        },
      ]);
      // New accounts and Feeds retain their ordinary defaults after the upgrade.
      await client.execute(`INSERT INTO serial_user (id, name, email, email_verified, created_at, updated_at)
        VALUES ('new', 'New', 'new@example.com', 0, ${now}, ${now})`);
      expect(
        (
          await client.execute(
            "SELECT onboarding_complete, onboarding_step FROM serial_user WHERE id = 'new'",
          )
        ).rows,
      ).toEqual([{ onboarding_complete: 0, onboarding_step: null }]);
      await client.execute(`INSERT INTO serial_feed (user_id, name, platform, created_at, updated_at)
        VALUES ('new', 'New feed', 'website', ${now}, ${now})`);
      expect(
        (
          await client.execute(
            "SELECT name_edited_at FROM serial_feed WHERE user_id = 'new'",
          )
        ).rows,
      ).toEqual([{ name_edited_at: null }]);
      await client.execute(`INSERT INTO serial_atproto_subscription_mirror
        (connection_id, publication_uri, record_uri, feed_id, provenance, created_at, updated_at)
        VALUES ('connection', 'at://publication', 'at://subscription', 1, 'serial', ${now}, ${now})`);

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

      // Feed children cascade, while the mirror retains its deletion bookkeeping.
      await client.execute("DELETE FROM serial_feed WHERE id = 1");
      expect(
        (
          await client.execute(
            "SELECT count(*) AS value FROM serial_feed_origin WHERE feed_id = 1",
          )
        ).rows[0]?.value,
      ).toBe(0);
      expect(
        (
          await client.execute(
            "SELECT feed_id, import_state, import_retry_at, import_failures FROM serial_atproto_subscription_mirror",
          )
        ).rows,
      ).toEqual([
        {
          feed_id: 1,
          import_state: null,
          import_retry_at: null,
          import_failures: 0,
        },
      ]);
      expect(
        (
          await client.execute(
            "SELECT item_id FROM serial_feed_item_page_image WHERE feed_id = 1",
          )
        ).rows,
      ).toEqual([]);
      expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual(
        [],
      );
    } finally {
      client.close();
    }
  });

  it("rolls back schema and data together if the migration fails", async () => {
    const client = openFreshClient();
    try {
      await applyJournalRange(client, readJournal().entries, 0, 48, {
        withPostMigrations: true,
      });
      await client.execute(`INSERT INTO serial_user
        (id, name, email, email_verified, created_at, updated_at)
        VALUES ('legacy', 'Legacy', 'legacy@example.com', 0, 1, 1)`);
      const migration = statements(
        readFileSync(`${MIGRATIONS_DIRECTORY}/${FEATURE_TAG}.sql`, "utf8"),
      );
      await expect(
        client.batch(
          [...migration, "INSERT INTO missing_table VALUES (1)"],
          "write",
        ),
      ).rejects.toThrow("missing_table");
      expect(await columnNames(client, "serial_feed")).toContain("url");
      expect(await columnNames(client, "serial_user")).not.toContain(
        "onboarding_complete",
      );
      expect(await columnNames(client, "serial_feed_origin")).toEqual([]);
      await client.batch(migration, "write");
      expect(
        (await client.execute("SELECT onboarding_complete FROM serial_user"))
          .rows,
      ).toEqual([{ onboarding_complete: 1 }]);
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
