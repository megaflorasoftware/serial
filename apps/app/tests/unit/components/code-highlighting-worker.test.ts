import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class TestWorker {
  static instances: TestWorker[] = [];
  onmessage?: (event: { data: { id: number; html: string | null } }) => void;
  onerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    TestWorker.instances.push(this);
  }
}

beforeEach(() => {
  vi.resetModules();
  TestWorker.instances = [];
  vi.stubGlobal("Worker", TestWorker);
});
afterEach(() => vi.unstubAllGlobals());

describe("code highlighting worker", () => {
  it("shares one worker and delivers each result to its block", async () => {
    const { requestCodeHighlight } =
      await import("~/components/content-reader/highlightCodeClient");
    const first = vi.fn();
    const second = vi.fn();
    requestCodeHighlight("first", "js", first);
    requestCodeHighlight("second", undefined, second);
    expect(TestWorker.instances).toHaveLength(1);
    const worker = TestWorker.instances[0]!;
    const [firstMessage, secondMessage] = worker.postMessage.mock.calls.map(
      ([message]) => message as { id: number },
    );
    worker.onmessage?.({
      data: { id: secondMessage!.id, html: "second result" },
    });
    worker.onmessage?.({
      data: { id: firstMessage!.id, html: "first result" },
    });
    expect(first).toHaveBeenCalledWith("first result");
    expect(second).toHaveBeenCalledWith("second result");
  });

  it("drops cancelled results and resolves pending blocks as plain text on failure", async () => {
    const { requestCodeHighlight } =
      await import("~/components/content-reader/highlightCodeClient");
    const cancelled = vi.fn();
    const pending = vi.fn();
    const cancel = requestCodeHighlight("old", "js", cancelled);
    requestCodeHighlight("current", "js", pending);
    cancel();
    const worker = TestWorker.instances[0]!;
    const message = worker.postMessage.mock.calls[0]![0] as { id: number };
    worker.onmessage?.({ data: { id: message.id, html: "stale" } });
    expect(cancelled).not.toHaveBeenCalled();
    worker.onerror?.();
    expect(pending).toHaveBeenCalledWith(null);
    expect(worker.terminate).toHaveBeenCalledOnce();
    requestCodeHighlight("retry", "js", vi.fn());
    expect(TestWorker.instances).toHaveLength(2);
  });

  it("keeps plain code when workers are unavailable", async () => {
    vi.stubGlobal("Worker", undefined);
    const { requestCodeHighlight } =
      await import("~/components/content-reader/highlightCodeClient");
    const callback = vi.fn();
    requestCodeHighlight("const x = 1;", "js", callback);
    expect(callback).toHaveBeenCalledWith(null);
  });

  it("terminates abandoned work before highlighting the next article", async () => {
    const { requestCodeHighlight } =
      await import("~/components/content-reader/highlightCodeClient");
    const cancel = requestCodeHighlight("old", "js", vi.fn());
    const abandonedWorker = TestWorker.instances[0]!;
    cancel();
    expect(abandonedWorker.terminate).toHaveBeenCalledOnce();
    const next = vi.fn();
    requestCodeHighlight("new", "js", next);
    expect(TestWorker.instances).toHaveLength(2);
    abandonedWorker.onerror?.();
    expect(next).not.toHaveBeenCalled();
    expect(TestWorker.instances[1]!.terminate).not.toHaveBeenCalled();
  });
});
