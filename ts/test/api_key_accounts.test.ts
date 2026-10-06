import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_KEYCHAIN_SERVICE,
  CLAUDE_CODE_MANAGED_KEYCHAIN_SERVICE,
  approvedForm,
  looksLikeApiKey,
} from "../src/credentials.js";
import { ClaudeSwitchError, CredentialWriteError, SessionError, SwitchError, ValidationError } from "../src/exceptions.js";
import { USAGE_API_KEY, usageFields } from "../src/json_output.js";
import * as macosKeychain from "../src/macos_keychain.js";
import { Platform } from "../src/models.js";
import * as oauth from "../src/oauth.js";
import { getCredentialsPath, getGlobalConfigPath } from "../src/paths.js";
import { SessionManager, internals as sessionInternals } from "../src/session.js";
import { type AccountInfoRow, ClaudeAccountSwitcher, type SequenceData } from "../src/switcher.js";
import { exportAccounts, importAccounts } from "../src/transfer.js";
import { captureOutput } from "./helpers/capture.js";
import { testHome } from "./helpers/home.js";
import { keychainStore } from "./helpers/keychain.js";

const API_KEY = "sk-ant-api03-" + "a1b2c3d4e5".repeat(4);
const OTHER_KEY = "sk-ant-api03-" + "z9y8x7w6v5".repeat(4);
const OAUTH_JSON = JSON.stringify({ claudeAiOauth: { accessToken: "tok", refreshToken: "rtok", expiresAt: 9 } });

const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;

function withHome(home: string, fn: () => void): void {
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const saved = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    fn();
  } finally {
    [process.env.HOME, process.env.USERPROFILE] = saved;
  }
}

function linuxSwitcher(): ClaudeAccountSwitcher {
  const s = new ClaudeAccountSwitcher();
  s.platform = Platform.LINUX;
  s.setupDirectories();
  s.initSequenceFile();
  return s;
}

function macosSwitcher(): ClaudeAccountSwitcher {
  const s = new ClaudeAccountSwitcher();
  s.platform = Platform.MACOS;
  s.setupDirectories();
  s.initSequenceFile();
  return s;
}

function readGlobalConfig(): Record<string, any> {
  return JSON.parse(fs.readFileSync(getGlobalConfigPath(), "utf8"));
}

function writeLiveCredentials(text: string): void {
  fs.mkdirSync(path.dirname(getCredentialsPath()), { recursive: true });
  fs.writeFileSync(getCredentialsPath(), text);
}

/** `json.dumps(obj, indent=2)[:-cut]`: a torn JSON file. */
function torn(obj: unknown, cut: number): string {
  const text = JSON.stringify(obj, null, 2);
  return text.slice(0, text.length - cut);
}

function salvageFiles(cfg: string): string[] {
  const dir = path.dirname(cfg);
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${path.basename(cfg)}.unreadable-`))
    .sort()
    .map((name) => path.join(dir, name));
}

function seedTwo(s: ClaudeAccountSwitcher): SequenceData {
  const pairs: Array<[number, string]> = [
    [1, "a@example.com"],
    [2, "b@example.com"],
  ];
  for (const [num, email] of pairs) {
    s.writeAccountCredentials(String(num), email, OAUTH_JSON);
    s.writeAccountConfig(
      String(num),
      email,
      JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: `uuid-${num}` } }),
    );
  }
  const data: SequenceData = s.getSequenceData() ?? {
    activeAccountNumber: null,
    lastUpdated: "",
    sequence: [],
    accounts: {},
  };
  data.accounts ??= {};
  data.sequence ??= [];
  for (const [num, email] of pairs) {
    data.accounts[String(num)] = {
      email,
      uuid: `uuid-${num}`,
      organizationUuid: "",
      organizationName: "",
      added: "2024-01-01T00:00:00Z",
    };
    if (!data.sequence.includes(num)) data.sequence.push(num);
  }
  data.sequence.sort((a, b) => a - b);
  data.activeAccountNumber = 1;
  s.writeJson(s.sequenceFile, data);
  return data;
}

describe("TestKindDetection", () => {
  it("test_api_key_detected", () => {
    expect(looksLikeApiKey(API_KEY)).toBe(true);
  });

  it.each([
    "",
    null,
    "sk-ant-oat01-abcdef",
    OAUTH_JSON,
    '{"x": "sk-ant-api03-inside-json"}',
  ])("test_non_api_key", (value) => {
    expect(looksLikeApiKey(value)).toBe(false);
  });

  it("test_approved_form_is_last_20", () => {
    expect(approvedForm(API_KEY)).toBe(API_KEY.slice(-20));
    expect(approvedForm(API_KEY).length).toBe(20);
  });
});

describe("TestAddTokenApiKey", () => {
  it("test_adds_api_key_account", () => {
    const capsys = captureOutput();
    const s = linuxSwitcher();
    s.addAccountFromToken(API_KEY);

    expect(s.accountKind("1")).toBe("api_key");
    const data = s.getSequenceData()!;
    expect(data.accounts!["1"]!.email).toBe("api-key-1@token.local");
    expect(s.readAccountCredentials("1", "api-key-1@token.local")).toBe(API_KEY);
    const out = capsys.readouterr().out;
    expect(out).toContain("Added");
    expect(out).toContain("API key");
  });

  it("test_setup_token_stays_oauth", () => {
    const s = linuxSwitcher();
    s.addAccountFromToken("sk-ant-oat01-abc");
    expect(s.accountKind("1")).toBe("oauth");
    const email = s.getSequenceData()!.accounts!["1"]!.email!;
    expect(email).toBe("setup-token-1@token.local");
    const blob = JSON.parse(s.readAccountCredentials("1", email));
    expect(blob.claudeAiOauth.accessToken).toBe("sk-ant-oat01-abc");
  });

  it("test_refresh_in_place_same_api_key_account", () => {
    const s = linuxSwitcher();
    s.addAccountFromToken(API_KEY, "me@example.com");
    s.addAccountFromToken(OTHER_KEY, "me@example.com");
    const data = s.getSequenceData()!;
    expect(Object.keys(data.accounts!).length).toBe(1);
    expect(s.readAccountCredentials("1", "me@example.com")).toBe(OTHER_KEY);
  });
});

describe("TestCrossKindCollision", () => {
  it("test_api_key_rejected_when_email_is_oauth", () => {
    const s = linuxSwitcher();
    s.addAccountFromToken("sk-ant-oat01-abc", "dup@example.com");
    expect(() => s.addAccountFromToken(API_KEY, "dup@example.com")).toThrow(ValidationError);
    expect(() => s.addAccountFromToken(API_KEY, "dup@example.com")).toThrow(/already exists as an OAuth account/);
  });

  it("test_oauth_rejected_when_email_is_api_key", () => {
    const s = linuxSwitcher();
    s.addAccountFromToken(API_KEY, "dup@example.com");
    expect(() => s.addAccountFromToken("sk-ant-oat01-abc", "dup@example.com")).toThrow(ValidationError);
    expect(() => s.addAccountFromToken("sk-ant-oat01-abc", "dup@example.com")).toThrow(
      /already exists as an API-key account/,
    );
  });
});

describe("TestWriteCredentialsLinux", () => {
  it("test_activate_key_then_oauth", () => {
    const s = linuxSwitcher();
    const credFile = getCredentialsPath();
    writeLiveCredentials(OAUTH_JSON);

    s.writeCredentials(API_KEY);
    let cfg = readGlobalConfig();
    expect(cfg.primaryApiKey).toBe(API_KEY);
    expect(cfg.customApiKeyResponses.approved).toContain(API_KEY.slice(-20));
    expect(fs.existsSync(credFile)).toBe(false);

    s.writeCredentials(OAUTH_JSON);
    expect(fs.readFileSync(credFile, "utf8")).toBe(OAUTH_JSON);
    cfg = readGlobalConfig();
    expect("primaryApiKey" in cfg).toBe(false);
    expect(cfg.customApiKeyResponses.approved).toContain(API_KEY.slice(-20));
  });

  it("test_read_credentials_returns_active_key", () => {
    const s = linuxSwitcher();
    fs.writeFileSync(getGlobalConfigPath(), JSON.stringify({ primaryApiKey: API_KEY }));
    expect(s.readCredentials()).toBe(API_KEY);
  });

  it("test_oauth_file_not_misread_as_key", () => {
    const s = linuxSwitcher();
    writeLiveCredentials(OAUTH_JSON);
    fs.writeFileSync(getGlobalConfigPath(), JSON.stringify({ primaryApiKey: API_KEY }));
    expect(s.readCredentials()).toBe(OAUTH_JSON);
  });
});

describe("TestWriteCredentialsMacOS", () => {
  it("test_activate_key_uses_keychain_not_config", () => {
    const store = keychainStore();
    const s = macosSwitcher();
    const acct = macosKeychain.keychainAccountName();
    store.setPassword(CLAUDE_CODE_KEYCHAIN_SERVICE, acct, OAUTH_JSON);

    s.writeCredentials(API_KEY);

    expect(store.getPassword(CLAUDE_CODE_MANAGED_KEYCHAIN_SERVICE, acct)).toBe(API_KEY);
    expect(store.getPassword(CLAUDE_CODE_KEYCHAIN_SERVICE, acct)).toBeNull();
    const cfg = readGlobalConfig();
    expect(cfg.customApiKeyResponses.approved).toContain(API_KEY.slice(-20));
    expect("primaryApiKey" in cfg).toBe(false);
  });

  it("test_switch_back_to_oauth_clears_key", () => {
    const store = keychainStore();
    const s = macosSwitcher();
    s.writeCredentials(API_KEY);
    const acct = macosKeychain.keychainAccountName();
    expect(store.getPassword(CLAUDE_CODE_MANAGED_KEYCHAIN_SERVICE, acct)).toBe(API_KEY);

    s.writeCredentials(OAUTH_JSON);
    expect(store.getPassword(CLAUDE_CODE_MANAGED_KEYCHAIN_SERVICE, acct)).toBeNull();
    expect(store.getPassword(CLAUDE_CODE_KEYCHAIN_SERVICE, acct)).toBe(OAUTH_JSON);
    const cfg = readGlobalConfig();
    expect(cfg.customApiKeyResponses.approved).toContain(API_KEY.slice(-20));
  });

  it("test_read_credentials_from_managed_keychain", () => {
    const store = keychainStore();
    const s = macosSwitcher();
    const acct = macosKeychain.keychainAccountName();
    store.setPassword(CLAUDE_CODE_MANAGED_KEYCHAIN_SERVICE, acct, API_KEY);
    expect(s.readCredentials()).toBe(API_KEY);
  });
});

describe("TestUsageDisplay", () => {
  it("test_usage_fields_maps_api_key", () => {
    expect(usageFields(USAGE_API_KEY)).toEqual(["api_key", null]);
  });

  it("test_collect_usage_short_circuits", async () => {
    const s = linuxSwitcher();
    const info: AccountInfoRow[] = [[2, "api-key-2@token.local", "", "", false, API_KEY, ""]];
    const entries = await s.collectUsageEntries(info);
    expect(entries["2"]!.sentinel).toBe(USAGE_API_KEY);
    expect(entries["2"]!.decisionValue()).toBe(USAGE_API_KEY);
  });

  it("test_active_account_usage_short_circuits", async () => {
    const s = linuxSwitcher();
    fs.writeFileSync(getGlobalConfigPath(), JSON.stringify({ primaryApiKey: API_KEY }));
    const entry = await s.activeAccountUsage("2", "api-key-2@token.local", "");
    expect(entry.sentinel).toBe(USAGE_API_KEY);
    expect(entry.decisionValue()).toBe(USAGE_API_KEY);
  });
});

describe("TestStrategyBehaviour", () => {
  it("test_api_key_headroom_is_unknown", () => {
    expect(oauth.accountHeadroom(USAGE_API_KEY as never)).toBeNull();
  });

  it("test_best_does_not_jump_to_api_key_even_when_exhausted", async () => {
    const s = linuxSwitcher();
    s.addAccountFromToken("sk-ant-oat01-x", null, 1);
    s.addAccountFromToken(API_KEY, null, 2);
    vi.spyOn(s, "usageByAccount").mockResolvedValue({
      "1": { five_hour: { pct: 100.0 } } as oauth.UsageDict,
      "2": USAGE_API_KEY,
    });
    const [target] = await s.selectBestSwitchable("1");
    expect(target).toBeNull();
  });
});

describe("TestAddAccountGuard", () => {
  it("test_rejects_live_api_key_login", async () => {
    const s = linuxSwitcher();
    fs.writeFileSync(
      getGlobalConfigPath(),
      JSON.stringify({ oauthAccount: { emailAddress: "stale@example.com" }, primaryApiKey: API_KEY }),
    );
    await expect(s.addAccount()).rejects.toThrow(ValidationError);
    await expect(s.addAccount()).rejects.toThrow(/Active login is an API-key account/);
  });
});

describe("TestSessionGuard", () => {
  function seedApiKeyAccount(): ClaudeAccountSwitcher {
    const s = linuxSwitcher();
    s.addAccountFromToken(API_KEY, null, 2);
    return s;
  }

  it("test_setup_session_rejects", async () => {
    const mgr = new SessionManager(seedApiKeyAccount());
    const promise = mgr.setupSession("2", true);
    await expect(promise).rejects.toThrow(SessionError);
    await expect(promise).rejects.toThrow(/does not support API-key accounts/);
  });

  it("test_run_rejects_before_exec", async () => {
    const mgr = new SessionManager(seedApiKeyAccount());
    vi.spyOn(sessionInternals, "which").mockReturnValue("/fake/claude");
    const promise = mgr.run("2", [], true);
    await expect(promise).rejects.toThrow(SessionError);
    await expect(promise).rejects.toThrow(/does not support API-key accounts/);
  });
});

describe("TestExportImport", () => {
  it("test_round_trip_preserves_key_and_kind", () => {
    const srcHome = path.join(testHome(), "src");
    const out = path.join(testHome(), "b.cswap");
    withHome(srcHome, () => {
      const src = linuxSwitcher();
      src.addAccountFromToken(API_KEY, null, 1);
      exportAccounts(src, out);
      const payload = JSON.parse(fs.readFileSync(out, "utf8"));
      expect(payload.accounts[0].credentials).toBe(API_KEY);
      expect(payload.accounts[0].kind).toBe("api_key");
    });

    withHome(path.join(testHome(), "dst"), () => {
      const dst = linuxSwitcher();
      importAccounts(dst, out);
      expect(dst.accountKind("1")).toBe("api_key");
      expect(dst.readAccountCredentials("1", "api-key-1@token.local")).toBe(API_KEY);
    });
  });
});

describe("TestAnUnreadableGlobalConfigIsNotAnEmptyOne", () => {
  it("test_a_torn_config_is_not_overwritten_with_an_empty_one", () => {
    const s = linuxSwitcher();
    const cfg = getGlobalConfigPath();
    const real = {
      oauthAccount: { emailAddress: "me@example.com" },
      projects: { "/a": { allowedTools: [] } },
      mcpServers: { x: { command: "y" } },
    };
    fs.writeFileSync(cfg, torn(real, 12));
    expect(() => JSON.parse(fs.readFileSync(cfg, "utf8"))).toThrow(SyntaxError);

    expect(() =>
      s.store.updateGlobalConfig((d) => {
        d.primaryApiKey = API_KEY;
      }),
    ).toThrow(CredentialWriteError);

    expect(fs.readFileSync(cfg, "utf8")).toBe(torn(real, 12));
  });

  it("test_an_absent_config_still_writes", () => {
    const s = linuxSwitcher();
    const cfg = getGlobalConfigPath();
    fs.rmSync(cfg, { force: true });

    s.store.updateGlobalConfig((d) => {
      d.primaryApiKey = API_KEY;
    });
    expect(JSON.parse(fs.readFileSync(cfg, "utf8")).primaryApiKey).toBe(API_KEY);
  });

  it.skipIf(!canChmod)("test_clear_managed_key_does_not_silently_skip_on_unreadable_config", () => {
    const s = linuxSwitcher();
    const cfg = getGlobalConfigPath();
    fs.writeFileSync(cfg, JSON.stringify({ primaryApiKey: API_KEY }));
    const warn = vi.spyOn(s.logger, "warning");
    fs.chmodSync(cfg, 0o000);
    try {
      s.store.clearManagedKey();
    } finally {
      fs.chmodSync(cfg, 0o600);
    }

    expect(JSON.parse(fs.readFileSync(cfg, "utf8")).primaryApiKey).toBe(API_KEY);
    const messages = warn.mock.calls.map((c) => String(c[0]).toLowerCase());
    expect(messages.some((m) => m.includes("unreadable") || m.includes("could not be read"))).toBe(true);
  });

  it("test_clear_managed_key_control_absent_config_is_a_true_no_op", () => {
    const s = linuxSwitcher();
    const cfg = getGlobalConfigPath();
    fs.rmSync(cfg, { force: true });
    const warn = vi.spyOn(s.logger, "warning");

    s.store.clearManagedKey();

    expect(fs.existsSync(cfg)).toBe(false);
    const messages = warn.mock.calls.map((c) => String(c[0]).toLowerCase());
    expect(messages.some((m) => m.includes("unreadable") || m.includes("could not be read"))).toBe(false);
  });
});

describe("TestATornConfigSurvivesAnOrdinarySwitch", () => {
  const real = () => ({
    oauthAccount: { emailAddress: "a@example.com", accountUuid: "uuid-1" } as Record<string, string>,
    projects: { "/work": { allowedTools: [] } },
    mcpServers: { x: { command: "y" } },
    userID: "uid-123",
  });

  it("test_a_plain_switch_does_not_flatten_a_torn_config", async () => {
    const s = linuxSwitcher();
    seedTwo(s);
    const cfg = getGlobalConfigPath();
    fs.writeFileSync(cfg, torn(real(), 14));
    expect(() => JSON.parse(fs.readFileSync(cfg, "utf8"))).toThrow(SyntaxError);

    const tornBytes = fs.readFileSync(cfg, "utf8");
    await s.switchTo("2", true);

    const salvage = salvageFiles(cfg);
    expect(salvage.length).toBe(1);
    expect(fs.readFileSync(salvage[0]!, "utf8")).toBe(tornBytes);
  });

  it("test_config_torn_between_the_switch_start_and_step_4_survives", async () => {
    const s = linuxSwitcher();
    const data = seedTwo(s);
    const cfg = getGlobalConfigPath();
    const config = real();
    fs.writeFileSync(cfg, JSON.stringify(config));
    writeLiveCredentials(OAUTH_JSON);

    const control = (await s.switchTo("2", true))!;
    expect(control.switched).toBe(true);
    expect(control.warnings).toEqual([]);
    expect(salvageFiles(cfg)).toEqual([]);

    config.oauthAccount = { emailAddress: "a@example.com", accountUuid: "uuid-1" };
    fs.writeFileSync(cfg, JSON.stringify(config));
    data.activeAccountNumber = 1;
    s.writeJson(s.sequenceFile, data);

    const origReadJson = s.readJson.bind(s);
    let calls = 0;
    vi.spyOn(s, "readJson").mockImplementation((p, opts) => {
      if (p === cfg) {
        calls += 1;
        if (calls === 4) return null;
      }
      return origReadJson(p, opts);
    });

    const out = (await s.switchTo("2", true))!;

    expect(out.switched).toBe(true);
    expect(out.warnings?.length).toBeGreaterThan(0);
    expect(salvageFiles(cfg).length).toBe(1);
  });

  it("test_valid_empty_config_at_step_4_is_spliced_not_salvaged", async () => {
    const s = linuxSwitcher();
    seedTwo(s);
    const cfg = getGlobalConfigPath();
    fs.writeFileSync(cfg, JSON.stringify({ oauthAccount: { emailAddress: "a@example.com", accountUuid: "uuid-1" } }));
    writeLiveCredentials(OAUTH_JSON);

    const origReadJson = s.readJson.bind(s);
    let calls = 0;
    vi.spyOn(s, "readJson").mockImplementation((p, opts) => {
      if (p === cfg) {
        calls += 1;
        if (calls === 4) return {};
      }
      return origReadJson(p, opts);
    });

    const out = (await s.switchTo("2", true))!;

    expect(out.switched).toBe(true);
    expect(out.warnings).toEqual([]);
    expect(salvageFiles(cfg)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(cfg, "utf8")).oauthAccount.emailAddress).toBe("b@example.com");
  });

  it("test_a_failed_salvage_aborts_instead_of_flattening_the_config", async () => {
    const s = linuxSwitcher();
    seedTwo(s);
    const cfg = getGlobalConfigPath();
    fs.writeFileSync(cfg, torn(real(), 14));
    const tornBytes = fs.readFileSync(cfg, "utf8");

    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...rest) => {
      if (typeof file === "string" && path.basename(file).includes(".unreadable-")) {
        throw Object.assign(new Error("ENOSPC: No space left on device"), { code: "ENOSPC", errno: 28 });
      }
      return realWrite(file, ...rest);
    });

    await expect(s.switchTo("2", true)).rejects.toThrow(SwitchError);

    expect(fs.readFileSync(cfg, "utf8")).toBe(tornBytes);
  });
});

describe("TestATornRosterDoesNotDestroyBackups", () => {
  it("test_add_account_refuses_instead_of_overwriting_a_live_backup", async () => {
    const s = linuxSwitcher();
    s.writeAccountCredentials("1", "shared@example.com", OAUTH_JSON);
    const data: SequenceData = s.getSequenceData() ?? {
      activeAccountNumber: null,
      lastUpdated: "",
      sequence: [],
      accounts: {},
    };
    data.accounts ??= {};
    data.accounts["1"] = {
      email: "shared@example.com",
      uuid: "u1",
      organizationUuid: "org-A",
      organizationName: "A",
      added: "2024-01-01T00:00:00Z",
    };
    data.sequence = [1];
    data.activeAccountNumber = 1;
    s.writeJson(s.sequenceFile, data);
    const before = s.readAccountCredentials("1", "shared@example.com");
    expect(before).toBeTruthy();

    const text = fs.readFileSync(s.sequenceFile, "utf8");
    fs.writeFileSync(s.sequenceFile, text.slice(0, text.length - 12));
    expect(() => JSON.parse(fs.readFileSync(s.sequenceFile, "utf8"))).toThrow(SyntaxError);

    writeLiveCredentials(OAUTH_JSON);
    fs.writeFileSync(
      getGlobalConfigPath(),
      JSON.stringify({
        oauthAccount: { emailAddress: "shared@example.com", accountUuid: "u2", organizationUuid: "org-B" },
      }),
    );

    await expect(s.addAccount()).rejects.toThrow(ClaudeSwitchError);

    expect(s.readAccountCredentials("1", "shared@example.com")).toBe(before);
  });
});

describe("TestTheSalvageKeepsItsPromise", () => {
  function makeTorn(): string {
    const cfg = getGlobalConfigPath();
    const real = {
      oauthAccount: { emailAddress: "a@example.com", accountUuid: "uuid-1" },
      projects: { "/work": { allowedTools: [] } },
      primaryApiKey: API_KEY,
    };
    fs.writeFileSync(cfg, torn(real, 14));
    return cfg;
  }

  it.skipIf(process.platform === "win32")("test_the_salvage_does_not_widen_the_config_mode", async () => {
    const s = linuxSwitcher();
    seedTwo(s);
    const cfg = makeTorn();
    fs.chmodSync(cfg, 0o644);

    await s.switchTo("2", true);

    const salvage = salvageFiles(cfg);
    expect(salvage.length).toBe(1);
    expect(fs.readFileSync(salvage[0]!, "utf8")).toContain("sk-ant-api03-");
    expect(fs.statSync(salvage[0]!).mode & 0o777).toBe(0o600);
  });

  it("test_the_salvage_name_is_creatable_on_every_supported_platform", async () => {
    const s = linuxSwitcher();
    seedTwo(s);
    const cfg = makeTorn();

    await s.switchTo("2", true);

    const salvage = salvageFiles(cfg);
    expect(salvage.length).toBe(1);
    const bad = [...new Set(path.basename(salvage[0]!))].filter((c) => '<>:"/\\|?*'.includes(c));
    expect(bad).toEqual([]);
  });

  it("test_a_second_failure_does_not_overwrite_the_first_salvage", async () => {
    const s = linuxSwitcher();
    seedTwo(s);
    const cfg = makeTorn();
    const firstBytes = fs.readFileSync(cfg, "utf8");

    await s.switchTo("2", true);
    const second = JSON.stringify({ second: true });
    fs.writeFileSync(cfg, second.slice(0, second.length - 2));
    await s.switchTo("1", true);

    const salvage = salvageFiles(cfg);
    expect(salvage.length).toBe(2);
    expect(salvage.some((q) => fs.readFileSync(q, "utf8") === firstBytes)).toBe(true);
  });

  it("test_human_mode_is_told_the_config_was_salvaged", async () => {
    const capsys = captureOutput();
    const s = linuxSwitcher();
    seedTwo(s);
    makeTorn();

    await s.switchTo("2");
    const out = capsys.readouterr();
    expect(out.out + out.err).toContain("could not be parsed");
  });
});

describe("TestADeniedKeychainSurvivesAnUnreadableFallbackFile", () => {
  it.skipIf(!canChmod)("test_the_keychain_verdict_is_not_dropped_by_an_unreadable_file", () => {
    const s = macosSwitcher();
    const store = s.store;
    const credFile = getCredentialsPath();
    fs.writeFileSync(credFile, OAUTH_JSON);

    vi.spyOn(store, "useKeychain").mockReturnValue(true);
    vi.spyOn(store, "readActiveOauthKeychain").mockReturnValue([null, true]);
    vi.spyOn(store, "readManagedKey").mockReturnValue("");
    // The Python test patches Path.read_text to raise PermissionError. A mode of 000 gives the same EACCES.
    fs.chmodSync(credFile, 0o000);
    let ac;
    try {
      ac = store.readActiveCredentials();
    } finally {
      fs.chmodSync(credFile, 0o600);
    }
    expect(ac.value).toBeNull();
    expect(ac.degraded).toBe(true);
    expect(ac.keychainUnavailable).toBe(true);
  });
});
