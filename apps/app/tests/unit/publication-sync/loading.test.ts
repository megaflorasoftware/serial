import { createActor } from "xstate";
import { expect, it } from "vitest";
import { loadingMachine } from "~/lib/data/loading-machine";

it("keeps another tab's refresh progress out of an ordinary Feed import", () => {
  const actor = createActor(loadingMachine).start();
  actor.send({ type: "IMPORT_START", totalFeeds: 8 });
  actor.send({ type: "REFRESH_PROGRESS", total: 100, completed: 99 });
  expect(actor.getSnapshot().context.importProgress).toEqual({
    stage: "finding",
    completed: 0,
    total: 8,
  });
  actor.stop();
});

it("counts an import as the stream reports it and ends only with the stream", () => {
  const actor = createActor(loadingMachine).start();
  actor.send({ type: "IMPORT_START", totalFeeds: 2 });
  actor.send({
    type: "IMPORT_PROGRESS",
    progress: { stage: "finding", completed: 2, total: 2 },
  });
  // Finding every Feed does not end the import: fetching follows.
  expect(actor.getSnapshot().value).toBe("importing");
  actor.send({
    type: "IMPORT_PROGRESS",
    progress: { stage: "fetching", completed: 0, total: 1 },
  });
  // Another tab's refresh reports Feeds of its own.
  actor.send({ type: "FEED_STATUS" });
  expect(actor.getSnapshot().context.importProgress).toEqual({
    stage: "fetching",
    completed: 0,
    total: 1,
  });
  actor.send({ type: "IMPORT_COMPLETE" });
  expect(actor.getSnapshot().value).toBe("idle");
  actor.stop();
});
