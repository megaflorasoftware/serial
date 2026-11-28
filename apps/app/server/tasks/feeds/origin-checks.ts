import { defineTask } from "nitro/task";
import { db } from "../../../src/server/db";
import { wakeFeedOriginChecks } from "../../../src/server/origin-checks/worker";

export default defineTask({
  meta: {
    name: "feeds:origin-checks",
    description: "Resume queued Feed origin checks",
  },
  run() {
    // The checks run in the background, one run per process at a time.
    wakeFeedOriginChecks(db);
    return { result: "started" };
  },
});
