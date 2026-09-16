import type { FeedDatabase } from "~/server/feeds/origins";
import type {
  DatabaseAtprotoConnection,
  DatabaseSubscriptionMirror,
} from "~/server/db/schema";
import type { SubscriptionRecord } from "./record-store";
import { atprotoSubscriptionMirror as mirror } from "~/server/db/schema";

/** Record a complete remote observation, including records removed since the last one. */
export async function saveSubscriptionObservation(
  database: FeedDatabase,
  input: {
    connection: DatabaseAtprotoConnection;
    publicationUri: string;
    visibility: "public" | "private";
    previous: DatabaseSubscriptionMirror[];
    records: SubscriptionRecord[];
    feedId: number | null;
    imported: boolean;
    failure?: {
      state: "pending" | "skipped";
      retryAt: Date | null;
      attempts: number;
    };
  },
) {
  const { connection, publicationUri, records, previous } = input;
  const byUri = new Map(records.map((record) => [record.uri, record]));
  const uris = new Set([
    ...previous.map((row) => row.recordUri),
    ...byUri.keys(),
  ]);
  for (const recordUri of uris) {
    const record = byUri.get(recordUri);
    const values = {
      connectionId: connection.id,
      publicationUri,
      recordUri,
      recordCid: record?.cid ?? null,
      feedId: input.feedId,
      provenance:
        previous[0]?.provenance ??
        (input.imported ? ("imported" as const) : ("serial" as const)),
      visibility: input.visibility,
      remotePresent: !!record,
      importState: record ? (input.failure?.state ?? null) : null,
      importRetryAt: record ? (input.failure?.retryAt ?? null) : null,
      importFailures: record ? (input.failure?.attempts ?? 0) : 0,
      importGeneration: connection.subscriptionImportGeneration,
      exportGeneration: connection.subscriptionExportGeneration,
      updatedAt: new Date(),
    };
    // These writes share the caller's transaction and must remain serialized.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await database
      .insert(mirror)
      .values(values)
      .onConflictDoUpdate({
        target: [
          mirror.connectionId,
          mirror.publicationUri,
          mirror.recordUri,
          mirror.visibility,
        ],
        set: values,
      });
  }
}
