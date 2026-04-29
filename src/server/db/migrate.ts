import crypto from "node:crypto";
import fs from "node:fs";
import { config } from "dotenv";
import { sql } from "drizzle-orm";

// Load .env.local for local dev/build. In production the platform provides env
// vars directly; during e2e tests dotenv-cli injects them from .env.test.* files.
// Note: Nitro's Vite plugin auto-loads both .env AND .env.local in dev mode,
// so e2e test env files must explicitly empty-override any secrets from .env.local.
config({ path: ".env.local" });

// Dynamic import so env vars are loaded before env.js evaluates process.env
const { db } = await import("./index.js");
const { env } = await import("../../env.js");

const MIGRATIONS_FOLDER = "src/server/db/migrations";
const MIGRATIONS_TABLE = "__drizzle_migrations";
const CONNECT_TIMEOUT_MS = 30_000;

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    parsed.searchParams.delete("authToken");
    return parsed.toString();
  } catch {
    return url.slice(0, 30) + "…";
  }
}

function readJournal(): JournalEntry[] {
  const raw = fs.readFileSync(
    `${MIGRATIONS_FOLDER}/meta/_journal.json`,
    "utf-8",
  );
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

async function run() {
  const startTime = performance.now();

  console.log(`[migrate] target: ${maskUrl(env.DATABASE_URL)}`);

  // ── Connectivity check ──────────────────────────────────────────────
  console.log("[migrate] testing database connectivity…");
  const connectStart = performance.now();
  try {
    await Promise.race([
      db.run(sql`SELECT 1`),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`timed out after ${CONNECT_TIMEOUT_MS}ms`)),
          CONNECT_TIMEOUT_MS,
        ),
      ),
    ]);
    console.log(
      `[migrate] connected (${(performance.now() - connectStart).toFixed(0)}ms)`,
    );
  } catch (err) {
    console.error("[migrate] connectivity check failed:", err);
    process.exit(1);
  }

  // ── Ensure migrations table exists ──────────────────────────────────
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS ${sql.identifier(MIGRATIONS_TABLE)} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);

  // ── Determine pending migrations ────────────────────────────────────
  const journal = readJournal();

  let lastAppliedAt = 0;
  const rows = await db.values<[number, string, number]>(
    sql`SELECT id, hash, created_at FROM ${sql.identifier(MIGRATIONS_TABLE)} ORDER BY created_at DESC LIMIT 1`,
  );
  if (rows[0]) {
    lastAppliedAt = Number(rows[0][2]);
  }

  const applied =
    journal.length - journal.filter((e) => e.when > lastAppliedAt).length;
  const pending = journal.filter((entry) => entry.when > lastAppliedAt);

  if (pending.length === 0) {
    const totalMs = (performance.now() - startTime).toFixed(0);
    console.log(
      `[migrate] no pending migrations (${applied} already applied, ${totalMs}ms total)`,
    );
    return;
  }

  console.log(
    `[migrate] ${pending.length} pending migration(s) (${applied} already applied)`,
  );

  // ── Run each migration individually for per-migration progress ──────
  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i]!;
    const migrationStart = performance.now();
    const filePath = `${MIGRATIONS_FOLDER}/${entry.tag}.sql`;
    const content = fs.readFileSync(filePath, "utf-8");
    const statements = content
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    const hash = crypto.createHash("sha256").update(content).digest("hex");

    console.log(
      `[migrate]   [${i + 1}/${pending.length}] ${entry.tag} (${statements.length} statement(s))…`,
    );

    for (const stmt of statements) {
      await db.run(sql.raw(stmt));
    }

    await db.run(
      sql`INSERT INTO ${sql.identifier(MIGRATIONS_TABLE)} ("hash", "created_at") VALUES (${hash}, ${entry.when})`,
    );

    const migrationMs = (performance.now() - migrationStart).toFixed(0);
    console.log(
      `[migrate]   [${i + 1}/${pending.length}] ${entry.tag} done (${migrationMs}ms)`,
    );
  }

  const totalMs = (performance.now() - startTime).toFixed(0);
  console.log(
    `[migrate] done — ${pending.length} migration(s) applied (${totalMs}ms total)`,
  );
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[migrate] failed:", err);
    process.exit(1);
  });
