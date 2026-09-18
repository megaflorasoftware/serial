import { definePlugin } from "nitro";
import { db } from "../../src/server/db";
import { startStreamWorker } from "../../src/server/jetstream/service";
import { captureException } from "../../src/server/logger";

export default definePlugin((app) => {
  const shutdown = new AbortController();
  const work = startStreamWorker(db, shutdown.signal).catch(() => {
    if (!shutdown.signal.aborted)
      captureException(new Error("Jetstream worker stopped"), {
        operation: "worker",
      });
  });
  app.hooks.hook("close", async () => {
    shutdown.abort();
    await work;
  });
});
