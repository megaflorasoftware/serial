import { expect, it } from "vitest";
import { createObservationImageWorkload } from "../../../scripts/performance/observation-image-workload";

it("bounds optional page enrichment to eight requests per content batch without database work", async () => {
  const workload = createObservationImageWorkload();
  workload.prepare();
  const observations = await workload.run();
  expect(observations).toHaveLength(100);
  expect(observations.filter((item) => item.pageImageUrl)).toHaveLength(8);
  expect(workload.requests).toBe(8);
});
