import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { loadingMachine } from "~/lib/data/loading-machine";

describe("publication sync progress", () => {
  it("uses importing mode, ignores other runs and RSS completion, and finishes on its own response", () => {
    const actor = createActor(loadingMachine).start();
    actor.send({ type: "PUBLICATION_SYNC_START", runId: "ours" });
    actor.send({
      type: "PUBLICATION_SYNC_PROGRESS",
      runId: "ours",
      total: 3,
      completed: 1,
    });
    actor.send({
      type: "PUBLICATION_SYNC_PROGRESS",
      runId: "other",
      total: 100,
      completed: 99,
    });
    actor.send({ type: "FEED_STATUS_BATCH", count: 10 });
    actor.send({ type: "BACKGROUND_REFRESH_COMPLETE" });
    actor.send({ type: "PUBLICATION_SYNC_COMPLETE", runId: "other" });
    expect(actor.getSnapshot().matches("importing")).toBe(true);
    expect(actor.getSnapshot().context).toMatchObject({
      totalFeeds: 3,
      completedFeeds: 1,
    });
    actor.send({ type: "PUBLICATION_SYNC_COMPLETE", runId: "ours" });
    expect(actor.getSnapshot().matches("idle")).toBe(true);
    actor.stop();
  });
});
