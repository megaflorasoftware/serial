/**
 * JSON that survives signed 64-bit integers.
 *
 * AT Protocol records may carry integers outside the double-precision safe
 * range, which `JSON.parse` silently rounds. This module keeps them as
 * `bigint` and writes them back as bare digits. It runs on the Node server and
 * in the browser, so it uses no Node built-ins and no `JSON.rawJSON`.
 */

export type LosslessValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | LosslessValue[]
  | { [key: string]: LosslessValue };

/** Nesting limit, so hostile input cannot overflow the call stack. */
const MAX_DEPTH = 512;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

const CODE = {
  tab: 9,
  lineFeed: 10,
  carriageReturn: 13,
  space: 32,
  quote: 34,
  plus: 43,
  comma: 44,
  minus: 45,
  period: 46,
  slash: 47,
  zero: 48,
  nine: 57,
  colon: 58,
  upperA: 65,
  upperE: 69,
  upperF: 70,
  leftBracket: 91,
  backslash: 92,
  rightBracket: 93,
  lowerA: 97,
  lowerB: 98,
  lowerE: 101,
  lowerF: 102,
  lowerN: 110,
  lowerR: 114,
  lowerT: 116,
  lowerU: 117,
  leftBrace: 123,
  rightBrace: 125,
} as const;

const SIMPLE_ESCAPES: Record<number, string> = {
  [CODE.quote]: '"',
  [CODE.backslash]: "\\",
  [CODE.slash]: "/",
  [CODE.lowerB]: "\b",
  [CODE.lowerF]: "\f",
  [CODE.lowerN]: "\n",
  [CODE.lowerR]: "\r",
  [CODE.lowerT]: "\t",
};

type Cursor = { readonly text: string; index: number };

/**
 * Parses JSON text. Integers outside Number's safe range become `bigint`;
 * every other number stays a `number`. Throws `SyntaxError` on invalid JSON,
 * on a `__proto__` key, and on non-finite results.
 */
export function parseLosslessJson(text: string): LosslessValue {
  const cursor: Cursor = { text, index: 0 };
  skipWhitespace(cursor);
  const value = parseValue(cursor, 0);
  skipWhitespace(cursor);
  if (cursor.index !== text.length)
    throw fail(cursor, "unexpected trailing content");
  return value;
}

function parseValue(cursor: Cursor, depth: number): LosslessValue {
  const code = codeAt(cursor, cursor.index);
  if (code === CODE.quote) return parseString(cursor);
  if (code === CODE.leftBrace)
    return parseObject(cursor, enterDepth(cursor, depth));
  if (code === CODE.leftBracket)
    return parseArray(cursor, enterDepth(cursor, depth));
  if (code === CODE.lowerT) return parseLiteral(cursor, "true", true);
  if (code === CODE.lowerF) return parseLiteral(cursor, "false", false);
  if (code === CODE.lowerN) return parseLiteral(cursor, "null", null);
  return parseNumber(cursor);
}

function parseObject(
  cursor: Cursor,
  depth: number,
): { [key: string]: LosslessValue } {
  const result: { [key: string]: LosslessValue } = {};
  cursor.index += 1;
  skipWhitespace(cursor);
  if (skipIf(cursor, CODE.rightBrace)) return result;
  for (;;) {
    skipWhitespace(cursor);
    const key = parseKey(cursor);
    skipWhitespace(cursor);
    expectCode(cursor, CODE.colon, "':'");
    skipWhitespace(cursor);
    result[key] = parseValue(cursor, depth);
    skipWhitespace(cursor);
    if (skipIf(cursor, CODE.comma)) continue;
    expectCode(cursor, CODE.rightBrace, "'}'");
    return result;
  }
}

function parseKey(cursor: Cursor): string {
  if (codeAt(cursor, cursor.index) !== CODE.quote)
    throw fail(cursor, "expected an object key");
  const key = parseString(cursor);
  if (key === "__proto__") throw fail(cursor, "forbidden '__proto__' key");
  return key;
}

function parseArray(cursor: Cursor, depth: number): LosslessValue[] {
  const result: LosslessValue[] = [];
  cursor.index += 1;
  skipWhitespace(cursor);
  if (skipIf(cursor, CODE.rightBracket)) return result;
  for (;;) {
    skipWhitespace(cursor);
    result.push(parseValue(cursor, depth));
    skipWhitespace(cursor);
    if (skipIf(cursor, CODE.comma)) continue;
    expectCode(cursor, CODE.rightBracket, "']'");
    return result;
  }
}

function parseString(cursor: Cursor): string {
  cursor.index += 1;
  let result = "";
  let chunkStart = cursor.index;
  for (;;) {
    const code = codeAt(cursor, cursor.index);
    if (code === CODE.quote) {
      result += cursor.text.slice(chunkStart, cursor.index);
      cursor.index += 1;
      return result;
    }
    if (code === CODE.backslash) {
      result += cursor.text.slice(chunkStart, cursor.index);
      cursor.index += 1;
      result += parseEscape(cursor);
      chunkStart = cursor.index;
      continue;
    }
    if (code < CODE.space)
      throw fail(cursor, "unescaped control character in string");
    cursor.index += 1;
  }
}

function parseEscape(cursor: Cursor): string {
  const code = codeAt(cursor, cursor.index);
  cursor.index += 1;
  const simple = SIMPLE_ESCAPES[code];
  if (simple !== undefined) return simple;
  if (code !== CODE.lowerU) throw fail(cursor, "invalid escape sequence");
  return String.fromCharCode(parseHexQuad(cursor));
}

function parseHexQuad(cursor: Cursor): number {
  let value = 0;
  for (let digit = 0; digit < 4; digit += 1) {
    value = value * 16 + hexDigitValue(cursor, codeAt(cursor, cursor.index));
    cursor.index += 1;
  }
  return value;
}

function hexDigitValue(cursor: Cursor, code: number): number {
  if (isDigit(code)) return code - CODE.zero;
  if (code >= CODE.lowerA && code <= CODE.lowerF)
    return code - CODE.lowerA + 10;
  if (code >= CODE.upperA && code <= CODE.upperF)
    return code - CODE.upperA + 10;
  throw fail(cursor, "invalid \\u escape");
}

function parseNumber(cursor: Cursor): number | bigint {
  const start = cursor.index;
  skipIf(cursor, CODE.minus);
  parseIntegerPart(cursor);
  const hasFraction = skipIf(cursor, CODE.period);
  if (hasFraction) skipDigits(cursor);
  const hasExponent =
    skipIf(cursor, CODE.lowerE) || skipIf(cursor, CODE.upperE);
  if (hasExponent) {
    if (!skipIf(cursor, CODE.plus)) skipIf(cursor, CODE.minus);
    skipDigits(cursor);
  }
  const token = cursor.text.slice(start, cursor.index);
  if (hasFraction || hasExponent) return toFiniteNumber(cursor, token);
  return toIntegerValue(token);
}

function parseIntegerPart(cursor: Cursor): void {
  if (codeAt(cursor, cursor.index) === CODE.zero) {
    cursor.index += 1;
    return;
  }
  skipDigits(cursor);
}

/** Integers beyond the safe range keep every digit as a `bigint`. */
function toIntegerValue(token: string): number | bigint {
  const integer = BigInt(token);
  if (integer > MAX_SAFE || integer < MIN_SAFE) return integer;
  return Number(token);
}

function toFiniteNumber(cursor: Cursor, token: string): number {
  const parsed = Number(token);
  if (!Number.isFinite(parsed)) throw fail(cursor, "number is not finite");
  return parsed;
}

function parseLiteral<T>(cursor: Cursor, word: string, value: T): T {
  if (!cursor.text.startsWith(word, cursor.index))
    throw fail(cursor, "unexpected token");
  cursor.index += word.length;
  return value;
}

function skipWhitespace(cursor: Cursor): void {
  while (isWhitespace(cursor.text.charCodeAt(cursor.index))) cursor.index += 1;
}

function skipDigits(cursor: Cursor): void {
  const start = cursor.index;
  while (isDigit(cursor.text.charCodeAt(cursor.index))) cursor.index += 1;
  if (cursor.index === start) throw fail(cursor, "expected a digit");
}

function skipIf(cursor: Cursor, code: number): boolean {
  if (cursor.text.charCodeAt(cursor.index) !== code) return false;
  cursor.index += 1;
  return true;
}

function expectCode(cursor: Cursor, code: number, label: string): void {
  if (codeAt(cursor, cursor.index) !== code)
    throw fail(cursor, `expected ${label}`);
  cursor.index += 1;
}

function enterDepth(cursor: Cursor, depth: number): number {
  if (depth >= MAX_DEPTH)
    throw fail(cursor, `nesting deeper than ${MAX_DEPTH}`);
  return depth + 1;
}

function codeAt(cursor: Cursor, index: number): number {
  const code = cursor.text.charCodeAt(index);
  if (Number.isNaN(code)) throw fail(cursor, "unexpected end of input");
  return code;
}

function isDigit(code: number): boolean {
  return code >= CODE.zero && code <= CODE.nine;
}

function isWhitespace(code: number): boolean {
  return (
    code === CODE.space ||
    code === CODE.tab ||
    code === CODE.lineFeed ||
    code === CODE.carriageReturn
  );
}

function fail(cursor: Cursor, message: string): SyntaxError {
  return new SyntaxError(
    `Invalid JSON at position ${cursor.index}: ${message}`,
  );
}

/**
 * Serializes to compact JSON. `bigint` values print as bare digits and keys
 * keep insertion order; undefined properties are omitted. Throws `TypeError`
 * for a bare `undefined`, functions, symbols, `NaN`, `Infinity`, binary data,
 * and cyclic input.
 */
export function stringifyLosslessJson(value: unknown): string {
  return writeValue(value, new Set<unknown>());
}

function writeValue(value: unknown, ancestors: Set<unknown>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return value.toString();
    case "number":
      return writeNumber(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      return writeContainer(value, ancestors);
    default:
      throw new TypeError(`Cannot serialize ${typeof value} as JSON`);
  }
}

function writeNumber(value: number): string {
  if (!Number.isFinite(value))
    throw new TypeError("Cannot serialize a non-finite number as JSON");
  return JSON.stringify(value);
}

function writeContainer(value: object, ancestors: Set<unknown>): string {
  if (ArrayBuffer.isView(value))
    throw new TypeError("Convert binary data before serializing it as JSON");
  if (ancestors.has(value))
    throw new TypeError("Cannot serialize cyclic structures as JSON");
  ancestors.add(value);
  const text = Array.isArray(value)
    ? writeArray(value, ancestors)
    : writeObject(value as Record<string, unknown>, ancestors);
  ancestors.delete(value);
  return text;
}

function writeArray(value: unknown[], ancestors: Set<unknown>): string {
  return `[${value.map((entry) => writeValue(entry, ancestors)).join(",")}]`;
}

function writeObject(
  value: Record<string, unknown>,
  ancestors: Set<unknown>,
): string {
  // Like `JSON.stringify`, an undefined property is absent rather than an error.
  const entries = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .map(
      (key) => `${JSON.stringify(key)}:${writeValue(value[key], ancestors)}`,
    );
  return `{${entries.join(",")}}`;
}
