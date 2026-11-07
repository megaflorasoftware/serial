let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, (html: string | null) => void>();

function getWorker() {
  if (worker) return worker;
  const currentWorker = new Worker(
    new URL("./highlightCode.worker.ts", import.meta.url),
    {
      type: "module",
    },
  );
  worker = currentWorker;
  currentWorker.onmessage = (
    event: MessageEvent<{ id: number; html: string | null }>,
  ) => {
    const callback = pending.get(event.data.id);
    pending.delete(event.data.id);
    callback?.(event.data.html);
  };
  currentWorker.onerror = () => {
    if (worker !== currentWorker) return;
    currentWorker.terminate();
    worker = undefined;
    for (const callback of pending.values()) callback(null);
    pending.clear();
  };
  return worker;
}

export function requestCodeHighlight(
  code: string,
  language: string | undefined,
  onResult: (html: string | null) => void,
): () => void {
  const id = nextId++;
  try {
    const highlighter = getWorker();
    pending.set(id, onResult);
    highlighter.postMessage({ id, code, language });
  } catch {
    pending.delete(id);
    onResult(null);
  }
  return () => {
    if (pending.delete(id) && pending.size === 0) {
      worker?.terminate();
      worker = undefined;
    }
  };
}
