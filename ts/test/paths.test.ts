import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MigrationError } from "../src/exceptions.js";
import { Platform } from "../src/models.js";
import {
  LEGACY_BACKUP_DIRNAME,
  getBackupRoot,
  getClaudeConfigHome,
  getCredentialsPath,
  getGlobalConfigPath,
  getLegacyBackupRoot,
  internals,
  migrateLegacyBackupDir,
} from "../src/paths.js";
import { testHome } from "./helpers/home.js";

let isolatedHome: string;
let tmpPath: string;

beforeEach(() => {
  tmpPath = fs.mkdtempSync(path.join(testHome(), "tmp-"));
  isolatedHome = testHome();
});

const read = (p: string) => fs.readFileSync(p, "utf8");
const write = (p: string, text: string) => fs.writeFileSync(p, text);

describe("TestGetClaudeConfigHome", () => {
  it("test_default_is_dot_claude_in_home", () => {
    expect(getClaudeConfigHome()).toBe(path.join(isolatedHome, ".claude"));
  });

  it("test_respects_env_var", () => {
    const custom = path.join(tmpPath, "custom-claude");
    vi.stubEnv("CLAUDE_CONFIG_DIR", custom);
    expect(getClaudeConfigHome()).toBe(custom);
  });
});

describe("TestGetGlobalConfigPath", () => {
  it("test_default_returns_homedir_claude_json", () => {
    expect(getGlobalConfigPath()).toBe(path.join(isolatedHome, ".claude.json"));
  });

  it("test_ccd_set_returns_ccd_claude_json", () => {
    const custom = path.join(tmpPath, "ccd");
    fs.mkdirSync(custom);
    vi.stubEnv("CLAUDE_CONFIG_DIR", custom);
    expect(getGlobalConfigPath()).toBe(path.join(custom, ".claude.json"));
  });

  it("test_legacy_config_json_takes_precedence", () => {
    const configHome = path.join(isolatedHome, ".claude");
    fs.mkdirSync(configHome, { recursive: true });
    const legacy = path.join(configHome, ".config.json");
    write(legacy, "{}");
    expect(getGlobalConfigPath()).toBe(legacy);
  });

  it("test_legacy_config_json_in_ccd_takes_precedence", () => {
    const custom = path.join(tmpPath, "ccd");
    fs.mkdirSync(custom);
    vi.stubEnv("CLAUDE_CONFIG_DIR", custom);
    const legacy = path.join(custom, ".config.json");
    write(legacy, "{}");
    expect(getGlobalConfigPath()).toBe(legacy);
  });
});

describe("TestGetCredentialsPath", () => {
  it("test_default_inside_dot_claude", () => {
    expect(getCredentialsPath()).toBe(path.join(isolatedHome, ".claude", ".credentials.json"));
  });

  it("test_respects_ccd", () => {
    const custom = path.join(tmpPath, "ccd");
    vi.stubEnv("CLAUDE_CONFIG_DIR", custom);
    expect(getCredentialsPath()).toBe(path.join(custom, ".credentials.json"));
  });
});

describe("TestGetBackupRoot", () => {
  const xdgDefault = () => path.join(isolatedHome, ".local", "share", "claude-swap");

  it("test_linux_default_is_xdg_data_home", () => {
    vi.stubEnv("XDG_DATA_HOME", undefined);
    vi.spyOn(Platform, "detect").mockReturnValue(Platform.LINUX);
    expect(getBackupRoot()).toBe(xdgDefault());
  });

  it("test_linux_respects_xdg_data_home", () => {
    const custom = path.join(tmpPath, "xdg");
    vi.stubEnv("XDG_DATA_HOME", custom);
    vi.spyOn(Platform, "detect").mockReturnValue(Platform.LINUX);
    expect(getBackupRoot()).toBe(path.join(custom, "claude-swap"));
  });

  it("test_linux_ignores_empty_xdg_data_home", () => {
    vi.stubEnv("XDG_DATA_HOME", "");
    vi.spyOn(Platform, "detect").mockReturnValue(Platform.LINUX);
    expect(getBackupRoot()).toBe(xdgDefault());
  });

  it("test_linux_ignores_relative_xdg_data_home", () => {
    vi.stubEnv("XDG_DATA_HOME", "relative/path");
    vi.spyOn(Platform, "detect").mockReturnValue(Platform.LINUX);
    expect(getBackupRoot()).toBe(xdgDefault());
  });

  it("test_linux_expands_tilde_in_xdg_data_home", () => {
    vi.stubEnv("XDG_DATA_HOME", "~/custom-data");
    vi.spyOn(Platform, "detect").mockReturnValue(Platform.LINUX);
    expect(getBackupRoot()).toBe(path.join(isolatedHome, "custom-data", "claude-swap"));
  });

  it("test_wsl_uses_xdg_layout", () => {
    vi.stubEnv("XDG_DATA_HOME", undefined);
    vi.spyOn(Platform, "detect").mockReturnValue(Platform.WSL);
    expect(getBackupRoot()).toBe(xdgDefault());
  });

  it("test_macos_uses_legacy_layout", () => {
    vi.spyOn(Platform, "detect").mockReturnValue(Platform.MACOS);
    expect(getBackupRoot()).toBe(path.join(isolatedHome, LEGACY_BACKUP_DIRNAME));
  });

  it("test_windows_uses_legacy_layout", () => {
    vi.spyOn(Platform, "detect").mockReturnValue(Platform.WINDOWS);
    expect(getBackupRoot()).toBe(path.join(isolatedHome, LEGACY_BACKUP_DIRNAME));
  });

  it("test_legacy_helper_returns_home_dot_claude_swap_backup", () => {
    expect(getLegacyBackupRoot()).toBe(path.join(isolatedHome, LEGACY_BACKUP_DIRNAME));
  });
});

describe("TestMigrateLegacyBackupDir", () => {
  const legacyDir = () => path.join(isolatedHome, LEGACY_BACKUP_DIRNAME);
  const xdgTarget = () => path.join(isolatedHome, ".local", "share", "claude-swap");

  it("test_no_legacy_is_noop", () => {
    const target = xdgTarget();
    expect(migrateLegacyBackupDir(target)).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("test_target_equals_legacy_is_noop", () => {
    const legacy = legacyDir();
    fs.mkdirSync(legacy);
    write(path.join(legacy, "marker"), "keep me");
    expect(migrateLegacyBackupDir(legacy)).toBe(false);
    expect(read(path.join(legacy, "marker"))).toBe("keep me");
  });

  it("test_moves_legacy_to_target", () => {
    const legacy = legacyDir();
    fs.mkdirSync(legacy);
    write(path.join(legacy, "sequence.json"), '{"k": 1}');
    const nested = path.join(legacy, "configs");
    fs.mkdirSync(nested);
    write(path.join(nested, "x.json"), "{}");

    const target = xdgTarget();
    expect(migrateLegacyBackupDir(target)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(read(path.join(target, "sequence.json"))).toBe('{"k": 1}');
    expect(read(path.join(target, "configs", "x.json"))).toBe("{}");
  });

  it("test_collision_raises_migration_error", () => {
    const legacy = legacyDir();
    fs.mkdirSync(legacy);
    write(path.join(legacy, "sequence.json"), '{"src": "legacy"}');

    const target = xdgTarget();
    fs.mkdirSync(target, { recursive: true });
    write(path.join(target, "sequence.json"), '{"src": "target"}');

    expect(() => migrateLegacyBackupDir(target)).toThrow(MigrationError);
    expect(() => migrateLegacyBackupDir(target)).toThrow(/Refusing to merge/);
    expect(read(path.join(legacy, "sequence.json"))).toBe('{"src": "legacy"}');
    expect(read(path.join(target, "sequence.json"))).toBe('{"src": "target"}');
  });

  it("test_target_with_only_throwaway_artifacts_is_wiped", () => {
    const legacy = legacyDir();
    fs.mkdirSync(legacy);
    write(path.join(legacy, "sequence.json"), '{"src": "legacy"}');

    const target = xdgTarget();
    fs.mkdirSync(path.join(target, "cache"), { recursive: true });
    write(path.join(target, "cache", "update_check.json"), "{}");
    write(path.join(target, "claude-swap.log"), "noise");
    write(path.join(target, "claude-swap.log.1"), "rotated");

    expect(migrateLegacyBackupDir(target)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(read(path.join(target, "sequence.json"))).toBe('{"src": "legacy"}');
    expect(fs.existsSync(path.join(target, "cache"))).toBe(false);
    expect(fs.existsSync(path.join(target, "claude-swap.log"))).toBe(false);
  });

  it("test_target_with_real_data_alongside_artifacts_still_collides", () => {
    const legacy = legacyDir();
    fs.mkdirSync(legacy);
    write(path.join(legacy, "sequence.json"), '{"src": "legacy"}');

    const target = xdgTarget();
    fs.mkdirSync(path.join(target, "cache"), { recursive: true });
    write(path.join(target, "claude-swap.log"), "noise");
    write(path.join(target, "sequence.json"), '{"src": "target"}');

    expect(() => migrateLegacyBackupDir(target)).toThrow(/Refusing to merge/);
    expect(read(path.join(legacy, "sequence.json"))).toBe('{"src": "legacy"}');
    expect(read(path.join(target, "sequence.json"))).toBe('{"src": "target"}');
  });

  it("test_resumes_after_interrupted_move", () => {
    const legacy = legacyDir();
    fs.mkdirSync(legacy);
    write(path.join(legacy, "sequence.json"), '{"src": "legacy"}');

    const target = xdgTarget();
    fs.mkdirSync(target, { recursive: true });
    write(path.join(target, "stale-partial.json"), "garbage");
    const flag = path.join(path.dirname(target), `.${path.basename(target)}.migrating`);
    write(flag, "");

    expect(migrateLegacyBackupDir(target)).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(flag)).toBe(false);
    expect(fs.existsSync(path.join(target, "stale-partial.json"))).toBe(false);
    expect(read(path.join(target, "sequence.json"))).toBe('{"src": "legacy"}');
  });

  it("test_cleans_stale_flag_after_completed_move", () => {
    const target = xdgTarget();
    fs.mkdirSync(target, { recursive: true });
    write(path.join(target, "sequence.json"), '{"complete": true}');
    const flag = path.join(path.dirname(target), `.${path.basename(target)}.migrating`);
    write(flag, "");

    expect(migrateLegacyBackupDir(target)).toBe(false);
    expect(fs.existsSync(flag)).toBe(false);
    expect(read(path.join(target, "sequence.json"))).toBe('{"complete": true}');
  });

  it("test_oserror_is_wrapped", () => {
    const legacy = legacyDir();
    fs.mkdirSync(legacy);
    write(path.join(legacy, "sequence.json"), "{}");
    const target = xdgTarget();

    vi.spyOn(internals, "move").mockImplementation(() => {
      throw Object.assign(new Error("simulated EACCES"), { code: "EACCES" });
    });

    expect(() => migrateLegacyBackupDir(target)).toThrow(MigrationError);
    expect(() => migrateLegacyBackupDir(target)).toThrow(/failed/);
    expect(read(path.join(legacy, "sequence.json"))).toBe("{}");
  });

  it.skipIf(process.platform === "win32")("test_preserves_file_modes", () => {
    const legacy = legacyDir();
    fs.mkdirSync(legacy, { mode: 0o700 });
    const cred = path.join(legacy, "credentials", ".creds-1-user@example.com.enc");
    fs.mkdirSync(path.dirname(cred), { mode: 0o700 });
    write(cred, "data");
    fs.chmodSync(cred, 0o600);

    const target = xdgTarget();
    expect(migrateLegacyBackupDir(target)).toBe(true);
    const moved = path.join(target, "credentials", ".creds-1-user@example.com.enc");
    expect(fs.statSync(moved).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(target, "credentials")).mode & 0o777).toBe(0o700);
  });
});
