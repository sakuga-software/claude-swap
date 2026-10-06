import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../src/exceptions.js";
import { internals, readTextWithRetry, replaceWithRetry } from "../src/fsutil.js";
import { getLogger } from "../src/logging_config.js";
import { ClaudeAccountSwitcher } from "../src/switcher.js";
import { testHome } from "./helpers/home.js";

const WIN_ERROR_CODES: Record<number, string> = { 2: "ENOENT", 5: "EPERM", 32: "EBUSY", 33: "EBUSY" };

function winOserror(winerror: number): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error("Access is denied");
  e.code = WIN_ERROR_CODES[winerror];
  return e;
}

const original = { ...internals };
let tmpPath: string;

beforeEach(() => {
  tmpPath = testHome();
});

afterEach(() => {
  Object.assign(internals, original);
});

describe("TestReplaceWithRetry", () => {
  it.each([5, 32, 33])("test_retries_transient_windows_errors (%i)", (winerror) => {
    internals.platform = "win32";
    let calls = 0;
    internals.renameSync = (src, dst) => {
      calls += 1;
      if (calls < 4) throw winOserror(winerror);
      original.renameSync(src, dst);
    };
    const src = path.join(tmpPath, "tmp.tmp");
    fs.writeFileSync(src, "payload");
    const dst = path.join(tmpPath, "target.json");

    replaceWithRetry(src, dst);

    expect(calls).toBe(4);
    expect(fs.readFileSync(dst, "utf8")).toBe("payload");
  });

  it("test_gives_up_and_raises_after_attempts", () => {
    internals.platform = "win32";
    internals.renameSync = () => {
      throw winOserror(5);
    };
    expect(() => replaceWithRetry(path.join(tmpPath, "a"), path.join(tmpPath, "b"), { attempts: 3 })).toThrow();
  });

  it("test_does_not_retry_real_errors", () => {
    internals.platform = "win32";
    let calls = 0;
    internals.renameSync = () => {
      calls += 1;
      throw winOserror(2);
    };
    expect(() => replaceWithRetry(path.join(tmpPath, "a"), path.join(tmpPath, "b"))).toThrow();
    expect(calls).toBe(1);
  });

  it("test_posix_never_retries", () => {
    internals.platform = "linux";
    let calls = 0;
    internals.renameSync = () => {
      calls += 1;
      throw winOserror(5);
    };
    expect(() => replaceWithRetry(path.join(tmpPath, "a"), path.join(tmpPath, "b"))).toThrow();
    expect(calls).toBe(1);
  });

  it("test_rejects_nonpositive_attempts", () => {
    const src = path.join(tmpPath, "tmp.tmp");
    fs.writeFileSync(src, "payload");
    expect(() => replaceWithRetry(src, path.join(tmpPath, "target.json"), { attempts: 0 })).toThrow(RangeError);
    expect(fs.existsSync(src)).toBe(true);
  });
});

describe("TestReadTextWithRetry", () => {
  it.each([5, 32, 33])("test_retries_transient_windows_errors (%i)", (winerror) => {
    internals.platform = "win32";
    const target = path.join(tmpPath, "sequence.json");
    fs.writeFileSync(target, "payload");
    let calls = 0;
    internals.readFileSync = (p) => {
      calls += 1;
      if (calls < 4) throw winOserror(winerror);
      return original.readFileSync(p);
    };

    expect(readTextWithRetry(target)).toBe("payload");
    expect(calls).toBe(4);
  });

  it("test_gives_up_and_raises_after_attempts", () => {
    internals.platform = "win32";
    internals.readFileSync = () => {
      throw winOserror(32);
    };
    expect(() => readTextWithRetry(path.join(tmpPath, "a"), { attempts: 3 })).toThrow();
  });

  it("test_posix_eacces_surfaces_immediately", () => {
    internals.platform = "linux";
    let calls = 0;
    internals.readFileSync = () => {
      calls += 1;
      throw winOserror(5);
    };
    expect(() => readTextWithRetry(path.join(tmpPath, "a"))).toThrow();
    expect(calls).toBe(1);
  });

  it("test_does_not_retry_a_non_contention_error", () => {
    internals.platform = "win32";
    let calls = 0;
    internals.readFileSync = () => {
      calls += 1;
      throw winOserror(2);
    };
    expect(() => readTextWithRetry(path.join(tmpPath, "a"))).toThrow();
    expect(calls).toBe(1);
  });

  it("test_rejects_nonpositive_attempts", () => {
    const target = path.join(tmpPath, "a.json");
    fs.writeFileSync(target, "x");
    expect(() => readTextWithRetry(target, { attempts: 0 })).toThrow(RangeError);
  });
});

describe("TestSkipifArgumentsAreEvaluatedEverywhere", () => {
  it.skip("test_no_skipif_condition_calls_a_posix_only_name_unguarded", () => {
    // Python-only: the test parses its own source for pytest `skipif` arguments.
    // vitest has no decorator that runs at collection time.
  });
});

describe("TestStrictRosterReadBranches", () => {
  /** Python `ClaudeAccountSwitcher.__new__`: a switcher with only a logger, so no constructor side effect runs. */
  function switcher(): ClaudeAccountSwitcher {
    const s = Object.create(ClaudeAccountSwitcher.prototype) as ClaudeAccountSwitcher;
    s.logger = getLogger("test");
    return s;
  }

  it("test_a_roster_holding_a_list_is_refused_not_dereferenced", () => {
    const p = path.join(tmpPath, "sequence.json");
    fs.writeFileSync(p, "[1, 2, 3]");
    expect(() => switcher().readJson(p, { strict: true })).toThrow(ConfigError);
    expect(() => switcher().readJson(p, { strict: true })).toThrow(/not a JSON object/);
  });

  it.skipIf(process.platform === "win32" || process.geteuid?.() === 0)(
    "test_an_unreadable_roster_is_refused_not_read_as_empty",
    () => {
      const p = path.join(tmpPath, "sequence.json");
      fs.writeFileSync(p, '{"sequence": [1], "accounts": {"1": {}}}');
      fs.chmodSync(p, 0o000);
      try {
        expect(() => switcher().readJson(p, { strict: true })).toThrow(ConfigError);
        expect(() => switcher().readJson(p, { strict: true })).toThrow(/could not be read/);
      } finally {
        fs.chmodSync(p, 0o600);
      }
    },
  );

  it("test_non_strict_keeps_the_soft_none", () => {
    const p = path.join(tmpPath, "config.json");
    fs.writeFileSync(p, "[1, 2, 3]");
    expect(switcher().readJson(p)).toBeNull();
  });
});
