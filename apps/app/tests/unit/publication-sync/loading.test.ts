import { createActor } from "xstate";
import { expect, it } from "vitest";
import { loadingMachine } from "~/lib/data/loading-machine";

it("keeps another tab's refresh progress out of an ordinary Feed import", () => {
  const actor = createActor(loadingMachine).start();
  actor.send({ type: "IMPORT_START", totalFeeds: 8 });
  actor.send({ type: "REFRESH_PROGRESS", total: 100, completed: 99 });
  expect(actor.getSnapshot().context).toMatchObject({
    totalFeeds: 8,
    completedFeeds: 0,
  });
  actor.stop();
});
