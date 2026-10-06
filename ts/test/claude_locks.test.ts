import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claudeConfigLock,
  claudeCredentialsLock,
  configLockDir,
  credentialsLockDir,
  internals,
  oauthRefreshLockDir,
  properLockfile,
} from "../src/claude_locks.js";
import { ClaudeCodeLockTimeout } from "../src/exceptions.js";
import { testHome } from "./helpers/home.js";

let tmpPath: string;
let lockDir: string;
const savedInternals = { ...internals };

beforeEach(() => {
  tmpPath = fs.mkdtempSync(path.join(testHome(), "tmp-"));
  lockDir = path.join(tmpPath, "target.lock");
});

afterEach(() => {
  Object.assign(internals, savedInternals);
});

const isDir = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
const ageS = (p: string) => (Date.now() - fs.statSync(p).mtimeMs) / 1000;
const backdate = (p: string, seconds: number) => {
  const past = new Date(Date.now() - seconds * 1000);
  fs.utimesSync(p, past, past);
};

describe("TestProperLockfile", () => {
  it("test_acquire_creates_and_release_removes", () => {
    properLockfile(lockDir, () => {
      expect(isDir(lockDir)).toBe(true);
    });
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("test_reacquire_after_release", () => {
    properLockfile(lockDir, () => {});
    properLockfile(lockDir, () => {
      expect(isDir(lockDir)).toBe(true);
    });
  });

  it("test_contention_times_out", () => {
    fs.mkdirSync(lockDir);
    const start = performance.now();
    expect(() => properLockfile(lockDir, () => {}, { timeout: 0.5 })).toThrow(ClaudeCodeLockTimeout);
    expect(performance.now() - start).toBeLessThan(5000);
    expect(isDir(lockDir)).toBe(true);
  });

  it("test_stale_lock_is_taken_over", () => {
    fs.mkdirSync(lockDir);
    backdate(lockDir, 30);
    properLockfile(
      lockDir,
      () => {
        expect(isDir(lockDir)).toBe(true);
        expect(ageS(lockDir)).toBeLessThan(5.0);
      },
      { timeout: 2.0 },
    );
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("test_release_tolerates_stolen_lock", () => {
    properLockfile(lockDir, () => {
      fs.rmdirSync(lockDir);
    });
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("test_toucher_keeps_mtime_fresh", async () => {
    // The touch timer runs only when the event loop runs, so the body must wait asynchronously.
    internals.TOUCH_INTERVAL_S = 0.1;
    await properLockfile(lockDir, async () => {
      backdate(lockDir, 30);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(ageS(lockDir)).toBeLessThan(10.0);
    });
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("test_creates_missing_parent", () => {
    const nested = path.join(tmpPath, "a", "b", "target.lock");
    properLockfile(nested, () => {
      expect(isDir(nested)).toBe(true);
    });
  });
});

describe("TestLockPaths", () => {
  it("test_default_paths", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    expect(credentialsLockDir()).toBe(path.join(testHome(), ".claude.lock"));
    expect(configLockDir()).toBe(path.join(testHome(), ".claude.json.lock"));
  });

  it("test_claude_config_dir_is_honored", () => {
    const custom = path.join(tmpPath, "custom-claude");
    fs.mkdirSync(custom);
    vi.stubEnv("CLAUDE_CONFIG_DIR", custom);
    expect(credentialsLockDir()).toBe(path.join(tmpPath, "custom-claude.lock"));
    expect(configLockDir()).toBe(path.join(custom, ".claude.json.lock"));
  });

  it("test_named_helpers_lock_their_dirs", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    const home = testHome();
    claudeCredentialsLock(() => {
      expect(isDir(path.join(home, ".claude.lock"))).toBe(true);
      claudeConfigLock(() => {
        expect(isDir(path.join(home, ".claude.json.lock"))).toBe(true);
      });
    });
    expect(fs.existsSync(path.join(home, ".claude.lock"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude.json.lock"))).toBe(false);
  });
});

describe("TestCcRefreshLockProtocol", () => {
  it("test_oauth_refresh_lock_dir_default", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    expect(oauthRefreshLockDir()).toBe(path.join(testHome(), ".claude", ".oauth_refresh.lock"));
  });

  it("test_oauth_refresh_lock_dir_honors_claude_config_dir", () => {
    const custom = path.join(tmpPath, "custom-claude");
    fs.mkdirSync(custom);
    vi.stubEnv("CLAUDE_CONFIG_DIR", custom);
    expect(oauthRefreshLockDir()).toBe(path.join(custom, ".oauth_refresh.lock"));
  });

  it("test_credentials_lock_takes_both_locks", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    const primary = path.join(testHome(), ".claude", ".oauth_refresh.lock");
    const legacy = path.join(testHome(), ".claude.lock");
    claudeCredentialsLock(() => {
      expect(isDir(primary), "primary .oauth_refresh.lock not held").toBe(true);
      expect(isDir(legacy), "legacy .claude.lock not held").toBe(true);
    });
    expect(fs.existsSync(primary)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it("test_primary_contention_never_touches_legacy", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    const primary = path.join(testHome(), ".claude", ".oauth_refresh.lock");
    fs.mkdirSync(primary, { recursive: true });
    expect(() => claudeCredentialsLock(() => {}, { timeout: 0.5 })).toThrow(ClaudeCodeLockTimeout);
    expect(fs.existsSync(path.join(testHome(), ".claude.lock"))).toBe(false);
    expect(isDir(primary)).toBe(true);
  });

  it("test_legacy_contention_releases_primary", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    const legacy = path.join(testHome(), ".claude.lock");
    fs.mkdirSync(legacy);
    expect(() => claudeCredentialsLock(() => {}, { timeout: 0.5 })).toThrow(ClaudeCodeLockTimeout);
    expect(fs.existsSync(path.join(testHome(), ".claude", ".oauth_refresh.lock"))).toBe(false);
    expect(isDir(legacy)).toBe(true);
  });

  it("test_credentials_staleness_is_60s_not_10s", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    const primary = path.join(testHome(), ".claude", ".oauth_refresh.lock");
    fs.mkdirSync(primary, { recursive: true });
    backdate(primary, 30);
    expect(() => claudeCredentialsLock(() => {}, { timeout: 0.5 })).toThrow(ClaudeCodeLockTimeout);
    expect(isDir(primary)).toBe(true);
  });

  it("test_credentials_lock_stale_past_60s_is_taken_over", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    const primary = path.join(testHome(), ".claude", ".oauth_refresh.lock");
    const legacy = path.join(testHome(), ".claude.lock");
    fs.mkdirSync(primary, { recursive: true });
    fs.mkdirSync(legacy);
    backdate(primary, 70);
    backdate(legacy, 70);
    claudeCredentialsLock(
      () => {
        expect(isDir(primary)).toBe(true);
        expect(isDir(legacy)).toBe(true);
      },
      { timeout: 2.0 },
    );
    expect(fs.existsSync(primary)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it("test_config_lock_staleness_stays_10s", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    const cfg = path.join(testHome(), ".claude.json.lock");
    fs.mkdirSync(cfg);
    backdate(cfg, 30);
    claudeConfigLock(
      () => {
        expect(isDir(cfg)).toBe(true);
      },
      { timeout: 2.0 },
    );
    expect(fs.existsSync(cfg)).toBe(false);
  });
});
