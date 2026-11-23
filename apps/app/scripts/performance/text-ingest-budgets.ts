import type { Client } from "@libsql/client";
import type { InstrumentationSnapshot } from "./database";
import type { TextIngestOperation } from "./text-ingest-workload";

/**
 * Structural budgets shared by the deterministic bounds test and the benchmark
 * runner. An unchanged feed costs the narrow read of what is stored whatever
 * its size; only the items a feed states differently are read in full and
 * written.
 */
export function textIngestBudget(
  operation: TextIngestOperation,
  items: number,
  changed: number,
) {
  // One row per item and stated URL, then one per item and observation.
  const narrowRows = items * 2;
  return {
    // The two narrow statements and nothing else.
    unchanged: {
      statements: 2,
      rows: narrowRows,
      writes: 0,
      readsBodies: false,
    },
    // The narrow read, the changed items in full, the reread under the lock,
    // then one statement each for items and observations.
    changed: {
      statements: 9,
      rows: narrowRows + changed * 6,
      writes: 2,
      readsBodies: true,
    },
  }[operation];
}

type Statements = Pick<InstrumentationSnapshot, "statements">;

const WRITE = /^(insert into|update|delete from) /i;
/** The item's body and the observation's value. */
const BODY_COLUMN = /"serial_feed_item"\."content"|"content",|"value"/;

export function writeStatements({ statements }: Statements) {
  return statements.filter((entry) => WRITE.test(entry.sql));
}

export function bodyReads({ statements }: Statements) {
  return statements.filter((entry) => BODY_COLUMN.test(entry.sql));
}

/** Where a measured run left its budget, by name; empty when it stayed inside. */
export function textIngestOverruns(
  budget: ReturnType<typeof textIngestBudget>,
  evidence: InstrumentationSnapshot,
) {
  return [
    evidence.statementCount > budget.statements ? "statements" : null,
    evidence.materializedRows > budget.rows ? "rows" : null,
    writeStatements(evidence).length === budget.writes ? null : "writes",
    bodyReads(evidence).length > 0 === budget.readsBodies ? null : "bodies",
  ].filter((name) => name !== null);
}

/**
 * The hash the previous ingest left on an item, read only where no origin has
 * observed it. It is the one column behind the body an unchanged fetch may
 * read from an item's row.
 */
const UNOBSERVED_ITEM_HASH =
  /case when "serial_feed_item_observation"\."item_id" is null then "serial_feed_item"\."content_hash" end/;

/**
 * The item columns stored behind the body that a statement reads from the
 * item's row for an item some origin observed. SQLite reaches such a column
 * only by walking the body's overflow pages; a column an index serves costs
 * nothing of the kind, and its program reads it from the index.
 */
export async function readsBehindItemBody(client: Client, sql: string) {
  const [layout, table, explained] = await Promise.all([
    client.execute("PRAGMA table_info(serial_feed_item)"),
    client.execute(
      "SELECT rootpage FROM sqlite_master WHERE name = 'serial_feed_item'",
    ),
    client.execute({
      sql: `EXPLAIN ${sql}`,
      args: Array.from(sql.matchAll(/\?/g), () => "lookup"),
    }),
  ]);
  const columns = layout.rows;
  const program = explained.rows;
  const body = Number(columns.find((column) => column.name === "content")?.cid);
  const itemCursors = new Set(
    program
      .filter(
        (step) =>
          step.opcode === "OpenRead" &&
          Number(step.p2) === Number(table.rows[0]?.rootpage),
      )
      .map((step) => Number(step.p1)),
  );
  const guardsHash =
    !sql.replace(UNOBSERVED_ITEM_HASH, "").includes('"content_hash"') &&
    UNOBSERVED_ITEM_HASH.test(sql);
  return program
    .filter(
      (step) =>
        step.opcode === "Column" &&
        itemCursors.has(Number(step.p1)) &&
        Number(step.p2) > body,
    )
    .map((step) => String(columns[Number(step.p2)]?.name))
    .filter((name) => !(name === "content_hash" && guardsHash));
}
