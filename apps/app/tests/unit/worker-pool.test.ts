import { expect, it } from "vitest";
import { orderedWorkerPool } from "~/lib/workerPool";

function deferred() {
  let resolve: (value: string) => void = () => {};
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("yields results in item order, with at most the concurrency running", async () => {
  const work = new Map(["a", "b", "c"].map((item) => [item, deferred()]));
  const started: string[] = [];
  const pool = orderedWorkerPool([...work.keys()], 2, (item) => {
    started.push(item);
    return work.get(item)!.promise;
  });
  const first = pool.next();
  expect(started).toEqual(["a", "b"]);
  // "b" finishes first, but waits for "a".
  work.get("b")!.resolve("B");
  work.get("a")!.resolve("A");
  expect(await first).toEqual({ value: "A", done: false });
  const second = pool.next();
  expect(started).toEqual(["a", "b", "c"]);
  expect(await second).toEqual({ value: "B", done: false });
  work.get("c")!.resolve("C");
  expect(await pool.next()).toEqual({ value: "C", done: false });
  expect(await pool.next()).toEqual({ value: undefined, done: true });
});

it("starts nothing more once the consumer stops, and leaves no failure unhandled", async () => {
  const started: number[] = [];
  for await (const result of orderedWorkerPool([1, 2, 3, 4], 2, (item) => {
    started.push(item);
    return item === 2
      ? Promise.reject(new Error("not taken"))
      : Promise.resolve(item);
  }))
    if (result === 1) break;
  expect(started).toEqual([1, 2]);
});
