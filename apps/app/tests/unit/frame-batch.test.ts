import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrameBatch } from "~/lib/frameBatch";

type FrameCallback = (time: number) => void;

/**
 * Node has no animation frames, so the shipped branch is exercised by
 * installing a fake frame queue; the timer fallback is covered separately.
 */
function installFakeAnimationFrames() {
  const frames = new Map<number, FrameCallback>();
  let nextId = 1;
  const requestAnimationFrame = vi.fn((callback: FrameCallback) => {
    const id = nextId++;
    frames.set(id, callback);
    return id;
  });
  const cancelAnimationFrame = vi.fn((id: number) => {
    frames.delete(id);
  });
  vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
  return {
    requestAnimationFrame,
    cancelAnimationFrame,
    runFrames: () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    },
    pendingCount: () => frames.size,
  };
}

describe("createFrameBatch with animation frames", () => {
  let frames: ReturnType<typeof installFakeAnimationFrames>;

  beforeEach(() => {
    frames = installFakeAnimationFrames();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hands every item pushed before the frame to one flush", () => {
    const flush = vi.fn<(items: number[]) => void>();
    const batch = createFrameBatch(flush);
    batch.push(1);
    batch.push(2);
    batch.push(3);
    expect(flush).not.toHaveBeenCalled();
    expect(frames.requestAnimationFrame).toHaveBeenCalledTimes(1);

    frames.runFrames();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([1, 2, 3]);
  });

  it("drains synchronously on flush and cancels the pending frame", () => {
    const flush = vi.fn<(items: number[]) => void>();
    const batch = createFrameBatch(flush);
    batch.push(1);
    batch.flush();
    expect(flush).toHaveBeenCalledWith([1]);
    expect(frames.cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(frames.pendingCount()).toBe(0);

    batch.flush();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(frames.cancelAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it("rethrows a failed frame flush from the next push or flush", () => {
    const flush = vi
      .fn<(items: number[]) => void>()
      .mockImplementationOnce(() => {
        throw new Error("apply failed");
      });
    const batch = createFrameBatch(flush);
    batch.push(1);
    expect(() => frames.runFrames()).not.toThrow();

    expect(() => batch.push(2)).toThrow("apply failed");
    // The failure is reported once; the item that tripped it is not lost.
    expect(() => batch.flush()).not.toThrow();
    expect(flush).toHaveBeenLastCalledWith([2]);
  });

  it("schedules a fresh frame for items pushed after a flush", () => {
    const flush = vi.fn<(items: number[]) => void>();
    const batch = createFrameBatch(flush);
    batch.push(1);
    frames.runFrames();
    batch.push(2);
    expect(frames.requestAnimationFrame).toHaveBeenCalledTimes(2);
    frames.runFrames();
    expect(flush.mock.calls).toEqual([[[1]], [[2]]]);
  });
});

describe("createFrameBatch without animation frames", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back to a zero-delay timer", () => {
    expect(typeof requestAnimationFrame).toBe("undefined");
    const flush = vi.fn<(items: number[]) => void>();
    const batch = createFrameBatch(flush);
    batch.push(1);
    batch.push(2);
    expect(vi.getTimerCount()).toBe(1);

    vi.runAllTimers();
    expect(flush).toHaveBeenCalledWith([1, 2]);
  });

  it("clears the fallback timer when flushed early", () => {
    const flush = vi.fn<(items: number[]) => void>();
    const batch = createFrameBatch(flush);
    batch.push(1);
    batch.flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
