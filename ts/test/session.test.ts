import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { internals as claudeLocks } from "../src/claude_locks.js";
import { CLAUDE_CODE_MANAGED_KEYCHAIN_SERVICE } from "../src/credentials.js";
import { AccountNotFoundError, CredentialReadError, SessionError, SwitchError, ValidationError } from "../src/exceptions.js";
import { getLogger, Handler, type LogRecord, ERROR, WARNING, DEBUG } from "../src/logging_config.js";
import * as macosKeychain from "../src/macos_keychain.js";
import { Platform } from "../src/models.js";
import { refreshOutcome, type RefreshOutcome, usageOutcome } from "../src/oauth.js";
import { getGlobalConfigPath } from "../src/paths.js";
import type { ClaudeSession } from "../src/process_detection.js";
import {
  internals,
  isSessionStale,
  keychainAccountName,
  keychainServiceName,
  markSessionStale,
  MCP_DISPLACED_STASH,
  MCP_MIRROR_MARKER,
  probeEnv,
  profileIsQuiescent,
  readSessionCredentials,
  readSessionIdentity,
  scanLiveSessions,
  SessionManager,
  type SessionHost,
  type SpawnResult,
  sessionDirFor,
  sessionIdentityDrifted,
  SHARE_MANIFEST,
  slugifyEmail,
  STALE_MARKER,
  staleMarkerFor,
  STRICT_KEYCHAIN_ATTEMPTS,
} from "../src/session.js";
import { atomicWriteJson } from "../src/settings.js";
import { ClaudeAccountSwitcher, internals as switcherInternals } from "../src/switcher.js";
import { resolvePath } from "../src/support/pathlib.js";
import { jsonDumps } from "../src/support/py.js";
import { testHome } from "./helpers/home.js";
import { keychainStore } from "./helpers/keychain.js";

const ACCOUNT_EMAIL = "account2@example.com";
const ACCOUNT_NUM = "2";
const ORG_UUID = "org-uuid-2";

const CREDS = jsonDumps({ claudeAiOauth: { accessToken: "stored-access", refreshToken: "stored-refresh", expiresAt: 1 } });
const ROTATED_CREDS = jsonDumps({
  claudeAiOauth: { accessToken: "fresh-access", refreshToken: "rotated-refresh", expiresAt: 9999999999999 },
});
const CONFIG = jsonDumps({
  oauthAccount: { emailAddress: ACCOUNT_EMAIL, accountUuid: "uuid-2", organizationUuid: ORG_UUID },
  theme: "light",
});

const realInternals = { ...internals };
const realLockTimeout = claudeLocks.DEFAULT_TIMEOUT_S;

afterEach(() => {
  Object.assign(internals, realInternals);
  claudeLocks.DEFAULT_TIMEOUT_S = realLockTimeout;
});

// Helpers

/** A new empty directory for the test, like the pytest `tmp_path` fixture. */
function tmpPath(): string {
  return fs.mkdtempSync(path.join(testHome(), "tmp-"));
}

/** Force `Platform.detect()` to MACOS so the Keychain paths run on any host. */
function macosPlatform(): void {
  vi.spyOn(Platform, "detect").mockReturnValue(Platform.MACOS);
}

function readText(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function writeText(file: string, text: string): void {
  fs.writeFileSync(file, text, "utf8");
}

function touch(file: string): void {
  fs.closeSync(fs.openSync(file, "a"));
}

function capsys(): { readouterr: () => { out: string; err: string } } {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  });
  return {
    readouterr: () => {
      const result = { out, err };
      out = "";
      err = "";
      return result;
    },
  };
}

class CaptureHandler extends Handler {
  readonly records: LogRecord[] = [];

  protected emit(record: LogRecord): void {
    this.records.push(record);
  }
}

/** The equivalent of `caplog.at_level(level, logger="claude-swap")` for the rest of the test. */
function captureLogs(level = WARNING): LogRecord[] {
  const logger = getLogger("claude-swap");
  const previous = logger.level;
  const handler = new CaptureHandler();
  logger.addHandler(handler);
  logger.setLevel(level);
  onTestFinished(() => {
    logger.removeHandler(handler);
    logger.setLevel(previous);
  });
  return handler.records;
}

function unsupported(): never {
  throw new Error("needs switcher: the stub host does not implement this member");
}

/**
 * A `SessionHost` with only the data members (`backupDir`, `lockFile`,
 * `platform`, `logger`). The sharing, validation and exec tests use the
 * switcher only for these members.
 */
function stubHost(): SessionHost {
  const backupDir = path.join(testHome(), ".claude-swap-backup");
  return {
    backupDir,
    lockFile: path.join(backupDir, ".lock"),
    platform: Platform.detect(),
    logger: getLogger("claude-swap"),
    resolveAccount: unsupported,
    getCurrentAccount: unsupported,
    accountKind: unsupported,
    readAccountCredentials: unsupported,
    readAccountCredentialsEx: unsupported,
    readAccountConfig: unsupported,
    consumeBackupGrant: unsupported,
    invalidateSessionCredentials: unsupported,
  };
}

/** The `manager` fixture for the tests that need only the data members of the switcher. */
function stubManager(): SessionManager {
  macosPlatform();
  return new SessionManager(stubHost());
}

function probeResult(payload: unknown, status = 0): SpawnResult {
  return { status, stdout: JSON.stringify(payload) };
}

function timeoutResult(): SpawnResult {
  return { status: null, error: Object.assign(new Error("spawnSync claude ETIMEDOUT"), { code: "ETIMEDOUT" }) };
}

/**
 * Fake `claude auth status --json`: logged in if the profile has a seed.
 * Reads CLAUDE_CONFIG_DIR from the probe env, and records every probe env.
 */
function authStatusTracksSeed(): Array<NodeJS.ProcessEnv> {
  const probeEnvs: Array<NodeJS.ProcessEnv> = [];
  vi.spyOn(internals, "spawnSync").mockImplementation((_cmd, _args, options) => {
    const env = options.env ?? {};
    probeEnvs.push(env);
    const configDir = env.CLAUDE_CONFIG_DIR ?? "";
    const payload = fs.existsSync(path.join(configDir, ".credentials.json"))
      ? { loggedIn: true, authMethod: "claude.ai", email: ACCOUNT_EMAIL, orgId: ORG_UUID }
      : { loggedIn: false, authMethod: "none" };
    return probeResult(payload);
  });
  return probeEnvs;
}

/** Simulate a live claude in a profile. The pid of this process is always alive. */
function makeLive(sessionDir: string, pid?: number): void {
  const pidValue = pid ?? process.pid;
  const pidDir = path.join(sessionDir, "sessions");
  fs.mkdirSync(pidDir, { recursive: true });
  writeText(path.join(pidDir, `${pidValue}.json`), JSON.stringify({ pid: pidValue }));
}

/** Plant a stale marker, in the current (sibling) or the old (child) location. */
function markStale(sessionDir: string, legacyLocation = false): void {
  if (legacyLocation) touch(path.join(sessionDir, STALE_MARKER));
  else markSessionStale(sessionDir);
}

class ExecCalled extends Error {
  constructor(
    readonly binary: string,
    readonly argv: string[],
    readonly env: Record<string, string>,
  ) {
    super("exec called");
  }
}

class SystemExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/** Replace the exec handoff at the `exec()` seam, and make `which` find a fake claude. */
function captureExec(): void {
  vi.spyOn(SessionManager.prototype, "exec").mockImplementation((claudeBin, claudeArgs, env) => {
    throw new ExecCalled(claudeBin, [claudeBin, ...claudeArgs], env);
  });
  vi.spyOn(internals, "which").mockImplementation((name) => `/fake/bin/${name}`);
}

function catchExec(fn: () => unknown): ExecCalled {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExecCalled) return e;
    throw e;
  }
  throw new Error("exec was not called");
}

async function catchExecAsync(promise: Promise<unknown>): Promise<ExecCalled> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof ExecCalled) return e;
    throw e;
  }
  throw new Error("exec was not called");
}


type TestSwitcher = ClaudeAccountSwitcher;

async function newSwitcher(options: { debug?: boolean } = {}): Promise<TestSwitcher> {
  return new ClaudeAccountSwitcher(options.debug ?? false);
}

/** A switcher with account 2 fully backed up (creds, config and sequence). */
async function seededSwitcher(): Promise<TestSwitcher> {
  macosPlatform();
  const switcher = await newSwitcher({ debug: true });
  switcher.setupDirectories();
  switcher.writeJson(switcher.sequenceFile, {
    activeAccountNumber: 1,
    lastUpdated: "2024-01-01T00:00:00Z",
    sequence: [1, 2],
    accounts: {
      "1": {
        email: "account1@example.com",
        uuid: "uuid-1",
        organizationUuid: "org-uuid-1",
        organizationName: "Org One",
        added: "2024-01-01T00:00:00Z",
      },
      [ACCOUNT_NUM]: {
        email: ACCOUNT_EMAIL,
        uuid: "uuid-2",
        organizationUuid: ORG_UUID,
        organizationName: "Org Two",
        added: "2024-01-02T00:00:00Z",
      },
    },
  });
  switcher.writeAccountCredentials(ACCOUNT_NUM, ACCOUNT_EMAIL, CREDS);
  switcher.writeAccountConfig(ACCOUNT_NUM, ACCOUNT_EMAIL, CONFIG);
  return switcher;
}

/** The consume gate persists ROTATED_CREDS like the real one. Returns the snapshots that it got. */
function refreshRotates(switcher: TestSwitcher): string[] {
  const calls: string[] = [];
  vi.spyOn(switcher, "consumeBackupGrant").mockImplementation(async (accountNum, email, snapshot) => {
    calls.push(snapshot);
    switcher.writeAccountCredentials(accountNum, email, ROTATED_CREDS);
    return refreshOutcome(ROTATED_CREDS, null);
  });
  return calls;
}

function stubGate(switcher: TestSwitcher, fn: (num: string, email: string, snapshot: string) => RefreshOutcome): void {
  vi.spyOn(switcher, "consumeBackupGrant").mockImplementation(async (num, email, snapshot) => fn(num, email, snapshot));
}


// Pure helpers

describe("TestHelpers", () => {
  it("test_slugify_plain", () => {
    expect(slugifyEmail("user@example.com")).toBe("user_example.com");
  });

  it("test_slugify_plus_tag", () => {
    expect(slugifyEmail("user+tag@example.com")).toBe("user_tag_example.com");
  });

  it("test_slugify_unicode", () => {
    const slug = slugifyEmail("bø@x.com");
    expect(slug).toBe("b__x.com");
    expect(/^[\x00-\x7f]*$/.test(slug)).toBe(true);
  });

  it("test_slugify_windows_illegal", () => {
    const slug = slugifyEmail('a<>:"/\\|?*b@x.com');
    expect([...'<>:"/\\|?*'].some((c) => slug.includes(c))).toBe(false);
  });

  it("test_session_dir_naming", () => {
    const tmp = tmpPath();
    expect(sessionDirFor(tmp, "2", "user@example.com")).toBe(path.join(tmp, "sessions", "2-user_example.com"));
  });

  it("test_keychain_service_name_known_vector", () => {
    const d = path.join(tmpPath(), "profile");
    const expected = createHash("sha256").update(d.normalize("NFC")).digest("hex").slice(0, 8);
    expect(keychainServiceName(d)).toBe(`Claude Code-credentials-${expected}`);
  });

  it("test_keychain_service_name_nfc_nfd_equal", () => {
    const nfc = "/tmp/sé".normalize("NFC");
    const nfd = "/tmp/sé".normalize("NFD");
    expect(nfc).not.toBe(nfd);
    expect(keychainServiceName(nfc)).toBe(keychainServiceName(nfd));
  });

  it("test_probe_env_drops_auth_overrides", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-key");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-tok");
    const tmp = tmpPath();
    const env = probeEnv(tmp);
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
    expect("CLAUDE_CODE_OAUTH_TOKEN" in env).toBe(false);
    expect(env.CLAUDE_CONFIG_DIR).toBe(tmp);
  });

  it("test_scan_live_sessions_missing_dir", () => {
    expect(scanLiveSessions(path.join(tmpPath(), "nope"))).toEqual([[], 0]);
  });

  it("test_scan_live_sessions_dead_pid_ignored", () => {
    const tmp = tmpPath();
    makeLive(tmp, 2 ** 22 + 12345);
    expect(scanLiveSessions(tmp)).toEqual([[], 0]);
  });

  it("test_scan_live_sessions_own_pid", () => {
    const tmp = tmpPath();
    makeLive(tmp);
    const [sessions, unreadable] = scanLiveSessions(tmp);
    expect(sessions.map((s) => s.pid)).toEqual([process.pid]);
    expect(unreadable).toBe(0);
  });

  it("test_unreadable_record_is_not_quiescent", () => {
    const tmp = tmpPath();
    fs.mkdirSync(path.join(tmp, "sessions"), { recursive: true });
    writeText(path.join(tmp, "sessions", "9999.json"), "not json{{{");

    expect(scanLiveSessions(tmp)).toEqual([[], 1]);
    expect(profileIsQuiescent(tmp)).toBe(false);
  });

  it("test_dead_pid_is_quiescent", () => {
    const tmp = tmpPath();
    makeLive(tmp, 2 ** 22 + 12345);
    expect(profileIsQuiescent(tmp)).toBe(true);
  });
});

describe("TestSessionIdentity", () => {
  function writeIdentity(sessionDir: string, email: string, orgUuid: string | null = null): void {
    fs.mkdirSync(sessionDir, { recursive: true });
    writeText(
      path.join(sessionDir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid: orgUuid } }),
    );
  }

  it("test_reads_email_and_org", () => {
    const tmp = tmpPath();
    writeIdentity(tmp, "a@x.com", "org-A");
    expect(readSessionIdentity(tmp)).toEqual(["a@x.com", "org-A"]);
  });

  it("test_missing_org_reads_as_empty", () => {
    const tmp = tmpPath();
    writeIdentity(tmp, "a@x.com", null);
    expect(readSessionIdentity(tmp)).toEqual(["a@x.com", ""]);
  });

  it("test_unreadable_variants_return_none", () => {
    const tmp = tmpPath();
    expect(readSessionIdentity(path.join(tmp, "nope"))).toBeNull();
    writeText(path.join(tmp, ".claude.json"), "{not json");
    expect(readSessionIdentity(tmp)).toBeNull();
    fs.writeFileSync(path.join(tmp, ".claude.json"), Buffer.from([0xff, 0xfe, 0x7b, 0x7d]));
    expect(readSessionIdentity(tmp)).toBeNull();
    writeText(path.join(tmp, ".claude.json"), JSON.stringify({ oauthAccount: {} }));
    expect(readSessionIdentity(tmp)).toBeNull();
  });

  it("test_different_email_is_drift", () => {
    const tmp = tmpPath();
    writeIdentity(tmp, "other@x.com", "org-A");
    expect(sessionIdentityDrifted(tmp, "a@x.com", "org-A")).toBe(true);
  });

  it("test_same_email_different_org_is_drift", () => {
    const tmp = tmpPath();
    writeIdentity(tmp, "a@x.com", "org-B");
    expect(sessionIdentityDrifted(tmp, "a@x.com", "org-A")).toBe(true);
  });

  it("test_matching_identity_is_not_drift", () => {
    const tmp = tmpPath();
    writeIdentity(tmp, "a@x.com", "org-A");
    expect(sessionIdentityDrifted(tmp, "a@x.com", "org-A")).toBe(false);
  });

  it("test_org_check_is_lenient_when_either_side_empty", () => {
    const tmp = tmpPath();
    writeIdentity(tmp, "a@x.com", null);
    expect(sessionIdentityDrifted(tmp, "a@x.com", "org-A")).toBe(false);
    writeIdentity(tmp, "a@x.com", "org-B");
    expect(sessionIdentityDrifted(tmp, "a@x.com", "")).toBe(false);
  });

  it("test_unreadable_identity_is_not_drift", () => {
    const tmp = tmpPath();
    expect(sessionIdentityDrifted(path.join(tmp, "nope"), "a@x.com", "org-A")).toBe(false);
    fs.writeFileSync(path.join(tmp, ".claude.json"), Buffer.from([0xff, 0xfe, 0x7b, 0x7d]));
    expect(sessionIdentityDrifted(tmp, "a@x.com", "org-A")).toBe(false);
  });
});

// resolveAccount accessor

describe("TestResolveAccount", () => {
  it("test_by_number", async () => {
    const sw = await seededSwitcher();
    expect(sw.resolveAccount("2")).toEqual([ACCOUNT_NUM, ACCOUNT_EMAIL, ORG_UUID]);
  });

  it("test_by_email", async () => {
    const sw = await seededSwitcher();
    const [num, email] = sw.resolveAccount(ACCOUNT_EMAIL);
    expect([num, email]).toEqual([ACCOUNT_NUM, ACCOUNT_EMAIL]);
  });

  it("test_unknown", async () => {
    const sw = await seededSwitcher();
    expect(() => sw.resolveAccount("9")).toThrow(AccountNotFoundError);
  });

  it("test_unknown_email", async () => {
    const sw = await seededSwitcher();
    expect(() => sw.resolveAccount("nobody@example.com")).toThrow(AccountNotFoundError);
  });
});

// bootstrap

describe("TestBootstrap", () => {
  it("test_happy_path", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    authStatusTracksSeed();
    refreshRotates(sw);

    const [sessionDir, num, email] = await manager.setupSession("2", false);

    expect([num, email]).toEqual([ACCOUNT_NUM, ACCOUNT_EMAIL]);
    expect(readText(path.join(sessionDir, ".credentials.json"))).toBe(ROTATED_CREDS);
    const config = JSON.parse(readText(path.join(sessionDir, ".claude.json")));
    expect(config.oauthAccount.emailAddress).toBe(ACCOUNT_EMAIL);
    expect(config.hasCompletedOnboarding).toBe(true);
    expect(config.theme).toBe("light");
    expect(sw.readAccountCredentials(ACCOUNT_NUM, ACCOUNT_EMAIL)).toBe(ROTATED_CREDS);
  });

  (process.platform === "win32" ? it.skip : it)("test_profile_permissions", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    authStatusTracksSeed();
    refreshRotates(sw);

    const [sessionDir] = await manager.setupSession("2", false);
    expect(fs.statSync(sessionDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(sessionDir, ".credentials.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(sessionDir, ".claude.json")).mode & 0o777).toBe(0o600);
  });

  it("test_reuse_skips_refresh_and_writes", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    authStatusTracksSeed();
    const calls = refreshRotates(sw);

    const [sessionDir] = await manager.setupSession("2", false);
    const firstCreds = readText(path.join(sessionDir, ".credentials.json"));
    const refreshCallsAfterBootstrap = calls.length;

    const [sessionDir2] = await manager.setupSession("2", false);

    expect(sessionDir2).toBe(sessionDir);
    expect(calls.length).toBe(refreshCallsAfterBootstrap);
    expect(readText(path.join(sessionDir, ".credentials.json"))).toBe(firstCreds);
  });

  it("test_refresh_failure_uses_stored_creds", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    authStatusTracksSeed();
    const cap = capsys();
    stubGate(sw, () => refreshOutcome(null, "transient"));

    const [sessionDir] = await manager.setupSession("2", false);
    expect(readText(path.join(sessionDir, ".credentials.json"))).toBe(CREDS);
    expect(cap.readouterr().out).toContain("Could not refresh");
  });

  it("test_setup_token_account_skips_refresh_silently", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    authStatusTracksSeed();
    const cap = capsys();
    const tokenCreds = jsonDumps({ claudeAiOauth: { accessToken: "sk-ant-oat01-x", expiresAt: 0 } });
    sw.writeAccountCredentials(ACCOUNT_NUM, ACCOUNT_EMAIL, tokenCreds);
    const refreshCalls: string[] = [];
    stubGate(sw, (_num, _email, snapshot) => {
      refreshCalls.push(snapshot);
      return refreshOutcome(null, "transient");
    });

    const [sessionDir] = await manager.setupSession("2", false);

    expect(refreshCalls).toEqual([]);
    expect(cap.readouterr().out).not.toContain("Could not refresh");
    expect(readText(path.join(sessionDir, ".credentials.json"))).toBe(tokenCreds);
  });

  it("test_missing_credentials", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    authStatusTracksSeed();
    sw.deleteAccountCredentials(ACCOUNT_NUM, ACCOUNT_EMAIL);
    await expect(manager.setupSession("2", false)).rejects.toThrow(/no stored credentials/);
  });

  it("test_missing_config", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    authStatusTracksSeed();
    refreshRotates(sw);
    fs.unlinkSync(path.join(sw.configsDir, `.claude-config-${ACCOUNT_NUM}-${ACCOUNT_EMAIL}.json`));
    await expect(manager.setupSession("2", false)).rejects.toThrow(/no stored config backup/);
  });

  it("test_validation_failure_cleans_up", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    refreshRotates(sw);
    vi.spyOn(internals, "spawnSync").mockImplementation(() => probeResult({ loggedIn: false, authMethod: "none" }));
    const sessionDir = sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL);
    const service = keychainServiceName(sessionDir);
    const account = keychainAccountName();
    keychainStore().setPassword(service, account, "stale");

    await expect(manager.setupSession("2", false)).rejects.toThrow(/failed\s+validation/);

    expect(fs.existsSync(sessionDir)).toBe(false);
    expect(keychainStore().getPassword(service, account)).toBeNull();
  });

  it("test_stale_keychain_entry_deleted_before_seed", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    authStatusTracksSeed();
    refreshRotates(sw);
    const sessionDir = sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL);
    const service = keychainServiceName(sessionDir);
    const account = keychainAccountName();
    keychainStore().setPassword(service, account, "stale");

    await manager.setupSession("2", false);

    expect(keychainStore().getPassword(service, account)).toBeNull();
  });

  it.each([false, true])(
    "test_stale_marker_forces_rebootstrap_after_session_exits[%s]",
    async (legacyLocation) => {
        const sw = await seededSwitcher();
      const manager = new SessionManager(sw);
      authStatusTracksSeed();
      refreshRotates(sw);
      const [sessionDir] = await manager.setupSession("2", false);
      writeText(path.join(sessionDir, ".credentials.json"), "stale lineage");
      markStale(sessionDir, legacyLocation);

      await manager.setupSession("2", false);

      expect(readText(path.join(sessionDir, ".credentials.json"))).toBe(ROTATED_CREDS);
      expect(isSessionStale(sessionDir)).toBe(false);
    },
  );

  it("test_stale_marker_plus_probe_timeout_still_rebootstraps", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    authStatusTracksSeed();
    refreshRotates(sw);
    const [sessionDir] = await manager.setupSession("2", false);
    touch(path.join(sessionDir, STALE_MARKER));
    vi.spyOn(internals, "spawnSync").mockImplementation(timeoutResult);

    await manager.setupSession("2", false);

    expect(readText(path.join(sessionDir, ".credentials.json"))).toBe(ROTATED_CREDS);
    expect(fs.existsSync(path.join(sessionDir, STALE_MARKER))).toBe(false);
  });

  it.each([false, true])(
    "test_stale_marker_preserved_while_session_still_live[%s]",
    async (legacyLocation) => {
        const sw = await seededSwitcher();
      const manager = new SessionManager(sw);
      authStatusTracksSeed();
      refreshRotates(sw);
      const [sessionDir] = await manager.setupSession("2", false);
      writeText(path.join(sessionDir, ".credentials.json"), "live lineage");
      markStale(sessionDir, legacyLocation);
      makeLive(sessionDir);

      await manager.setupSession("2", false);

      expect(readText(path.join(sessionDir, ".credentials.json"))).toBe("live lineage");
      expect(isSessionStale(sessionDir)).toBe(true);
    },
  );

  it("test_rebootstrap_preserves_profile_history", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    authStatusTracksSeed();
    refreshRotates(sw);
    const [sessionDir] = await manager.setupSession("2", false);
    const config = JSON.parse(readText(path.join(sessionDir, ".claude.json")));
    config.projects = { "/some/project": { history: ["x"] } };
    writeText(path.join(sessionDir, ".claude.json"), JSON.stringify(config));
    fs.unlinkSync(path.join(sessionDir, ".credentials.json"));

    await manager.setupSession("2", false);

    const merged = JSON.parse(readText(path.join(sessionDir, ".claude.json")));
    expect(merged.projects).toEqual({ "/some/project": { history: ["x"] } });
    expect(merged.oauthAccount.emailAddress).toBe(ACCOUNT_EMAIL);
  });
});

// validation strictness

describe("TestIsSessionValid", () => {
  let manager: SessionManager;
  let tmp: string;
  let validPayload: Record<string, unknown>;

  beforeEach(() => {
    manager = stubManager();
    tmp = tmpPath();
    validPayload = { loggedIn: true, authMethod: "claude.ai", email: ACCOUNT_EMAIL, orgId: ORG_UUID };
  });

  function check(payload: unknown, rc = 0): boolean {
    fs.mkdirSync(tmp, { recursive: true });
    vi.spyOn(internals, "spawnSync").mockImplementation(() => probeResult(payload, rc));
    return manager.isSessionValid(tmp, ACCOUNT_EMAIL, ORG_UUID);
  }

  /** The local files of a bootstrapped profile: creds and identity. */
  function seedProfile(sessionDir: string, email = ACCOUNT_EMAIL, org = ORG_UUID): void {
    writeText(path.join(sessionDir, ".credentials.json"), "{}");
    writeText(
      path.join(sessionDir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid: org } }),
    );
  }

  function probeTimesOut(): void {
    vi.spyOn(internals, "spawnSync").mockImplementation(timeoutResult);
  }

  it("test_valid", () => {
    expect(check(validPayload)).toBe(true);
  });

  it("test_rejects_api_key_auth", () => {
    validPayload.authMethod = "apiKey";
    expect(check(validPayload)).toBe(false);
  });

  it("test_rejects_wrong_email", () => {
    validPayload.email = "other@example.com";
    expect(check(validPayload)).toBe(false);
  });

  it("test_rejects_wrong_org", () => {
    validPayload.orgId = "different-org";
    expect(check(validPayload)).toBe(false);
  });

  it("test_lenient_when_org_absent", () => {
    delete validPayload.orgId;
    expect(check(validPayload)).toBe(true);
  });

  it("test_rejects_nonzero_exit", () => {
    expect(check(validPayload, 1)).toBe(false);
  });

  it("test_rejects_missing_dir", () => {
    expect(manager.isSessionValid(path.join(tmp, "missing"), ACCOUNT_EMAIL, ORG_UUID)).toBe(false);
  });

  it("test_probe_timeout_leans_valid", () => {
    seedProfile(tmp);
    probeTimesOut();
    expect(manager.isSessionValid(tmp, ACCOUNT_EMAIL, ORG_UUID)).toBe(true);
  });

  it("test_probe_timeout_needs_credential_material", () => {
    seedProfile(tmp);
    fs.unlinkSync(path.join(tmp, ".credentials.json"));
    probeTimesOut();
    expect(manager.isSessionValid(tmp, ACCOUNT_EMAIL, ORG_UUID)).toBe(false);
  });

  it("test_probe_timeout_accepts_keychain_only_credentials", () => {
    seedProfile(tmp);
    fs.unlinkSync(path.join(tmp, ".credentials.json"));
    keychainStore().setPassword(keychainServiceName(tmp), keychainAccountName(), "migrated material");
    probeTimesOut();
    expect(manager.isSessionValid(tmp, ACCOUNT_EMAIL, ORG_UUID)).toBe(true);
  });

  it("test_probe_timeout_with_unreadable_keychain_leans_valid", () => {
    seedProfile(tmp);
    fs.unlinkSync(path.join(tmp, ".credentials.json"));
    macosKeychain.internals.getPassword = () => {
      throw new macosKeychain.KeychainError("keychain locked");
    };
    probeTimesOut();
    expect(manager.isSessionValid(tmp, ACCOUNT_EMAIL, ORG_UUID)).toBe(true);
  });

  it("test_probe_timeout_rejects_empty_credential_file", () => {
    seedProfile(tmp);
    writeText(path.join(tmp, ".credentials.json"), "");
    probeTimesOut();
    expect(manager.isSessionValid(tmp, ACCOUNT_EMAIL, ORG_UUID)).toBe(false);
  });

  it("test_probe_timeout_still_rejects_drifted_identity", () => {
    seedProfile(tmp, "other@example.com");
    probeTimesOut();
    expect(manager.isSessionValid(tmp, ACCOUNT_EMAIL, ORG_UUID)).toBe(false);
  });

  it("test_probe_timeout_lenient_on_unreadable_identity", () => {
    seedProfile(tmp);
    writeText(path.join(tmp, ".claude.json"), "not json");
    probeTimesOut();
    expect(manager.isSessionValid(tmp, ACCOUNT_EMAIL, ORG_UUID)).toBe(true);
  });

  it("test_probe_oserror_stays_invalid", () => {
    vi.spyOn(internals, "spawnSync").mockImplementation(() => {
      throw new Error("spawn failed");
    });
    expect(manager.isSessionValid(tmp, ACCOUNT_EMAIL, ORG_UUID)).toBe(false);
  });

  it("test_invokes_pathext_resolved_launcher", () => {
    const resolved = "/fake/bin/claude.CMD";
    vi.spyOn(internals, "which").mockReturnValue(resolved);
    const seenArgv: string[][] = [];
    vi.spyOn(internals, "spawnSync").mockImplementation((cmd, args) => {
      seenArgv.push([cmd, ...args]);
      return probeResult(validPayload);
    });
    expect(manager.isSessionValid(tmp, ACCOUNT_EMAIL, ORG_UUID)).toBe(true);
    expect(seenArgv[0]?.[0]).toBe(resolved);
  });
});

// sharing

/** Source items in ~/.claude and a session dir that exists. */
function shareSetup(): [string, string, SessionManager] {
  const mgr = stubManager();
  const source = path.join(testHome(), ".claude");
  writeText(path.join(source, "settings.json"), "{}");
  writeText(path.join(source, "CLAUDE.md"), "# memory");
  fs.mkdirSync(path.join(source, "skills"));
  writeText(path.join(source, "skills", "a.md"), "skill");

  const sessionDir = sessionDirFor(mgr.switcher.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL);
  fs.mkdirSync(sessionDir, { recursive: true });
  return [source, sessionDir, mgr];
}

function manifestOf(sessionDir: string): { items: string[]; mode: string } {
  return JSON.parse(readText(path.join(sessionDir, SHARE_MANIFEST)));
}

const isSymlink = (p: string): boolean => fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;

describe.skipIf(process.platform === "win32")("TestSharingPosix", () => {
  it("test_links_existing_sources_only", () => {
    const [, sessionDir, mgr] = shareSetup();
    mgr.syncSharing(sessionDir, true);

    expect(isSymlink(path.join(sessionDir, "settings.json"))).toBe(true);
    expect(isSymlink(path.join(sessionDir, "CLAUDE.md"))).toBe(true);
    expect(isSymlink(path.join(sessionDir, "skills"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "keybindings.json"))).toBe(false);
    const manifest = manifestOf(sessionDir);
    expect(new Set(manifest.items)).toEqual(new Set(["settings.json", "CLAUDE.md", "skills"]));
    expect(manifest.mode).toBe("symlink");
  });

  it("test_idempotent", () => {
    const [source, sessionDir, mgr] = shareSetup();
    mgr.syncSharing(sessionDir, true);
    mgr.syncSharing(sessionDir, true);
    expect(fs.readlinkSync(path.join(sessionDir, "settings.json"))).toBe(path.join(source, "settings.json"));
  });

  it("test_prunes_when_source_vanishes", () => {
    const [source, sessionDir, mgr] = shareSetup();
    mgr.syncSharing(sessionDir, true);
    fs.unlinkSync(path.join(source, "CLAUDE.md"));
    mgr.syncSharing(sessionDir, true);

    expect(isSymlink(path.join(sessionDir, "CLAUDE.md"))).toBe(false);
    expect(manifestOf(sessionDir).items).not.toContain("CLAUDE.md");
  });

  it("test_never_touches_user_data", () => {
    const [, sessionDir, mgr] = shareSetup();
    const cap = capsys();
    writeText(path.join(sessionDir, "CLAUDE.md"), "session-private memory");

    mgr.syncSharing(sessionDir, true);

    expect(isSymlink(path.join(sessionDir, "CLAUDE.md"))).toBe(false);
    expect(readText(path.join(sessionDir, "CLAUDE.md"))).toBe("session-private memory");
    expect(cap.readouterr().out).toContain("Not sharing CLAUDE.md");
    expect(manifestOf(sessionDir).items).not.toContain("CLAUDE.md");
  });

  it("test_no_share_removes_only_managed", () => {
    const [, sessionDir, mgr] = shareSetup();
    writeText(path.join(sessionDir, "private.txt"), "keep me");
    mgr.syncSharing(sessionDir, true);

    mgr.syncSharing(sessionDir, false);

    expect(fs.existsSync(path.join(sessionDir, "settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, "skills"))).toBe(false);
    expect(readText(path.join(sessionDir, "private.txt"))).toBe("keep me");
    expect(fs.existsSync(path.join(sessionDir, SHARE_MANIFEST))).toBe(false);
  });

  it("test_repoints_stale_link", () => {
    const [source, sessionDir, mgr] = shareSetup();
    const elsewhere = path.join(testHome(), "elsewhere.json");
    writeText(elsewhere, "{}");
    fs.symlinkSync(elsewhere, path.join(sessionDir, "settings.json"));

    mgr.syncSharing(sessionDir, true);

    expect(fs.readlinkSync(path.join(sessionDir, "settings.json"))).toBe(path.join(source, "settings.json"));
  });

  it("test_links_to_resolved_target_when_source_is_symlink", () => {
    const [source, sessionDir, mgr] = shareSetup();
    const dotfiles = path.join(testHome(), "dotfiles");
    fs.mkdirSync(dotfiles);
    const real = path.join(dotfiles, "settings.json");
    writeText(real, '{"real": true}');
    const link = path.join(source, "settings.json");
    fs.unlinkSync(link);
    fs.symlinkSync(real, link);

    mgr.syncSharing(sessionDir, true);

    expect(fs.readlinkSync(path.join(sessionDir, "settings.json"))).toBe(resolvePath(real));
  });

  it("test_repoints_existing_link_to_resolved_target", () => {
    const [source, sessionDir, mgr] = shareSetup();
    const dotfiles = path.join(testHome(), "dotfiles");
    fs.mkdirSync(dotfiles);
    const real = path.join(dotfiles, "settings.json");
    writeText(real, "{}");
    const link = path.join(source, "settings.json");
    fs.unlinkSync(link);
    fs.symlinkSync(real, link);
    fs.symlinkSync(link, path.join(sessionDir, "settings.json"));

    mgr.syncSharing(sessionDir, true);

    expect(fs.readlinkSync(path.join(sessionDir, "settings.json"))).toBe(resolvePath(real));
  });
});

describe("TestSharingWindowsMode", () => {
  function windowsMgr(): [string, string, SessionManager] {
    const [source, sessionDir, mgr] = shareSetup();
    mgr.switcher.platform = Platform.WINDOWS;
    return [source, sessionDir, mgr];
  }

  it("test_copies_instead_of_links", () => {
    const [, sessionDir, mgr] = windowsMgr();
    mgr.syncSharing(sessionDir, true);

    expect(fs.statSync(path.join(sessionDir, "settings.json")).isFile()).toBe(true);
    expect(isSymlink(path.join(sessionDir, "settings.json"))).toBe(false);
    expect(readText(path.join(sessionDir, "skills", "a.md"))).toBe("skill");
    expect(manifestOf(sessionDir).mode).toBe("copy");
  });

  it("test_resync_overwrites_managed_copies", () => {
    const [source, sessionDir, mgr] = windowsMgr();
    mgr.syncSharing(sessionDir, true);
    writeText(path.join(source, "settings.json"), '{"changed": true}');

    mgr.syncSharing(sessionDir, true);

    expect(readText(path.join(sessionDir, "settings.json"))).toBe('{"changed": true}');
  });

  it("test_no_share_removes_copies", () => {
    const [, sessionDir, mgr] = windowsMgr();
    mgr.syncSharing(sessionDir, true);
    mgr.syncSharing(sessionDir, false);

    expect(fs.existsSync(path.join(sessionDir, "settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, "skills"))).toBe(false);
  });
});

// mcpServers mirror (issue #139)

const GITHUB_MCP = { type: "stdio", command: "gh-mcp", env: { TOKEN: "abc" } };
const LOCAL_MCP = { type: "stdio", command: "mine" };

/** A fake live default config and a session profile with its own config. */
function mcpSetup(): [string, string, SessionManager] {
  const mgr = stubManager();
  const defaultConfig = path.join(testHome(), ".claude.json");
  writeText(
    defaultConfig,
    JSON.stringify({
      oauthAccount: { emailAddress: "default@example.com" },
      mcpServers: { github: GITHUB_MCP },
      projects: { "/repo": { mcpServers: { "proj-local": {} } } },
    }),
  );
  const sessionDir = sessionDirFor(mgr.switcher.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL);
  fs.mkdirSync(sessionDir, { recursive: true });
  writeText(
    path.join(sessionDir, ".claude.json"),
    JSON.stringify({
      oauthAccount: { emailAddress: ACCOUNT_EMAIL },
      theme: "light",
      projects: { "/w": { allowedTools: [] } },
    }),
  );
  return [defaultConfig, sessionDir, mgr];
}

function sessionConfig(sessionDir: string): Record<string, any> {
  return JSON.parse(readText(path.join(sessionDir, ".claude.json")));
}

function writeSessionConfig(sessionDir: string, config: unknown): void {
  writeText(path.join(sessionDir, ".claude.json"), JSON.stringify(config));
}

function setDefaultMcp(defaultConfig: string, servers: Record<string, unknown> | null): void {
  const data = JSON.parse(readText(defaultConfig));
  if (servers === null) delete data.mcpServers;
  else data.mcpServers = servers;
  writeText(defaultConfig, JSON.stringify(data));
}

describe("TestMcpMirror", () => {
  it("test_bootstrap_launch_mirrors", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    authStatusTracksSeed();
    refreshRotates(sw);
    writeText(path.join(testHome(), ".claude.json"), JSON.stringify({ mcpServers: { github: GITHUB_MCP } }));
    const [sessionDir] = await manager.setupSession("2", true);

    const config = sessionConfig(sessionDir);
    expect(config.mcpServers).toEqual({ github: GITHUB_MCP });
    expect(config.oauthAccount.emailAddress).toBe(ACCOUNT_EMAIL);
    expect(fs.existsSync(path.join(sessionDir, MCP_MIRROR_MARKER))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, MCP_DISPLACED_STASH))).toBe(false);
  });

  it("test_mirror_preserves_other_keys", () => {
    const [, sessionDir, mgr] = mcpSetup();
    mgr.syncSharing(sessionDir, true);

    const config = sessionConfig(sessionDir);
    expect(config.mcpServers).toEqual({ github: GITHUB_MCP });
    expect(config.oauthAccount.emailAddress).toBe(ACCOUNT_EMAIL);
    expect(config.theme).toBe("light");
    expect(config.projects).toEqual({ "/w": { allowedTools: [] } });
  });

  it("test_edit_and_delete_propagate", () => {
    const [defaultConfig, sessionDir, mgr] = mcpSetup();
    mgr.syncSharing(sessionDir, true);

    const edited = { github: { ...GITHUB_MCP, env: { TOKEN: "rotated" } }, new: {} };
    setDefaultMcp(defaultConfig, edited);
    mgr.syncSharing(sessionDir, true);
    expect(sessionConfig(sessionDir).mcpServers).toEqual(edited);

    setDefaultMcp(defaultConfig, { new: {} });
    mgr.syncSharing(sessionDir, true);
    expect(sessionConfig(sessionDir).mcpServers).toEqual({ new: {} });
  });

  it("test_default_without_key_removes_key", () => {
    const [defaultConfig, sessionDir, mgr] = mcpSetup();
    mgr.syncSharing(sessionDir, true);
    setDefaultMcp(defaultConfig, null);

    mgr.syncSharing(sessionDir, true);

    expect("mcpServers" in sessionConfig(sessionDir)).toBe(false);
  });

  it("test_legacy_config_json_source", () => {
    const [, sessionDir, mgr] = mcpSetup();
    writeText(path.join(testHome(), ".claude", ".config.json"), JSON.stringify({ mcpServers: { "legacy-src": {} } }));

    mgr.syncSharing(sessionDir, true);

    expect(sessionConfig(sessionDir).mcpServers).toEqual({ "legacy-src": {} });
  });

  it("test_session_local_change_reset_without_stash", () => {
    const [, sessionDir, mgr] = mcpSetup();
    mgr.syncSharing(sessionDir, true);

    const config = sessionConfig(sessionDir);
    config.mcpServers.mine = LOCAL_MCP;
    writeSessionConfig(sessionDir, config);
    mgr.syncSharing(sessionDir, true);

    expect(sessionConfig(sessionDir).mcpServers).toEqual({ github: GITHUB_MCP });
    expect(fs.existsSync(path.join(sessionDir, MCP_DISPLACED_STASH))).toBe(false);
  });

  it("test_migration_stashes_displaced_only", () => {
    const [, sessionDir, mgr] = mcpSetup();
    const cap = capsys();
    const config = sessionConfig(sessionDir);
    config.mcpServers = { "pre-feature": LOCAL_MCP, github: GITHUB_MCP };
    writeSessionConfig(sessionDir, config);

    mgr.syncSharing(sessionDir, true);

    expect(sessionConfig(sessionDir).mcpServers).toEqual({ github: GITHUB_MCP });
    const stash = JSON.parse(readText(path.join(sessionDir, MCP_DISPLACED_STASH)));
    expect(stash).toEqual({ schemaVersion: 1, mcpServers: { "pre-feature": LOCAL_MCP } });
    expect(cap.readouterr().out).toContain("saved to");
    expect(fs.existsSync(path.join(sessionDir, MCP_MIRROR_MARKER))).toBe(true);
  });

  it("test_stash_is_write_once", () => {
    const [, sessionDir, mgr] = mcpSetup();
    const stashPath = path.join(sessionDir, MCP_DISPLACED_STASH);
    const original = { schemaVersion: 1, mcpServers: { "real-pre-feature": {} } };
    writeText(stashPath, JSON.stringify(original));
    const config = sessionConfig(sessionDir);
    config.mcpServers = { drift: {} };
    writeSessionConfig(sessionDir, config);

    mgr.syncSharing(sessionDir, true);

    expect(sessionConfig(sessionDir).mcpServers).toEqual({ github: GITHUB_MCP });
    expect(JSON.parse(readText(stashPath))).toEqual(original);
  });

  it("test_invalid_stash_blocks_reset", () => {
    const [, sessionDir, mgr] = mcpSetup();
    fs.mkdirSync(path.join(sessionDir, MCP_DISPLACED_STASH));
    const config = sessionConfig(sessionDir);
    config.mcpServers = { "pre-feature": LOCAL_MCP };
    writeSessionConfig(sessionDir, config);

    mgr.syncSharing(sessionDir, true);

    expect(sessionConfig(sessionDir).mcpServers).toEqual({ "pre-feature": LOCAL_MCP });
    expect(fs.existsSync(path.join(sessionDir, MCP_MIRROR_MARKER))).toBe(false);
  });

  it("test_null_valued_entry_is_stashed", () => {
    const [, sessionDir, mgr] = mcpSetup();
    const config = sessionConfig(sessionDir);
    config.mcpServers = { weird: null, github: GITHUB_MCP };
    writeSessionConfig(sessionDir, config);

    mgr.syncSharing(sessionDir, true);

    const stash = JSON.parse(readText(path.join(sessionDir, MCP_DISPLACED_STASH)));
    expect(stash.mcpServers).toEqual({ weird: null });
    expect(sessionConfig(sessionDir).mcpServers).toEqual({ github: GITHUB_MCP });
  });

  it("test_stash_failure_aborts_reset", () => {
    const [, sessionDir, mgr] = mcpSetup();
    const config = sessionConfig(sessionDir);
    config.mcpServers = { "pre-feature": LOCAL_MCP };
    writeSessionConfig(sessionDir, config);
    vi.spyOn(internals, "atomicWriteJson").mockImplementation((file, data) => {
      if (path.basename(file) === MCP_DISPLACED_STASH) {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      atomicWriteJson(file, data);
    });

    mgr.syncSharing(sessionDir, true);

    expect(sessionConfig(sessionDir).mcpServers).toEqual({ "pre-feature": LOCAL_MCP });
    expect(fs.existsSync(path.join(sessionDir, MCP_MIRROR_MARKER))).toBe(false);
  });

  it("test_in_sync_first_run_adopts_without_write", () => {
    const [, sessionDir, mgr] = mcpSetup();
    const configPath = path.join(sessionDir, ".claude.json");
    const config = sessionConfig(sessionDir);
    config.mcpServers = { github: GITHUB_MCP };
    writeText(configPath, JSON.stringify(config));
    const before = fs.readFileSync(configPath);

    mgr.syncSharing(sessionDir, true);

    expect(fs.readFileSync(configPath)).toEqual(before);
    expect(fs.existsSync(path.join(sessionDir, ".claude.json.lock"))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, MCP_MIRROR_MARKER))).toBe(true);
  });

  it("test_adopted_in_sync_run_takes_no_lock", () => {
    const [, sessionDir, mgr] = mcpSetup();
    mgr.syncSharing(sessionDir, true);

    vi.spyOn(internals, "properLockfile").mockImplementation(() => {
      throw new Error("lock taken on the adopted in-sync path");
    });
    mgr.syncSharing(sessionDir, true);
  });

  it.each(["missing", "corrupt", "non_dict_root", "non_dict_key", "binary"])(
    "test_fail_open_on_bad_source[%s]",
    (sourceState) => {
      const [defaultConfig, sessionDir, mgr] = mcpSetup();
      if (sourceState === "missing") fs.unlinkSync(defaultConfig);
      else if (sourceState === "corrupt") writeText(defaultConfig, "{not json");
      else if (sourceState === "non_dict_root") writeText(defaultConfig, "[]");
      else if (sourceState === "non_dict_key") writeText(defaultConfig, JSON.stringify({ mcpServers: ["bad"] }));
      else fs.writeFileSync(defaultConfig, Buffer.from("\xff\xfe not utf-8 \x00", "latin1"));
      const before = fs.readFileSync(path.join(sessionDir, ".claude.json"));

      mgr.syncSharing(sessionDir, true);

      expect(fs.readFileSync(path.join(sessionDir, ".claude.json"))).toEqual(before);
      expect(fs.existsSync(path.join(sessionDir, MCP_MIRROR_MARKER))).toBe(false);
    },
  );

  it.each(["null", "[]", '"a-string"'])("test_fail_open_on_bad_target_mcp[%s]", (badValue) => {
    const [, sessionDir, mgr] = mcpSetup();
    const config = sessionConfig(sessionDir);
    config.mcpServers = JSON.parse(badValue);
    writeSessionConfig(sessionDir, config);
    const before = fs.readFileSync(path.join(sessionDir, ".claude.json"));

    mgr.syncSharing(sessionDir, true);

    expect(fs.readFileSync(path.join(sessionDir, ".claude.json"))).toEqual(before);
    expect(fs.existsSync(path.join(sessionDir, MCP_MIRROR_MARKER))).toBe(false);
  });

  it("test_corrupt_session_config_skipped", () => {
    const [, sessionDir, mgr] = mcpSetup();
    writeText(path.join(sessionDir, ".claude.json"), "{broken");

    mgr.syncSharing(sessionDir, true);

    expect(readText(path.join(sessionDir, ".claude.json"))).toBe("{broken");
    expect(fs.existsSync(path.join(sessionDir, MCP_MIRROR_MARKER))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("test_symlinked_session_config_skipped", () => {
    const [, sessionDir, mgr] = mcpSetup();
    const elsewhere = path.join(testHome(), "elsewhere.json");
    fs.renameSync(path.join(sessionDir, ".claude.json"), elsewhere);
    fs.symlinkSync(elsewhere, path.join(sessionDir, ".claude.json"));
    const before = fs.readFileSync(elsewhere);

    mgr.syncSharing(sessionDir, true);

    expect(isSymlink(path.join(sessionDir, ".claude.json"))).toBe(true);
    expect(fs.readFileSync(elsewhere)).toEqual(before);
  });

  it("test_held_lock_fails_open", () => {
    claudeLocks.DEFAULT_TIMEOUT_S = 0.3;
    const [, sessionDir, mgr] = mcpSetup();
    fs.mkdirSync(path.join(sessionDir, ".claude.json.lock"));
    const before = fs.readFileSync(path.join(sessionDir, ".claude.json"));

    mgr.syncSharing(sessionDir, true);

    expect(fs.readFileSync(path.join(sessionDir, ".claude.json"))).toEqual(before);
  });

  it("test_no_share_before_adoption_untouched", () => {
    const [, sessionDir, mgr] = mcpSetup();
    const config = sessionConfig(sessionDir);
    config.mcpServers = { "pre-feature": LOCAL_MCP };
    writeSessionConfig(sessionDir, config);

    mgr.syncSharing(sessionDir, false);

    expect(sessionConfig(sessionDir).mcpServers).toEqual({ "pre-feature": LOCAL_MCP });
  });

  it("test_no_share_after_adoption_removes_then_restores", () => {
    const [, sessionDir, mgr] = mcpSetup();
    mgr.syncSharing(sessionDir, true);

    mgr.syncSharing(sessionDir, false);
    const config = sessionConfig(sessionDir);
    expect("mcpServers" in config).toBe(false);
    expect(config.oauthAccount.emailAddress).toBe(ACCOUNT_EMAIL);
    expect(fs.existsSync(path.join(sessionDir, MCP_MIRROR_MARKER))).toBe(true);

    mgr.syncSharing(sessionDir, true);
    expect(sessionConfig(sessionDir).mcpServers).toEqual({ github: GITHUB_MCP });
  });
});

// run() and the exec handoff

describe("TestRun", () => {
  it("test_claude_not_on_path", async () => {
    const manager = stubManager();
    vi.spyOn(internals, "which").mockReturnValue(null);
    await expect(manager.run("2", [])).rejects.toThrow(/not found on PATH/);
  });

  it("test_exec_env_and_forwarded_args", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    captureExec();
    authStatusTracksSeed();
    refreshRotates(sw);

    const call = await catchExecAsync(manager.run("2", ["--resume", "--model", "x"]));

    expect(call.binary).toBe("/fake/bin/claude");
    expect(call.argv).toEqual(["/fake/bin/claude", "--resume", "--model", "x"]);
    expect(call.env.CLAUDE_CONFIG_DIR).toBe(sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL));
  });

  it("test_fast_path_for_active_account", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    captureExec();
    const cap = capsys();
    vi.spyOn(sw, "getCurrentAccount").mockReturnValue([ACCOUNT_EMAIL, ORG_UUID]);

    const call = await catchExecAsync(manager.run("2", []));

    expect("CLAUDE_CONFIG_DIR" in call.env).toBe(false);
    expect(cap.readouterr().out).toContain("already the active default login");
  });

  it("test_require_session_refuses_fast_path", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    captureExec();
    vi.spyOn(sw, "getCurrentAccount").mockReturnValue([ACCOUNT_EMAIL, ORG_UUID]);

    await expect(manager.run("2", [], true, false, true)).rejects.toThrow(/active default login/);
  });

  it("test_require_session_is_inert_off_the_active_account", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    captureExec();
    authStatusTracksSeed();
    refreshRotates(sw);

    const call = await catchExecAsync(manager.run("2", [], true, false, true));

    expect(call.env.CLAUDE_CONFIG_DIR).toBe(sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL));
  });

  it("test_preset_config_dir_disables_fast_path", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    captureExec();
    authStatusTracksSeed();
    refreshRotates(sw);
    const cap = capsys();
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/somewhere/else");
    vi.spyOn(sw, "getCurrentAccount").mockReturnValue([ACCOUNT_EMAIL, ORG_UUID]);

    const call = await catchExecAsync(manager.run("2", []));

    expect(call.env.CLAUDE_CONFIG_DIR).toBe(sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL));
    expect(cap.readouterr().out).toContain("overriding it for this launch");
  });

  it("test_auth_override_vars_scrubbed_from_session_env", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    captureExec();
    authStatusTracksSeed();
    refreshRotates(sw);
    const cap = capsys();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-key");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "tok");
    vi.stubEnv("UNRELATED_VAR", "kept");

    const call = await catchExecAsync(manager.run("2", []));

    expect(cap.readouterr().out).toContain("Ignoring ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN");
    expect("ANTHROPIC_API_KEY" in call.env).toBe(false);
    expect("ANTHROPIC_AUTH_TOKEN" in call.env).toBe(false);
    expect(call.env.UNRELATED_VAR).toBe("kept");
  });

  it("test_fast_path_keeps_env_untouched", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    captureExec();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-key");
    vi.spyOn(sw, "getCurrentAccount").mockReturnValue([ACCOUNT_EMAIL, ORG_UUID]);

    const call = await catchExecAsync(manager.run("2", []));

    expect(call.env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
  });

  it("test_exec_default_uses_plain_env", () => {
    const manager = stubManager();
    captureExec();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-key");

    const call = catchExec(() => manager.execDefault(["--resume"]));

    expect(call.binary).toBe("/fake/bin/claude");
    expect(call.argv).toEqual(["/fake/bin/claude", "--resume"]);
    expect(call.env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
  });

  it("test_exec_default_claude_not_on_path", () => {
    const manager = stubManager();
    vi.spyOn(internals, "which").mockReturnValue(null);
    expect(() => manager.execDefault([])).toThrow(/not found on PATH/);
  });
});

describe("TestExec", () => {
  it("test_posix_replaces_process_with_execvpe", () => {
    const manager = stubManager();
    vi.spyOn(internals, "sysPlatform").mockReturnValue("linux");
    vi.spyOn(internals, "execve").mockImplementation((binary, argv, env) => {
      throw new ExecCalled(binary, argv, env);
    });

    const call = catchExec(() => manager.exec("/bin/claude", ["--resume"], { A: "B" }));

    expect([call.binary, call.argv, call.env]).toEqual(["/bin/claude", ["/bin/claude", "--resume"], { A: "B" }]);
  });

  it("test_windows_runs_subprocess_and_mirrors_exit_code", () => {
    const manager = stubManager();
    const seen: unknown[] = [];
    vi.spyOn(internals, "sysPlatform").mockReturnValue("win32");
    vi.spyOn(internals, "spawnSync").mockImplementation((cmd, args, options) => {
      seen.push([[cmd, ...args], options.env]);
      return { status: 7 };
    });
    vi.spyOn(internals, "exit").mockImplementation((code) => {
      throw new SystemExit(code);
    });

    let exit: SystemExit | undefined;
    try {
      manager.exec("/bin/claude", ["--resume"], { A: "B" });
    } catch (e) {
      if (!(e instanceof SystemExit)) throw e;
      exit = e;
    }
    expect(exit?.code).toBe(7);
    expect(seen[0]).toEqual([["/bin/claude", "--resume"], { A: "B" }]);
  });
});

// switcher guards

const posixNonRoot = process.platform !== "win32" && process.getuid?.() !== 0;

describe("TestGuards", () => {
  it("test_remove_account_refused_while_live", async () => {
    const sw = await seededSwitcher();
    makeLive(sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL));
    vi.spyOn(switcherInternals, "input").mockImplementation(() => {
      throw new Error("prompt must not be reached");
    });
    await expect(Promise.resolve().then(() => sw.removeAccount(ACCOUNT_NUM))).rejects.toThrow(/live session-mode/);
    expect(sw.readAccountCredentials(ACCOUNT_NUM, ACCOUNT_EMAIL)).toBeTruthy();
  });

  it("test_remove_account_cleans_session_profile", async () => {
    const sw = await seededSwitcher();
    const sessionDir = sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL);
    fs.mkdirSync(sessionDir, { recursive: true });
    const service = keychainServiceName(sessionDir);
    const account = keychainAccountName();
    keychainStore().setPassword(service, account, "creds");

    vi.spyOn(switcherInternals, "input").mockReturnValue("y");
    await sw.removeAccount(ACCOUNT_NUM);

    expect(fs.existsSync(sessionDir)).toBe(false);
    expect(keychainStore().getPassword(service, account)).toBeNull();
  });

  it("test_remove_account_assume_yes_skips_prompt", async () => {
    const sw = await seededSwitcher();
    vi.spyOn(switcherInternals, "input").mockImplementation(() => {
      throw new Error("prompt must not be reached");
    });
    sw.removeAccount(ACCOUNT_NUM, true);
    expect(sw.getSequenceData()?.accounts).not.toHaveProperty(ACCOUNT_NUM);
  });

  it("test_delete_account_files_chokepoint_refuses_live", async () => {
    const sw = await seededSwitcher();
    makeLive(sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL));
    await expect(Promise.resolve().then(() => sw.deleteAccountFiles(ACCOUNT_NUM, ACCOUNT_EMAIL))).rejects.toThrow(
      /live session-mode/,
    );
  });

  it("test_purge_refused_while_live", async () => {
    const sw = await seededSwitcher();
    makeLive(sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL));
    vi.spyOn(switcherInternals, "input").mockImplementation(() => {
      throw new Error("prompt must not be reached");
    });
    await expect(Promise.resolve().then(() => sw.purge())).rejects.toThrow(/Exit them first/);
    expect(fs.existsSync(sw.backupDir)).toBe(true);
  });

  it("test_purge_sweeps_session_keychain_entries", async () => {
    const sw = await seededSwitcher();
    const sessionDir = sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL);
    fs.mkdirSync(sessionDir, { recursive: true });
    const service = keychainServiceName(sessionDir);
    const account = keychainAccountName();
    keychainStore().setPassword(service, account, "creds");

    vi.spyOn(switcherInternals, "input").mockReturnValue("y");
    await sw.purge();

    expect(keychainStore().getPassword(service, account)).toBeNull();
    expect(fs.existsSync(sw.backupDir)).toBe(false);
  });

  it("test_switch_warns_on_live_target_but_completes", async () => {
    const sw = await seededSwitcher();
    const cap = capsys();
    makeLive(sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL));
    vi.spyOn(sw, "getCurrentAccount").mockReturnValue(null);
    vi.spyOn(sw, "listAccounts").mockResolvedValue(null);

    await sw.performSwitch(ACCOUNT_NUM);

    expect(cap.readouterr().out).toContain("live session-mode");
    expect(sw.getSequenceData()?.activeAccountNumber).toBe(Number(ACCOUNT_NUM));
  });

  it("test_switch_refuses_live_target_whose_profile_is_ahead", async () => {
    const sw = await seededSwitcher();
    const sessionDir = sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL);
    fs.mkdirSync(sessionDir, { recursive: true });
    writeText(path.join(sessionDir, ".credentials.json"), ROTATED_CREDS);
    writeText(path.join(sessionDir, ".claude.json"), CONFIG);
    makeLive(sessionDir);
    vi.spyOn(sw, "getCurrentAccount").mockReturnValue(null);

    await expect(Promise.resolve().then(() => sw.performSwitch(ACCOUNT_NUM))).rejects.toThrow(SwitchError);
    await expect(Promise.resolve().then(() => sw.performSwitch(ACCOUNT_NUM))).rejects.toThrow(
      /rotated past the stored backup/,
    );

    expect(sw.getSequenceData()?.activeAccountNumber).toBe(1);
    expect(sw.readAccountCredentials(ACCOUNT_NUM, ACCOUNT_EMAIL)).toBe(CREDS);
  });

  it("test_switch_adopts_exited_session_credential_first", async () => {
    const sw = await seededSwitcher();
    const sessionDir = sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL);
    fs.mkdirSync(sessionDir, { recursive: true });
    writeText(path.join(sessionDir, ".credentials.json"), ROTATED_CREDS);
    writeText(path.join(sessionDir, ".claude.json"), CONFIG);
    vi.spyOn(sw, "getCurrentAccount").mockReturnValue(null);
    vi.spyOn(sw, "listAccounts").mockResolvedValue(null);

    await sw.performSwitch(ACCOUNT_NUM);

    expect(sw.readAccountCredentials(ACCOUNT_NUM, ACCOUNT_EMAIL)).toBe(ROTATED_CREDS);
    expect(sw.readCredentials()).toBe(ROTATED_CREDS);
    expect(readText(path.join(sessionDir, ".credentials.json"))).toBe(ROTATED_CREDS);
  });

  it("test_backup_credential_write_invalidates_stale_profile", async () => {
    const sw = await seededSwitcher();
    const sessionDir = sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL);
    fs.mkdirSync(sessionDir, { recursive: true });
    writeText(path.join(sessionDir, ".credentials.json"), "stale");
    writeText(path.join(sessionDir, ".claude.json"), '{"projects": {}}');
    const service = keychainServiceName(sessionDir);
    const account = keychainAccountName();
    keychainStore().setPassword(service, account, "stale");

    sw.writeAccountCredentials(ACCOUNT_NUM, ACCOUNT_EMAIL, ROTATED_CREDS);

    expect(fs.existsSync(path.join(sessionDir, ".credentials.json"))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, ".claude.json"))).toBe(true);
    expect(keychainStore().getPassword(service, account)).toBeNull();
  });

  it.each([
    ["profile_dir_present", true],
    ["profile_dir_already_gone", false],
  ])("test_deleting_a_profile_takes_its_stale_marker_with_it[%s]", async (_id, dirStillThere) => {
    const sw = await seededSwitcher();
    const sessionDir = sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL);
    fs.mkdirSync(sessionDir, { recursive: true });
    markSessionStale(sessionDir);
    expect(isSessionStale(sessionDir), "premise: marked").toBe(true);
    if (!dirStillThere) {
      fs.rmSync(sessionDir, { recursive: true });
      expect(isSessionStale(sessionDir), "premise: the marker outlives the dir purge removed").toBe(true);
    }

    await sw.deleteSessionProfile(ACCOUNT_NUM, ACCOUNT_EMAIL);

    expect(fs.existsSync(sessionDir), "premise: the profile is gone").toBe(false);
    expect(isSessionStale(sessionDir), "the marker outlived the profile").toBe(false);
  });

  (posixNonRoot ? it : it.skip).each([
    ["denied_with_legacy_marker", "child", "legacy"],
    ["denied_no_marker", "child", null],
    ["writable_with_marker", null, "legacy"],
    ["denied_parent_with_sibling_marker", "parent", "sibling"],
    ["denied_parent_no_marker", "parent", null],
  ] as const)(
    "test_delete_session_profile_survives_a_denied_dir_with_legacy_marker[%s]",
    async (_id, deny, marker) => {
        const sw = await seededSwitcher();
      const sessionDir = sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL);
      fs.mkdirSync(sessionDir, { recursive: true });
      writeText(path.join(sessionDir, "x.txt"), "keep");
      if (marker === "legacy") touch(path.join(sessionDir, STALE_MARKER));
      else if (marker === "sibling") touch(staleMarkerFor(sessionDir));
      const deniedDir = deny === "child" ? sessionDir : path.dirname(sessionDir);
      if (deny) fs.chmodSync(deniedDir, 0o500);
      const records = captureLogs(DEBUG);

      try {
        await sw.deleteSessionProfile(ACCOUNT_NUM, ACCOUNT_EMAIL);
      } finally {
        if (deny) {
          try {
            fs.chmodSync(deniedDir, 0o700);
          } catch {
            // The directory is already gone.
          }
        }
      }

      const leftovers = [sessionDir, staleMarkerFor(sessionDir), path.join(sessionDir, STALE_MARKER)].filter((p) =>
        fs.existsSync(p),
      );
      const warned = records.filter((r) => r.levelno >= WARNING);
      expect(leftovers.length === 0 || warned.length > 0, `reported removal while ${leftovers} survived`).toBe(true);
    },
  );

  (posixNonRoot ? it : it.skip).each([true, false])(
    "test_backup_credential_write_leaves_live_profile_alone_but_marks_stale[%s]",
    async (markerLands) => {
        const sw = await seededSwitcher();
      const sessionDir = sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL);
      makeLive(sessionDir);
      writeText(path.join(sessionDir, ".credentials.json"), "live session creds");

      if (!markerLands) fs.chmodSync(path.dirname(sessionDir), 0o500);
      const records = captureLogs(WARNING);
      try {
        sw.writeAccountCredentials(ACCOUNT_NUM, ACCOUNT_EMAIL, ROTATED_CREDS);
      } finally {
        if (!markerLands) fs.chmodSync(path.dirname(sessionDir), 0o700);
      }

      expect(readText(path.join(sessionDir, ".credentials.json"))).toBe("live session creds");
      if (markerLands) {
        expect(isSessionStale(sessionDir)).toBe(true);
        expect(records.some((r) => r.levelno >= ERROR)).toBe(false);
      } else {
        expect(isSessionStale(sessionDir), "premise: the marker's own write target was denied").toBe(false);
        expect(records.some((r) => r.levelno >= ERROR && r.message.includes(ACCOUNT_NUM))).toBe(true);
      }
    },
  );

  it("test_list_skips_refresh_for_live_session_accounts", async () => {
    const sw = await seededSwitcher();
    const sessionDir = sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL);
    sw.writeAccountCredentials(ACCOUNT_NUM, ACCOUNT_EMAIL, ROTATED_CREDS);
    makeLive(sessionDir);
    const seen: Record<string, boolean> = {};
    vi.spyOn(switcherInternals, "tryFetchUsageForAccount").mockImplementation(async (num, _email, _creds, isActive) => {
      seen[num] = isActive;
      return usageOutcome(null);
    });

    await sw.listAccounts();

    expect(seen[ACCOUNT_NUM]).toBe(true);
    expect([undefined, false]).toContain(seen["1"]);
  });

  it("test_invalidate_session_credentials_keeps_history", async () => {
    const sw = await seededSwitcher();
    const sessionDir = sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL);
    fs.mkdirSync(sessionDir, { recursive: true });
    writeText(path.join(sessionDir, ".credentials.json"), "old creds");
    writeText(path.join(sessionDir, ".claude.json"), '{"projects": {}}');
    const service = keychainServiceName(sessionDir);
    const account = keychainAccountName();
    keychainStore().setPassword(service, account, "creds");

    sw.invalidateSessionCredentials(ACCOUNT_NUM, ACCOUNT_EMAIL);

    expect(fs.existsSync(path.join(sessionDir, ".credentials.json"))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, ".claude.json"))).toBe(true);
    expect(keychainStore().getPassword(service, account)).toBeNull();
  });
});

// history sharing (--share-history)

/** `shareSetup` plus conversation history on both sides. */
function historySetup(): [string, string, SessionManager] {
  const [source, sessionDir, mgr] = shareSetup();
  fs.mkdirSync(path.join(source, "projects", "-home-user-app"), { recursive: true });
  writeText(path.join(source, "projects", "-home-user-app", "aaa.jsonl"), "main-a\n");
  writeText(path.join(source, "history.jsonl"), '{"p": "main"}\n');
  return [source, sessionDir, mgr];
}

const modeOf = (p: string): number => fs.statSync(p).mode & 0o777;

describe.skipIf(process.platform === "win32")("TestShareHistoryPosix", () => {
  it("test_not_shared_by_default", () => {
    const [, sessionDir, mgr] = historySetup();
    mgr.syncSharing(sessionDir, true);

    expect(fs.existsSync(path.join(sessionDir, "projects"))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, "history.jsonl"))).toBe(false);
    expect(manifestOf(sessionDir).items).not.toContain("projects");
  });

  it("test_links_history_items", () => {
    const [source, sessionDir, mgr] = historySetup();
    mgr.syncSharing(sessionDir, true, true);

    expect(fs.readlinkSync(path.join(sessionDir, "projects"))).toBe(path.join(source, "projects"));
    expect(fs.readlinkSync(path.join(sessionDir, "history.jsonl"))).toBe(path.join(source, "history.jsonl"));
    expect(manifestOf(sessionDir).items).toEqual(expect.arrayContaining(["projects", "history.jsonl"]));
  });

  it("test_creates_missing_source", () => {
    const [source, sessionDir, mgr] = shareSetup();
    mgr.syncSharing(sessionDir, true, true);

    expect(fs.statSync(path.join(source, "projects")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(source, "history.jsonl")).isFile()).toBe(true);
    expect(fs.readlinkSync(path.join(sessionDir, "projects"))).toBe(path.join(source, "projects"));
  });

  it("test_merges_existing_profile_history", () => {
    const [source, sessionDir, mgr] = historySetup();
    const proj = path.join(sessionDir, "projects", "-home-user-app");
    fs.mkdirSync(proj, { recursive: true });
    writeText(path.join(proj, "bbb.jsonl"), "profile-b\n");
    fs.mkdirSync(path.join(sessionDir, "projects", "-home-user-other"));
    writeText(path.join(sessionDir, "projects", "-home-user-other", "ccc.jsonl"), "profile-c\n");
    writeText(path.join(sessionDir, "history.jsonl"), '{"p": "main"}\n{"p": "profile"}\n');

    mgr.syncSharing(sessionDir, true, true);

    const merged = path.join(source, "projects");
    expect(readText(path.join(merged, "-home-user-app", "aaa.jsonl"))).toBe("main-a\n");
    expect(readText(path.join(merged, "-home-user-app", "bbb.jsonl"))).toBe("profile-b\n");
    expect(readText(path.join(merged, "-home-user-other", "ccc.jsonl"))).toBe("profile-c\n");
    expect(fs.readlinkSync(path.join(sessionDir, "history.jsonl"))).toBe(path.join(source, "history.jsonl"));
    const lines = readText(path.join(source, "history.jsonl")).split("\n").filter(Boolean);
    expect(lines.filter((l) => l === '{"p": "main"}').length).toBe(1);
    expect(lines).toContain('{"p": "profile"}');
    expect(fs.readlinkSync(path.join(sessionDir, "projects"))).toBe(merged);
  });

  it("test_merge_collision_keeps_target", () => {
    const [source, sessionDir, mgr] = historySetup();
    const proj = path.join(sessionDir, "projects", "-home-user-app");
    fs.mkdirSync(proj, { recursive: true });
    writeText(path.join(proj, "aaa.jsonl"), "profile-duplicate\n");

    mgr.syncSharing(sessionDir, true, true);

    expect(readText(path.join(source, "projects", "-home-user-app", "aaa.jsonl"))).toBe("main-a\n");
    expect(isSymlink(path.join(sessionDir, "projects"))).toBe(true);
  });

  it("test_merge_deferred_while_profile_live", () => {
    const [, sessionDir, mgr] = historySetup();
    fs.mkdirSync(path.join(sessionDir, "projects"));
    writeText(path.join(sessionDir, "projects", "x.jsonl"), "live\n");
    vi.spyOn(internals, "scanLiveSessions").mockReturnValue([[{} as ClaudeSession], 0]);

    mgr.syncSharing(sessionDir, true, true);

    expect(isSymlink(path.join(sessionDir, "projects"))).toBe(false);
    expect(readText(path.join(sessionDir, "projects", "x.jsonl"))).toBe("live\n");
    expect(manifestOf(sessionDir).items).not.toContain("projects");
  });

  it("test_toggle_off_removes_links_keeps_data", () => {
    const [source, sessionDir, mgr] = historySetup();
    mgr.syncSharing(sessionDir, true, true);
    mgr.syncSharing(sessionDir, true, false);

    expect(fs.existsSync(path.join(sessionDir, "projects"))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, "history.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(source, "projects", "-home-user-app", "aaa.jsonl"))).toBe(true);
    expect(isSymlink(path.join(sessionDir, "settings.json"))).toBe(true);
  });

  it("test_share_history_independent_of_no_share", () => {
    const [, sessionDir, mgr] = historySetup();
    mgr.syncSharing(sessionDir, false, true);

    expect(isSymlink(path.join(sessionDir, "projects"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "settings.json"))).toBe(false);
  });

  it("test_seeded_source_has_claude_code_modes", () => {
    const [source, sessionDir, mgr] = shareSetup();
    mgr.syncSharing(sessionDir, true, true);

    expect(modeOf(path.join(source, "projects"))).toBe(0o700);
    expect(modeOf(path.join(source, "history.jsonl"))).toBe(0o600);
  });

  it("test_merge_creates_dirs_and_files_with_claude_code_modes", () => {
    const [source, sessionDir, mgr] = shareSetup();
    const deep = path.join(sessionDir, "projects", "-home-user-app", "sess1");
    fs.mkdirSync(deep, { recursive: true });
    writeText(path.join(deep, "agent.jsonl"), "profile\n");
    writeText(path.join(sessionDir, "history.jsonl"), '{"p": "profile"}\n');

    mgr.syncSharing(sessionDir, true, true);

    for (const created of [
      path.join(source, "projects"),
      path.join(source, "projects", "-home-user-app"),
      path.join(source, "projects", "-home-user-app", "sess1"),
    ]) {
      expect(modeOf(created)).toBe(0o700);
    }
    expect(modeOf(path.join(source, "history.jsonl"))).toBe(0o600);
  });

  it("test_stale_manifest_never_deletes_real_history", () => {
    const [source, sessionDir, mgr] = historySetup();
    const proj = path.join(sessionDir, "projects", "-home-user-app");
    fs.mkdirSync(proj, { recursive: true });
    writeText(path.join(proj, "bbb.jsonl"), "profile-b\n");
    writeText(path.join(sessionDir, "history.jsonl"), '{"p": "profile"}\n');
    writeText(path.join(sessionDir, SHARE_MANIFEST), JSON.stringify({ items: ["projects", "history.jsonl"], mode: "symlink" }));

    mgr.syncSharing(sessionDir, true, true);

    expect(readText(path.join(source, "projects", "-home-user-app", "bbb.jsonl"))).toBe("profile-b\n");
    expect(readText(path.join(source, "history.jsonl"))).toContain('{"p": "profile"}');
    expect(fs.readlinkSync(path.join(sessionDir, "projects"))).toBe(path.join(source, "projects"));
  });

  it("test_toggle_off_with_stale_manifest_keeps_real_history", () => {
    const [, sessionDir, mgr] = historySetup();
    const proj = path.join(sessionDir, "projects", "-home-user-app");
    fs.mkdirSync(proj, { recursive: true });
    writeText(path.join(proj, "bbb.jsonl"), "profile-b\n");
    writeText(path.join(sessionDir, SHARE_MANIFEST), JSON.stringify({ items: ["projects"], mode: "symlink" }));

    mgr.syncSharing(sessionDir, true, false);

    expect(readText(path.join(proj, "bbb.jsonl"))).toBe("profile-b\n");
  });
});

describe("TestShareHistoryWindows", () => {
  it("test_sync_never_links_history_in_copy_mode", () => {
    const [, sessionDir, mgr] = historySetup();
    mgr.switcher.platform = Platform.WINDOWS;
    mgr.syncSharing(sessionDir, true, true);

    expect(fs.existsSync(path.join(sessionDir, "projects"))).toBe(false);
    expect(manifestOf(sessionDir).items).not.toContain("projects");
  });

  it("test_run_rejects_flag", async () => {
    const [, , mgr] = historySetup();
    mgr.switcher.platform = Platform.WINDOWS;
    vi.spyOn(internals, "which").mockReturnValue("/usr/bin/claude");

    await expect(mgr.run(ACCOUNT_NUM, [], true, true)).rejects.toThrow(SessionError);
    await expect(mgr.run(ACCOUNT_NUM, [], true, true)).rejects.toThrow(/Windows/);
  });
});

describe("TestReadSessionCredentials", () => {
  it("test_missing_dir_returns_none", () => {
    expect(readSessionCredentials(path.join(tmpPath(), "absent"))).toBeNull();
  });

  it("test_reads_plaintext_file_off_macos", () => {
    vi.spyOn(Platform, "detect").mockReturnValue(Platform.LINUX);
    const sessionDir = path.join(tmpPath(), "sess");
    fs.mkdirSync(sessionDir);
    writeText(path.join(sessionDir, ".credentials.json"), '{"claudeAiOauth": {"accessToken": "sk-file"}}');
    expect(readSessionCredentials(sessionDir)).toContain("sk-file");
  });

  it("test_byte_corrupt_file_returns_none", () => {
    vi.spyOn(Platform, "detect").mockReturnValue(Platform.LINUX);
    const sessionDir = path.join(tmpPath(), "sess");
    fs.mkdirSync(sessionDir);
    fs.writeFileSync(path.join(sessionDir, ".credentials.json"), Buffer.from("\xff\xfe\x00corrupt", "latin1"));
    expect(readSessionCredentials(sessionDir)).toBeNull();
  });

  it("test_keychain_shadows_plaintext_on_macos", () => {
    macosPlatform();
    const sessionDir = path.join(tmpPath(), "sess");
    fs.mkdirSync(sessionDir);
    writeText(path.join(sessionDir, ".credentials.json"), '{"claudeAiOauth": {"accessToken": "sk-stale-seed"}}');
    keychainStore().setPassword(
      keychainServiceName(sessionDir),
      keychainAccountName(),
      '{"claudeAiOauth": {"accessToken": "sk-rotated"}}',
    );
    expect(readSessionCredentials(sessionDir)).toContain("sk-rotated");
  });

  it("test_macos_falls_back_to_file_without_keychain_entry", () => {
    macosPlatform();
    const sessionDir = path.join(tmpPath(), "sess");
    fs.mkdirSync(sessionDir);
    writeText(path.join(sessionDir, ".credentials.json"), '{"claudeAiOauth": {"accessToken": "sk-seed"}}');
    expect(readSessionCredentials(sessionDir)).toContain("sk-seed");
  });

  it.skipIf(process.platform === "win32")("test_symlinked_profile_reads_the_target_keychain_entry", () => {
    macosPlatform();
    const tmp = tmpPath();
    const target = path.join(tmp, "space");
    fs.mkdirSync(target);
    writeText(path.join(target, ".credentials.json"), '{"claudeAiOauth": {"accessToken": "sk-stale-seed"}}');
    const sessionDir = path.join(tmp, "sess");
    fs.symlinkSync(target, sessionDir);
    keychainStore().setPassword(
      keychainServiceName(target),
      keychainAccountName(),
      '{"claudeAiOauth": {"accessToken": "sk-rotated"}}',
    );
    expect(readSessionCredentials(sessionDir)).toContain("sk-rotated");
  });

  it.skipIf(process.platform === "win32")("test_symlinked_profile_prefers_its_own_keychain_entry", () => {
    macosPlatform();
    const tmp = tmpPath();
    const target = path.join(tmp, "space");
    fs.mkdirSync(target);
    const sessionDir = path.join(tmp, "sess");
    fs.symlinkSync(target, sessionDir);
    const account = keychainAccountName();
    keychainStore().setPassword(keychainServiceName(target), account, '{"claudeAiOauth": {"accessToken": "sk-target"}}');
    keychainStore().setPassword(keychainServiceName(sessionDir), account, '{"claudeAiOauth": {"accessToken": "sk-own"}}');
    expect(readSessionCredentials(sessionDir)).toContain("sk-own");
  });
});

const ACTIVE_TOKEN = "active-store-token";
const CONFIG_DIR_TOKEN = "config-dir-token";
const ACTIVE_CREDS = jsonDumps({ claudeAiOauth: { accessToken: ACTIVE_TOKEN } });
const CONFIG_DIR_CREDS = jsonDumps({ claudeAiOauth: { accessToken: CONFIG_DIR_TOKEN } });
const CONFIG_DIR_CONFIG = jsonDumps({
  oauthAccount: { emailAddress: "elsewhere@example.com", accountUuid: "uuid-elsewhere", organizationUuid: "org-elsewhere" },
});
const API_KEY = `sk-ant-api03-${"x".repeat(20)}`;

describe("TestCaptureCredentials", () => {
  async function captureSwitcher(platform: Platform): Promise<TestSwitcher> {
    vi.spyOn(Platform, "detect").mockReturnValue(platform);
    const switcher = await newSwitcher();
    switcher.setupDirectories();
    switcher.initSequenceFile();
    return switcher;
  }

  function configDir(base: string, credentials: string | null = CONFIG_DIR_CREDS): string {
    const directory = path.join(base, "elsewhere");
    fs.mkdirSync(directory);
    writeText(path.join(directory, ".claude.json"), CONFIG_DIR_CONFIG);
    if (credentials !== null) writeText(path.join(directory, ".credentials.json"), credentials);
    return directory;
  }

  function stored(switcher: TestSwitcher): string {
    return switcher.readAccountCredentials("1", "elsewhere@example.com") ?? "";
  }

  /** A bare secure-storage dir: credentials only, no identity. */
  function secureDir(base: string, token = "secure-store-token"): string {
    const directory = path.join(base, "securestore");
    fs.mkdirSync(directory);
    writeText(path.join(directory, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token } }));
    return directory;
  }

  const PLATFORMS = [Platform.LINUX, Platform.MACOS];

  it.each(PLATFORMS)("test_captures_config_dir_token[%s]", async (platform) => {
    const switcher = await captureSwitcher(platform);
    switcher.writeCredentials(ACTIVE_CREDS);
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir(tmpPath()));

    await switcher.addAccount();

    expect(stored(switcher)).toContain(CONFIG_DIR_TOKEN);
    expect(stored(switcher)).not.toContain(ACTIVE_TOKEN);
  });

  it("test_macos_prefers_hashed_keychain_entry", async () => {
    const switcher = await captureSwitcher(Platform.MACOS);
    switcher.writeCredentials(ACTIVE_CREDS);
    const dir = configDir(tmpPath());
    keychainStore().setPassword(
      keychainServiceName(dir),
      keychainAccountName(),
      JSON.stringify({ claudeAiOauth: { accessToken: "rotated" } }),
    );
    vi.stubEnv("CLAUDE_CONFIG_DIR", dir);

    await switcher.addAccount();

    expect(stored(switcher)).toContain("rotated");
  });

  it("test_trailing_slash_still_finds_keychain_entry", async () => {
    const switcher = await captureSwitcher(Platform.MACOS);
    const exported = `${configDir(tmpPath())}/`;
    keychainStore().setPassword(
      keychainServiceName(exported),
      keychainAccountName(),
      JSON.stringify({ claudeAiOauth: { accessToken: "rotated" } }),
    );
    vi.stubEnv("CLAUDE_CONFIG_DIR", exported);

    await switcher.addAccount();

    expect(stored(switcher)).toContain("rotated");
    expect(stored(switcher)).not.toContain(CONFIG_DIR_TOKEN);
  });

  it.each(PLATFORMS)("test_default_config_dir_uses_active_store[%s]", async (platform) => {
    const switcher = await captureSwitcher(platform);
    switcher.writeCredentials(ACTIVE_CREDS);
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(os.homedir(), ".claude"));
    writeText(getGlobalConfigPath(), CONFIG_DIR_CONFIG);

    await switcher.addAccount();

    expect(stored(switcher)).toContain(ACTIVE_TOKEN);
  });

  (process.platform === "win32" ? it.skip : it)(
    "test_symlinked_default_config_dir_uses_active_store",
    async () => {
        const switcher = await captureSwitcher(Platform.MACOS);
      switcher.writeCredentials(ACTIVE_CREDS);
      const link = path.join(tmpPath(), "home-link");
      fs.symlinkSync(os.homedir(), link);
      vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(link, ".claude"));
      writeText(getGlobalConfigPath(), CONFIG_DIR_CONFIG);

      await switcher.addAccount();

      expect(stored(switcher)).toContain(ACTIVE_TOKEN);
    },
  );

  it.each(PLATFORMS)("test_api_key_login_still_reaches_guard[%s]", async (platform) => {
    const switcher = await captureSwitcher(platform);
    const dir = configDir(tmpPath(), null);
    writeText(
      path.join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "elsewhere@example.com" }, primaryApiKey: API_KEY }),
    );
    vi.stubEnv("CLAUDE_CONFIG_DIR", dir);

    await expect(Promise.resolve().then(() => switcher.addAccount())).rejects.toThrow(ValidationError);
    await expect(Promise.resolve().then(() => switcher.addAccount())).rejects.toThrow(/API-key account/);
  });

  it("test_machine_managed_key_does_not_answer_for_config_dir", async () => {
    const switcher = await captureSwitcher(Platform.MACOS);
    keychainStore().setPassword(CLAUDE_CODE_MANAGED_KEYCHAIN_SERVICE, macosKeychain.keychainAccountName(), API_KEY);
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir(tmpPath(), null));

    await expect(Promise.resolve().then(() => switcher.addAccount())).rejects.toThrow(CredentialReadError);
  });

  it.each(PLATFORMS)("test_credentialless_config_dir_does_not_fall_back[%s]", async (platform) => {
    const switcher = await captureSwitcher(platform);
    switcher.writeCredentials(ACTIVE_CREDS);
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir(tmpPath(), null));

    await expect(Promise.resolve().then(() => switcher.addAccount())).rejects.toThrow(CredentialReadError);
  });

  it.each(PLATFORMS)("test_in_place_refresh_uses_same_source[%s]", async (platform) => {
    const switcher = await captureSwitcher(platform);
    switcher.writeCredentials(ACTIVE_CREDS);
    const dir = configDir(tmpPath());
    vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
    await switcher.addAccount();

    writeText(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "rotated" } }));
    await switcher.addAccount();

    expect(stored(switcher)).toContain("rotated");
  });

  it.each(
    PLATFORMS.flatMap((platform) => [
      [platform, null],
      [platform, ""],
    ]) as Array<[Platform, string | null]>,
  )("test_no_config_dir_uses_active_store[%s-%s]", async (platform, value) => {
    if (value === null) vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    else vi.stubEnv("CLAUDE_CONFIG_DIR", value);
    const switcher = await captureSwitcher(platform);
    switcher.writeCredentials(ACTIVE_CREDS);
    writeText(getGlobalConfigPath(), CONFIG_DIR_CONFIG);

    await switcher.addAccount();

    expect(stored(switcher)).toContain(ACTIVE_TOKEN);
  });

  it.each([
    ["keychain-error", () => new macosKeychain.KeychainError("keychain is locked")],
    ["os-error", () => Object.assign(new Error("no security binary"), { code: "ENOENT" })],
  ] as const)("test_unreadable_keychain_fails_closed[%s]", async (_id, makeError) => {
    const switcher = await captureSwitcher(Platform.MACOS);
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir(tmpPath()));
    internals.STRICT_KEYCHAIN_RETRY_DELAY = 0;
    const calls: string[] = [];
    const fakeStoreRead = macosKeychain.internals.getPassword;
    macosKeychain.internals.getPassword = (service, account) => {
      if (!service.startsWith("Claude Code-credentials-")) return fakeStoreRead(service, account);
      calls.push(service);
      throw makeError();
    };

    await expect(Promise.resolve().then(() => switcher.addAccount())).rejects.toThrow(/unreadable/);

    expect(calls.length).toBe(STRICT_KEYCHAIN_ATTEMPTS);
    expect(switcher.getSequenceData()?.accounts ?? {}).not.toHaveProperty("1");
  });

  it("test_transient_keychain_error_retries", async () => {
    const switcher = await captureSwitcher(Platform.MACOS);
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir(tmpPath()));
    internals.STRICT_KEYCHAIN_RETRY_DELAY = 0;
    const outcomes = ["busy", JSON.stringify({ claudeAiOauth: { accessToken: "rotated" } })];
    const fakeStoreRead = macosKeychain.internals.getPassword;
    macosKeychain.internals.getPassword = (service, account) => {
      if (!service.startsWith("Claude Code-credentials-")) return fakeStoreRead(service, account);
      const outcome = outcomes.shift();
      if (outcome === undefined) throw new Error("StopIteration");
      if (outcome === "busy") throw new macosKeychain.KeychainError("busy");
      return outcome;
    };

    await switcher.addAccount();

    expect(stored(switcher)).toContain("rotated");
  });

  it("test_session_read_still_falls_back_on_keychain_error", () => {
    vi.spyOn(Platform, "detect").mockReturnValue(Platform.MACOS);
    const sessionDir = configDir(tmpPath());
    macosKeychain.internals.getPassword = () => {
      throw new macosKeychain.KeychainError("keychain is locked");
    };

    const creds = readSessionCredentials(sessionDir);

    expect(creds).toContain(CONFIG_DIR_TOKEN);
  });

  it.each(PLATFORMS)("test_securestorage_dir_overrides_config_dir[%s]", async (platform) => {
    const switcher = await captureSwitcher(platform);
    const tmp = tmpPath();
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir(tmp));
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", secureDir(tmp));

    await switcher.addAccount();

    expect(stored(switcher)).toContain("secure-store-token");
    expect(stored(switcher)).not.toContain(CONFIG_DIR_TOKEN);
  });

  it("test_securestorage_hashed_keychain_entry", async () => {
    const switcher = await captureSwitcher(Platform.MACOS);
    const tmp = tmpPath();
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir(tmp));
    const secure = secureDir(tmp);
    keychainStore().setPassword(
      keychainServiceName(secure),
      keychainAccountName(),
      JSON.stringify({ claudeAiOauth: { accessToken: "rotated" } }),
    );
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", secure);

    await switcher.addAccount();

    expect(stored(switcher)).toContain("rotated");
  });

  it.each(PLATFORMS)("test_empty_securestorage_dir_forces_default_store[%s]", async (platform) => {
    const switcher = await captureSwitcher(platform);
    switcher.writeCredentials(ACTIVE_CREDS);
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir(tmpPath()));
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", "");

    await switcher.addAccount();

    expect(stored(switcher)).toContain(ACTIVE_TOKEN);
    expect(stored(switcher)).not.toContain(CONFIG_DIR_TOKEN);
  });

  it.each(PLATFORMS)("test_securestorage_without_config_dir[%s]", async (platform) => {
    const switcher = await captureSwitcher(platform);
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    writeText(getGlobalConfigPath(), CONFIG_DIR_CONFIG);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", secureDir(tmpPath()));

    await switcher.addAccount();

    expect(stored(switcher)).toContain("secure-store-token");
  });

  it.each(PLATFORMS)("test_empty_selected_store_does_not_leak_config_profile[%s]", async (platform) => {
    const switcher = await captureSwitcher(platform);
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir(tmpPath()));
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", "");

    await expect(Promise.resolve().then(() => switcher.addAccount())).rejects.toThrow(CredentialReadError);

    expect(switcher.getSequenceData()?.accounts ?? {}).not.toHaveProperty("1");
  });

  it.each(PLATFORMS)(
    "test_credentialless_securestorage_default_dir_does_not_fall_back[%s]",
    async (platform) => {
        const switcher = await captureSwitcher(platform);
      vi.stubEnv("CLAUDE_CONFIG_DIR", configDir(tmpPath()));
      vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", path.join(os.homedir(), ".claude"));

      await expect(Promise.resolve().then(() => switcher.addAccount())).rejects.toThrow(CredentialReadError);

      expect(switcher.getSequenceData()?.accounts ?? {}).not.toHaveProperty("1");
    },
  );
});

describe("TestBootstrapRefreshRoutesThroughGate", () => {
  it("test_bootstrap_uses_gate", async () => {
    const s = await newSwitcher();
    s.setupDirectories();
    s.initSequenceFile();
    const expired = jsonDumps({ claudeAiOauth: { accessToken: "sk-o", refreshToken: "rt-o", expiresAt: 1000 } });
    s.writeAccountCredentials("1", "a@example.com", expired);
    s.writeAccountConfig("1", "a@example.com", jsonDumps({ oauthAccount: { emailAddress: "a@example.com" } }));
    const data = s.getSequenceData() as NonNullable<ReturnType<TestSwitcher["getSequenceData"]>>;
    data.accounts = {
      ...data.accounts,
      "1": { email: "a@example.com", uuid: "u1", organizationUuid: "", organizationName: "" },
    };
    data.sequence = [1];
    s.writeJson(s.sequenceFile, data);
    const fresh = jsonDumps({ claudeAiOauth: { accessToken: "sk-f", refreshToken: "rt-f", expiresAt: 9999999999000 } });
    const gate: { args?: [string, string] } = {};
    stubGate(s, (num, email) => {
      gate.args = [num, email];
      return refreshOutcome(fresh, null);
    });
    const oauthMod = await import("../src/oauth.js");
    const direct: { called?: boolean } = {};
    vi.spyOn(oauthMod.internals, "tryRefreshOauthCredentials").mockImplementation(async () => {
      direct.called = true;
      return refreshOutcome(null, "transient");
    });
    vi.spyOn(oauthMod.internals, "refreshOauthCredentials").mockImplementation(async () => {
      direct.called = true;
      return null;
    });
    const mgr = new SessionManager(s);
    try {
      await mgr.setupSession("1", false);
    } catch {
      // Profile validation can fail in this stub env. The test checks only the gate routing.
    }
    expect(gate.args).toEqual(["1", "a@example.com"]);
    expect(direct.called).toBeUndefined();
  });
});

describe("TestAConsumedGrantIsNotSpentOnAProfileThatWonBootstrap", () => {
  /** The pre-lock check misses, then a peer bootstraps a PRE-rotation profile while this pass waits. */
  function peerBootstrapsWhileWeWait(): void {
    let n = 0;
    vi.spyOn(SessionManager.prototype, "isSessionValid").mockImplementation((sdir) => {
      n += 1;
      if (n === 1) return false;
      fs.mkdirSync(sdir, { recursive: true });
      writeText(path.join(sdir, ".credentials.json"), CREDS);
      return true;
    });
  }

  function gateRotates(sw: TestSwitcher): void {
    stubGate(sw, (num, email) => {
      sw.writeAccountCredentials(num, email, ROTATED_CREDS);
      return refreshOutcome(ROTATED_CREDS, null);
    });
  }

  it("test_the_early_return_leaves_the_profile_on_the_rotated_generation", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    authStatusTracksSeed();
    gateRotates(sw);
    peerBootstrapsWhileWeWait();

    const [got] = await manager.setupSession("2", false);

    expect(readText(path.join(got, ".credentials.json")), "the profile kept a generation the consume already spent").toBe(
      ROTATED_CREDS,
    );
  });

  it("test_a_live_peer_is_not_re_seeded_beneath_itself", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    authStatusTracksSeed();
    gateRotates(sw);
    peerBootstrapsWhileWeWait();
    vi.spyOn(internals, "scanLiveSessions").mockReturnValue([[{ pid: 4242 } as ClaudeSession], 0]);

    const [got] = await manager.setupSession("2", false);

    expect(readText(path.join(got, ".credentials.json")), "re-seeded a profile a live claude is running against").toBe(
      CREDS,
    );
  });

  it("test_an_unverifiable_probe_does_not_destroy_the_profile", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    const sessionDir = sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL);
    vi.spyOn(internals, "spawnSync").mockImplementation(() => ({
      status: null,
      error: Object.assign(new Error("spawnSync claude ENOENT"), { code: "ENOENT" }),
    }));

    await expect(manager.setupSession(ACCOUNT_NUM, false)).rejects.toThrow(/could not be verified/);

    expect(fs.existsSync(sessionDir), "deleted a profile it was never able to verify").toBe(true);
  });

  it("test_a_genuinely_invalid_profile_is_still_cleaned_up", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    const sessionDir = sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL);
    vi.spyOn(internals, "spawnSync").mockImplementation(() => probeResult({ loggedIn: false }));

    await expect(manager.setupSession(ACCOUNT_NUM, false)).rejects.toThrow(/failed validation/);

    expect(fs.existsSync(sessionDir)).toBe(false);
  });

  it("test_a_failed_persist_does_not_seed_the_profile_from_a_spent_grant", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    authStatusTracksSeed();
    const sessionDir = sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL);
    fs.mkdirSync(sessionDir, { recursive: true });
    stubGate(sw, () => refreshOutcome(ROTATED_CREDS, "transient", { stashed: true }));

    await expect(manager.setupSession("2", false)).rejects.toThrow(/stashed — please retry/);

    expect(sw.readAccountCredentials(ACCOUNT_NUM, ACCOUNT_EMAIL), "test premise").toBe(CREDS);
    const seeded = path.join(sessionDir, ".credentials.json");
    expect(!fs.existsSync(seeded) || readText(seeded) !== CREDS, "seeded the profile from a spent grant").toBe(true);
  });

  it("test_an_unpersisted_successor_is_not_reported_as_stashed", async () => {
    const sw = await seededSwitcher();
    const manager = new SessionManager(sw);
    authStatusTracksSeed();
    fs.mkdirSync(sessionDirFor(sw.backupDir, ACCOUNT_NUM, ACCOUNT_EMAIL), { recursive: true });
    stubGate(sw, () => refreshOutcome(ROTATED_CREDS, "transient", { stashed: false }));

    let msg = "";
    try {
      await manager.setupSession("2", false);
    } catch (e) {
      expect(e).toBeInstanceOf(SessionError);
      msg = (e as Error).message;
    }

    expect(msg).toContain("neither be stored nor stashed");
    expect(msg).toContain("Fix the storage failure");
    expect(msg, "promised a stash that never happened").not.toContain("the successor is stashed");
  });
});
