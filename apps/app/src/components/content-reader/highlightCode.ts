import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { canHighlightCode } from "./codeHighlightingPolicy";

for (const [name, grammar] of Object.entries({
  bash,
  css,
  go,
  java,
  javascript,
  json,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
})) {
  hljs.registerLanguage(name, grammar);
}

const DETECT_LANGUAGES = [
  "javascript",
  "python",
  "bash",
  "css",
  "xml",
  "json",
  "sql",
];

export function highlightCode(code: string, language?: string): string | null {
  // Bound work on imported content. Oversized blocks remain selectable text.
  if (!canHighlightCode(code, language)) return null;
  if (language && !hljs.getLanguage(language)) return null;

  try {
    const result = language
      ? hljs.highlight(code, { language, ignoreIllegals: true })
      : hljs.highlightAuto(code, DETECT_LANGUAGES);
    if (!language && result.relevance < 2) return null;
    return result.value;
  } catch {
    return null;
  }
}
