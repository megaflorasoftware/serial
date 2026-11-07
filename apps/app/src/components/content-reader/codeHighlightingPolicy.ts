export function canHighlightCode(code: string, language?: string): boolean {
  return (
    Boolean(code.trim()) &&
    code.length <= (language ? 20_000 : 5_000) &&
    !/^(?:text|plain|plaintext|none)$/.test(language ?? "")
  );
}
