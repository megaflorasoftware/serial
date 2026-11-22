import { expect, it, vi } from "vitest";
import type { db } from "~/server/db";
import { wakePublicationSyncJobs } from "~/server/publication-sync/jobs";
import { wakeRequestedSync } from "~/server/publication-sync/wake";

vi.mock("~/server/publication-sync/jobs", () => ({
  wakePublicationSyncJobs: vi.fn(),
}));

it("wakes the job only when a run was requested", () => {
  const database = {} as typeof db;
  wakeRequestedSync(database, false);
  expect(wakePublicationSyncJobs).not.toHaveBeenCalled();
  wakeRequestedSync(database, true);
  expect(wakePublicationSyncJobs).toHaveBeenCalledTimes(1);
  expect(wakePublicationSyncJobs).toHaveBeenCalledWith(database);
});
