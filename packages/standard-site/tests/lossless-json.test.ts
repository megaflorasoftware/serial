import { describe, expect, it } from "vitest";
import {
  parseLosslessJson,
  stringifyLosslessJson,
  type LosslessValue,
} from "../src/lossless-json";
import { readFixture, readFixtureText } from "./fixtures";

function roundTrip(text: string): string {
  return stringifyLosslessJson(parseLosslessJson(text));
}

describe("parseLosslessJson", () => {
  it("parses a nested record with unknown fields", () => {
    const text =
      '{"$type":"pub.leaflet.document","title":"Hi",' +
      '"extra":{"unknown":[1,true,null,"x"]}}';
    expect(parseLosslessJson(text)).toEqual({
      $type: "pub.leaflet.document",
      title: "Hi",
      extra: { unknown: [1, true, null, "x"] },
    });
    expect(roundTrip(text)).toBe(text);
  });

  it("round trips link, bytes, null and blob shapes", () => {
    const cases = [
      '{"$link":"bafyreicb2y6tqmdbozmjhzrhs6qpvbcxbldhwcrlxrmqvfgjpwrxjdcmpe"}',
      '{"$bytes":"AAEC"}',
      "null",
      '{"$type":"blob","ref":{"$link":"bafyreiabc"},' +
        '"mimeType":"image/png","size":1234}',
      "{}",
      "[]",
      '{"a":{},"b":[],"c":[[]]}',
    ];
    for (const text of cases) {
      expect(roundTrip(text)).toBe(text);
    }
  });

  it("keeps integers beyond the safe range as bigint", () => {
    expect(parseLosslessJson("9007199254740993")).toBe(9007199254740993n);
    expect(parseLosslessJson("-9223372036854775808")).toBe(
      -9223372036854775808n,
    );
    expect(roundTrip("9007199254740993")).toBe("9007199254740993");
    expect(roundTrip("-9223372036854775808")).toBe("-9223372036854775808");
  });

  it("keeps safe integers, fractions and exponents as numbers", () => {
    expect(parseLosslessJson("9007199254740991")).toBe(9007199254740991);
    expect(parseLosslessJson("1.5")).toBe(1.5);
    expect(parseLosslessJson("1e3")).toBe(1000);
    expect(parseLosslessJson("-0.5e-2")).toBe(-0.005);
    expect(parseLosslessJson("0")).toBe(0);
    const numbers = [
      parseLosslessJson("9007199254740991"),
      parseLosslessJson("1e3"),
    ];
    for (const value of numbers) {
      expect(typeof value).toBe("number");
    }
  });

  it("decodes unicode and surrogate pair escapes", () => {
    expect(parseLosslessJson('"\\u00e9\\u0041"')).toBe("éA");
    expect(parseLosslessJson('"\\ud83d\\ude00"')).toBe("😀");
    expect(parseLosslessJson('"\\"\\\\\\/\\b\\f\\n\\r\\t"')).toBe(
      '"\\/\b\f\n\r\t',
    );
    expect(parseLosslessJson('"é😀"')).toBe("é😀");
  });

  it("ignores insignificant whitespace", () => {
    expect(parseLosslessJson(' \t\r\n{ "a" : [ 1 , 2 ] }\n')).toEqual({
      a: [1, 2],
    });
  });

  it("accepts nesting up to the depth limit", () => {
    const text = `${"[".repeat(512)}1${"]".repeat(512)}`;
    expect(() => parseLosslessJson(text)).not.toThrow();
  });

  it("rejects malformed input", () => {
    const cases = [
      '{"a":1} trailing',
      "[1][2]",
      '{"__proto__":1}',
      "NaN",
      "Infinity",
      "undefined",
      "",
      "[1,]",
      "{,}",
      "01",
      "1.",
      ".5",
      "+1",
      "1e",
      "'a'",
      '"unterminated',
      '{"a" 1}',
      "1e999",
      `${"[".repeat(513)}1${"]".repeat(513)}`,
    ];
    for (const text of cases) {
      expect(() => parseLosslessJson(text), text).toThrow(SyntaxError);
    }
  });

  it("does not pollute the prototype", () => {
    expect(() =>
      parseLosslessJson('{"a":{"__proto__":{"polluted":true}}}'),
    ).toThrow(SyntaxError);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("stringifyLosslessJson", () => {
  it("writes bigints as bare digits", () => {
    expect(stringifyLosslessJson({ size: -9223372036854775808n })).toBe(
      '{"size":-9223372036854775808}',
    );
  });

  it("escapes strings exactly like JSON.stringify", () => {
    const value = { text: 'a "quote"\n\tand é😀 ' };
    expect(stringifyLosslessJson(value)).toBe(JSON.stringify(value));
  });

  it("keeps insertion order", () => {
    expect(stringifyLosslessJson({ b: 1, a: 2, c: 3 })).toBe(
      '{"b":1,"a":2,"c":3}',
    );
  });

  it("rejects values JSON cannot represent", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    const cases: unknown[] = [
      undefined,
      { a: undefined },
      () => 1,
      Symbol("x"),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      new Uint8Array([0, 1, 2]),
      { bytes: new Uint8Array([0, 1, 2]) },
      cyclic,
      cyclicArray,
    ];
    for (const value of cases) {
      expect(() => stringifyLosslessJson(value)).toThrow(TypeError);
    }
  });

  it("allows the same object to appear twice in different branches", () => {
    const shared = { a: 1 };
    expect(stringifyLosslessJson([shared, shared])).toBe('[{"a":1},{"a":1}]');
  });
});

describe("fixture parity with JSON", () => {
  const name = "leaflet-network-punk";

  it("parses identically to JSON.parse", () => {
    const text = readFixtureText(name);
    expect(parseLosslessJson(text)).toEqual(readFixture(name) as LosslessValue);
  });

  it("serializes identically to JSON.stringify", () => {
    const text = readFixtureText(name);
    expect(stringifyLosslessJson(parseLosslessJson(text))).toBe(
      JSON.stringify(JSON.parse(text)),
    );
  });
});
