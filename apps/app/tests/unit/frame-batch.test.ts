import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrameBatch } from "~/lib/frameBatch";

describe("createFrameBatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands every item pushed before the frame to one flush", () => {
    const flush = vi.fn<(items: number[]) => void>();
    const batch = createFrameBatch(flush);
    batch.push(1);
    batch.push(2);
    batch.push(3);
    expect(flush).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([1, 2, 3]);
  });

  it("drains synchronously on flush and cancels the pending frame", () => {
    const flush = vi.fn<(items: number[]) => void>();
    const batch = createFrameBatch(flush);
    batch.push(1);
    batch.flush();
    expect(flush).toHaveBeenCalledWith([1]);

    vi.runAllTimers();
    expect(flush).toHaveBeenCalledTimes(1);

    batch.flush();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("schedules a fresh frame for items pushed after a flush", () => {
    const flush = vi.fn<(items: number[]) => void>();
    const batch = createFrameBatch(flush);
    batch.push(1);
    vi.runAllTimers();
    batch.push(2);
    vi.runAllTimers();
    expect(flush.mock.calls).toEqual([[[1]], [[2]]]);
  });
});
