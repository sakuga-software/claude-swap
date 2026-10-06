import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MISSING, readCache, writeCache } from "../src/cache.js";
import { testHome } from "./helpers/home.js";

let tmpPath: string;

beforeEach(() => {
  tmpPath = fs.mkdtempSync(path.join(testHome(), "tmp-"));
});

const now = () => Date.now() / 1000;

describe("TestReadCache", () => {
  it("test_returns_data_within_ttl", () => {
    const cacheFile = path.join(tmpPath, "test.json");
    fs.writeFileSync(cacheFile, JSON.stringify({ timestamp: now(), data: { key: "value" } }));

    expect(readCache(cacheFile, 60)).toEqual({ key: "value" });
  });

  it("test_returns_missing_when_expired", () => {
    const cacheFile = path.join(tmpPath, "test.json");
    fs.writeFileSync(cacheFile, JSON.stringify({ timestamp: now() - 100, data: { key: "value" } }));

    expect(readCache(cacheFile, 60)).toBe(MISSING);
  });

  it("test_returns_missing_for_missing_file", () => {
    expect(readCache(path.join(tmpPath, "nonexistent.json"), 60)).toBe(MISSING);
  });

  it("test_returns_missing_for_corrupt_json", () => {
    const cacheFile = path.join(tmpPath, "test.json");
    fs.writeFileSync(cacheFile, "not valid json{{{");

    expect(readCache(cacheFile, 60)).toBe(MISSING);
  });

  it("test_cached_none_is_distinguishable_from_miss", () => {
    const cacheFile = path.join(tmpPath, "test.json");
    fs.writeFileSync(cacheFile, JSON.stringify({ timestamp: now(), data: null }));

    const result = readCache(cacheFile, 60);
    expect(result).toBeNull();
    expect(result).not.toBe(MISSING);
  });
});

describe("TestWriteCache", () => {
  it("test_creates_file_and_parent_dirs", () => {
    const cacheFile = path.join(tmpPath, "sub", "dir", "test.json");
    writeCache(cacheFile, { key: "value" });

    expect(fs.existsSync(cacheFile)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    expect(raw.data).toEqual({ key: "value" });
    expect(raw).toHaveProperty("timestamp");
  });

  it("test_roundtrip", () => {
    const cacheFile = path.join(tmpPath, "test.json");
    const data = { accounts: [1, 2, 3], nested: { a: true } };

    writeCache(cacheFile, data);
    expect(readCache(cacheFile, 60)).toEqual(data);
  });
});
