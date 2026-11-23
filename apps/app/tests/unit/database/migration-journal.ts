import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Client } from "@libsql/client";

export const MIGRATIONS_DIRECTORY = "src/server/db/migrations";
export const POST_MIGRATIONS_DIRECTORY = "src/server/db/post-migrations";
export const FEATURE_TAG = "0049_publication_subscriptions";

export type Journal = { entries: Array<{ idx: number; tag: string }> };

export function statements(content: string) {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export function readJournal(): Journal {
  return JSON.parse(
    readFileSync(`${MIGRATIONS_DIRECTORY}/meta/_journal.json`, "utf8"),
  ) as Journal;
}

/** The journal index of the publication subscriptions migration. */
export function featureIndex(journal: Journal) {
  const entry = journal.entries.find(({ tag }) => tag === FEATURE_TAG);
  if (!entry) throw new Error(`Migration ${FEATURE_TAG} is not in the journal`);
  return entry.idx;
}

export async function applyJournalRange(
  client: Client,
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
