import { highlightCode } from "./highlightCode";

self.onmessage = (
  event: MessageEvent<{ id: number; code: string; language?: string }>,
) => {
  const { id, code, language } = event.data;
  self.postMessage({ id, html: highlightCode(code, language) });
};
