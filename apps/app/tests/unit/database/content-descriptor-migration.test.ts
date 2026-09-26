import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

const MIGRATIONS_DIRECTORY = "src/server/db/migrations";
const POST_MIGRATIONS_DIRECTORY = "src/server/db/post-migrations";
const FEATURE_MIGRATION_TAG = "0047_violet_lady_ursula";

function statements(content: string) {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyJournalRange(
  client: ReturnType<typeof createClient>,
  entries: Array<{ idx: number; tag: string }>,
  from: number,
  through: number,
) {
  for (const entry of entries.filter(
    ({ idx }) => idx >= from && idx <= through,
  )) {
    for (const statement of statements(
      readFileSync(`${MIGRATIONS_DIRECTORY}/${entry.tag}.sql`, "utf8"),
    )) {
      await client.execute(statement);
    }
  }
}

describe("content descriptor migration", () => {
  const cleanupDirectories: string[] = [];

  afterEach(() => {
    for (const directory of cleanupDirectories.splice(0)) {
      rmSync(directory, { recursive: true });
    }
  });

  it("keeps one consolidated feature migration and one feed-item post-migration", () => {
    const migrationFiles = readdirSync(MIGRATIONS_DIRECTORY).filter((file) =>
      file.startsWith("0047_"),
    );
    expect(migrationFiles).toEqual([`${FEATURE_MIGRATION_TAG}.sql`]);
    const postFiles = readdirSync(
      `${POST_MIGRATIONS_DIRECTORY}/${FEATURE_MIGRATION_TAG}`,
    ).filter((file) => file.endsWith(".sql"));
    expect(postFiles).toEqual([
      "001_backfill_feed_item_content_descriptors.sql",
    ]);
    expect(
      statements(
        readFileSync(
          `${POST_MIGRATIONS_DIRECTORY}/${FEATURE_MIGRATION_TAG}/${postFiles[0]}`,
          "utf8",
        ),
      ),
    ).toHaveLength(2);
  });

  it("applies the complete migration and post-migration chain to a fresh database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "serial-fresh-migration-"));
    cleanupDirectories.push(directory);
    const client = createClient({ url: `file:${directory}/database.sqlite` });
    const journal = JSON.parse(
      readFileSync(`${MIGRATIONS_DIRECTORY}/meta/_journal.json`, "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };

    try {
      await applyJournalRange(client, journal.entries, 0, 47);
      for (const statement of statements(
        readFileSync(
          `${POST_MIGRATIONS_DIRECTORY}/${FEATURE_MIGRATION_TAG}/001_backfill_feed_item_content_descriptors.sql`,
          "utf8",
        ),
      )) {
        await client.execute(statement);
      }

      expect(
        (await client.execute("PRAGMA table_info(serial_views)")).rows.map(
          (row) => row.name,
        ),
      ).toContain("content_filter");
      expect(
        (await client.execute("PRAGMA table_info(serial_feed_item)")).rows.map(
          (row) => row.name,
        ),
      ).toContain("content_type");
      expect(
        (await client.execute("PRAGMA table_info(serial_bookmark)")).rows.map(
          (row) => row.name,
        ),
      ).toContain("classification_source");
    } finally {
      client.close();
    }
  });

  it("advances representative main data through the consolidated migration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "serial-migration-test-"));
    cleanupDirectories.push(directory);
    const client = createClient({ url: `file:${directory}/database.sqlite` });
    const journal = JSON.parse(
      readFileSync(`${MIGRATIONS_DIRECTORY}/meta/_journal.json`, "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };

    try {
      await applyJournalRange(client, journal.entries, 0, 46);

      const now = 1_700_000_000;
      await client.execute({
        sql: `INSERT INTO serial_user
          (id, name, email, email_verified, created_at, updated_at)
          VALUES ('legacy-user', 'Legacy User', 'legacy@example.com', 1, ?, ?)`,
        args: [now, now],
      });
      for (const [id, contentType] of [
        [1, "longform"],
        [2, "horizontal-video"],
        [3, "vertical-video"],
        [4, "all"],
      ] as const) {
        await client.execute({
          sql: `INSERT INTO serial_views
            (id, user_id, name, content_type, orientation, created_at, updated_at)
            VALUES (?, 'legacy-user', ?, ?, 'horizontal', ?, ?)`,
          args: [id, `View ${id}`, contentType, now, now],
        });
      }
      // The 0047 backfill predates the Atmosphere platforms; every non-website
      // Feed of that era was video, so the historical rule stays as written.
      for (const [id, platform] of [
        [1, "website"],
        [2, "youtube"],
        [3, "peertube"],
        [4, "nebula"],
      ] as const) {
        await client.execute({
          sql: `INSERT INTO serial_feed
            (id, user_id, name, url, platform, created_at, updated_at)
            VALUES (?, 'legacy-user', ?, ?, ?, ?, ?)`,
          args: [
            id,
            `Feed ${id}`,
            `https://feed${id}.example`,
            platform,
            now,
            now,
          ],
        });
        await client.execute({
          sql: `INSERT INTO serial_feed_item
            (id, feed_id, content_id, title, author, url, posted_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'Author', ?, ?, ?, ?)`,
          args: [
            `item-${id}`,
            id,
            `content-${id}`,
            `Item ${id}`,
            `https://feed${id}.example/item${id === 1 ? "#reader" : ""}`,
            now,
            now,
            now,
          ],
        });
      }

      await applyJournalRange(client, journal.entries, 47, 47);
      for (const statement of statements(
        readFileSync(
          `${POST_MIGRATIONS_DIRECTORY}/${FEATURE_MIGRATION_TAG}/001_backfill_feed_item_content_descriptors.sql`,
          "utf8",
        ),
      )) {
        await client.execute(statement);
      }

      expect(
        await client.execute(
          "SELECT id, content_filter FROM serial_views ORDER BY id",
        ),
      ).toMatchObject({
        rows: [
          { id: 1, content_filter: 3 },
          { id: 2, content_filter: 2 },
          { id: 3, content_filter: 4 },
          { id: 4, content_filter: 7 },
        ],
      });
      expect(
        await client.execute(
          "SELECT id, content_type FROM serial_feed_item ORDER BY id",
        ),
      ).toMatchObject({
        rows: [
          { id: "item-1", content_type: "text" },
          { id: "item-2", content_type: "video" },
          { id: "item-3", content_type: "video" },
          { id: "item-4", content_type: "video" },
        ],
      });
      expect(
        await client.execute(
          "SELECT id, normalized_url FROM serial_feed_item ORDER BY id",
        ),
      ).toMatchObject({
        rows: [
          { id: "item-1", normalized_url: "https://feed1.example/item" },
          { id: "item-2", normalized_url: null },
          { id: "item-3", normalized_url: null },
          { id: "item-4", normalized_url: null },
        ],
      });
      expect(
        (
          await client.execute("PRAGMA table_info(serial_page_capture)")
        ).rows.map((row) => row.name),
      ).toEqual([
        "bookmark_id",
        "content_html",
        "content_hash",
        "capture_source",
        "extractor_version",
        "sanitizer_policy_version",
        "captured_at",
      ]);
    } finally {
      client.close();
    }
  });
});
