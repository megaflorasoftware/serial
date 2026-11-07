import { defineTask } from "nitro/task";
import { db } from "../../../src/server/db";
import {
  runPublicationSyncJobs,
  wakePublicationSyncJobs,
} from "../../../src/server/publication-sync/jobs";

export default defineTask({
  meta: {
    name: "publications:sync",
    description: "Resume requested publication sync and backfill",
  },
  async run() {
    if (await runPublicationSyncJobs(db)) wakePublicationSyncJobs(db);
    return { result: "started" };
  },
});
