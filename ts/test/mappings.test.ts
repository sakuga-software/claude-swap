import fs from "node:fs";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { internals, MappingStore, normalizePath } from "../src/mappings.js";
import { testHome } from "./helpers/home.js";

let tmpPath: string;

beforeEach(() => {
  tmpPath = fs.mkdtempSync(path.join(testHome(), "tmp-"));
});

const mkdirs = (p: string) => fs.mkdirSync(p, { recursive: true });

it("test_set_then_get_exact", () => {
  const backup = path.join(tmpPath, "backup");
  const repo = path.join(tmpPath, "work", "app");
  mkdirs(repo);
  const store = new MappingStore(backup);

  store.set(repo, "work@co.com", "org-1");

  const entry = store.get(repo);
  expect(entry).not.toBeNull();
  expect(entry!.email).toBe("work@co.com");
  expect(entry!.organizationUuid).toBe("org-1");
  expect(entry!.added).toBeTruthy();
});

it("test_get_missing_returns_none", () => {
  const store = new MappingStore(path.join(tmpPath, "backup"));
  expect(store.get(path.join(tmpPath, "nope"))).toBeNull();
});

it("test_resolve_exact_dir", () => {
  const repo = path.join(tmpPath, "repo");
  mkdirs(repo);
  const store = new MappingStore(path.join(tmpPath, "backup"));
  store.set(repo, "a@x.com", "");

  const match = store.resolve(repo);
  expect(match).not.toBeNull();
  expect(match![0]).toBe(normalizePath(repo));
  expect(match![1].email).toBe("a@x.com");
});

it("test_resolve_nested_subdir_inherits", () => {
  const repo = path.join(tmpPath, "repo");
  const sub = path.join(repo, "src", "deep");
  mkdirs(sub);
  const store = new MappingStore(path.join(tmpPath, "backup"));
  store.set(repo, "a@x.com", "");

  const match = store.resolve(sub);
  expect(match).not.toBeNull();
  expect(match![1].email).toBe("a@x.com");
});

it("test_resolve_longest_ancestor_wins", () => {
  const outer = path.join(tmpPath, "work");
  const inner = path.join(outer, "client");
  const cwd = path.join(inner, "src");
  mkdirs(cwd);
  const store = new MappingStore(path.join(tmpPath, "backup"));
  store.set(outer, "outer@x.com", "");
  store.set(inner, "inner@x.com", "");

  const match = store.resolve(cwd);
  expect(match).not.toBeNull();
  expect(match![1].email).toBe("inner@x.com");
});

it("test_resolve_sibling_prefix_does_not_match", () => {
  const mapped = path.join(tmpPath, "foo", "bar");
  const sibling = path.join(tmpPath, "foo", "barbaz");
  mkdirs(mapped);
  mkdirs(sibling);
  const store = new MappingStore(path.join(tmpPath, "backup"));
  store.set(mapped, "a@x.com", "");

  expect(store.resolve(sibling)).toBeNull();
});

it("test_resolve_unmapped_returns_none", () => {
  const store = new MappingStore(path.join(tmpPath, "backup"));
  store.set(path.join(tmpPath, "a"), "a@x.com", "");
  const other = path.join(tmpPath, "b");
  mkdirs(other);
  expect(store.resolve(other)).toBeNull();
});

it("test_remove", () => {
  const repo = path.join(tmpPath, "repo");
  mkdirs(repo);
  const store = new MappingStore(path.join(tmpPath, "backup"));
  store.set(repo, "a@x.com", "");

  expect(store.remove(repo)).toBe(true);
  expect(store.get(repo)).toBeNull();
  expect(store.remove(repo)).toBe(false);
});

it("test_set_overwrites_same_key", () => {
  const repo = path.join(tmpPath, "repo");
  mkdirs(repo);
  const store = new MappingStore(path.join(tmpPath, "backup"));
  store.set(repo, "a@x.com", "");
  store.set(repo, "b@x.com", "org-9");

  const entry = store.get(repo)!;
  expect(entry.email).toBe("b@x.com");
  expect(entry.organizationUuid).toBe("org-9");
  expect(Object.keys(store.all())).toHaveLength(1);
});

it("test_prune_account", () => {
  const [a, b, c] = ["a", "b", "c"].map((n) => path.join(tmpPath, n)) as [string, string, string];
  for (const d of [a, b, c]) mkdirs(d);
  const store = new MappingStore(path.join(tmpPath, "backup"));
  store.set(a, "work@x.com", "org-1");
  store.set(b, "work@x.com", "org-1");
  store.set(c, "personal@x.com", "");

  const removed = store.pruneAccount("work@x.com", "org-1");

  expect(removed).toBe(2);
  expect(store.get(a)).toBeNull();
  expect(store.get(b)).toBeNull();
  expect(store.get(c)).not.toBeNull();
});

it("test_load_missing_file_is_empty", () => {
  const store = new MappingStore(path.join(tmpPath, "backup"));
  expect(store.load()).toEqual({});
  expect(store.all()).toEqual({});
  expect(store.resolve(tmpPath)).toBeNull();
});

it("test_load_corrupt_file_is_empty", () => {
  const backup = path.join(tmpPath, "backup");
  mkdirs(backup);
  fs.writeFileSync(path.join(backup, "mappings.json"), "{ not json", "utf8");
  const store = new MappingStore(backup);
  expect(store.load()).toEqual({});
});

it("test_normalize_path_expands_and_resolves", () => {
  const repo = path.join(tmpPath, "repo");
  mkdirs(repo);
  const a = normalizePath(repo);
  const b = normalizePath(`${repo}/`);
  const c = normalizePath(`${repo}/.`);
  expect(b).toBe(a);
  expect(c).toBe(a);
});

it("test_persisted_schema", () => {
  const backup = path.join(tmpPath, "backup");
  const repo = path.join(tmpPath, "repo");
  mkdirs(repo);
  const store = new MappingStore(backup);
  store.set(repo, "a@x.com", "org-1");

  const data = JSON.parse(fs.readFileSync(path.join(backup, "mappings.json"), "utf8"));
  expect(data.schemaVersion).toBe(1);
  expect(data.mappings).toHaveProperty([normalizePath(repo)]);
});

it("test_normalize_path_applies_normcase", () => {
  const calls: string[] = [];
  vi.spyOn(internals, "normcase").mockImplementation((s: string) => {
    calls.push(s);
    return s.toLowerCase();
  });
  const repo = path.join(tmpPath, "Repo");
  mkdirs(repo);

  const key = normalizePath(repo);

  expect(calls.length, "normalize_path did not call os.path.normcase").toBeGreaterThan(0);
  expect(key, "normcase result was not applied to the key").toBe(key.toLowerCase());
});
