import { describe, expect, it } from "vitest";
import { fromisoformat, isoformat, jsonDumps } from "../../src/support/py.js";

describe("isoformat", () => {
  const date = new Date(Date.UTC(2026, 9, 6, 9, 5, 7, 120));
  it("writes microseconds and a UTC offset by default", () => {
    expect(isoformat(date)).toBe("2026-10-06T09:05:07.120000+00:00");
  });
  it("drops the fraction for timespec=seconds", () => {
    expect(isoformat(date, { timespec: "seconds" })).toBe("2026-10-06T09:05:07+00:00");
  });
  it("omits a zero fraction in auto mode", () => {
    expect(isoformat(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-01-01T00:00:00+00:00");
  });
});

describe("fromisoformat", () => {
  it.each([
    ["2026-10-06T09:05:07+00:00", Date.UTC(2026, 9, 6, 9, 5, 7)],
    ["2026-10-06T09:05:07Z", Date.UTC(2026, 9, 6, 9, 5, 7)],
    ["2026-10-06T11:05:07.123456+02:00", Date.UTC(2026, 9, 6, 9, 5, 7, 123)],
  ])("parses %s", (text, expected) => {
    expect(fromisoformat(text).getTime()).toBe(expected);
  });
  it("rejects garbage", () => {
    expect(() => fromisoformat("nope")).toThrow(RangeError);
  });
});

describe("jsonDumps", () => {
  it("uses Python separators without indent", () => {
    expect(jsonDumps({ a: [1, 2], "b:c": "x,y" })).toBe('{"a": [1, 2], "b:c": "x,y"}');
  });
  it("escapes non-ASCII like ensure_ascii", () => {
    expect(jsonDumps({ n: "é" }, 2)).toBe('{\n  "n": "\\u00e9"\n}');
  });
});
