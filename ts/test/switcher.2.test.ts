import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  configLockDir,
  credentialsLockDir,
  internals as claudeLocks,
  oauthRefreshLockDir,
} from "../src/claude_locks.js";
import { activeCredentials } from "../src/credentials.js";
import { LockError } from "../src/exceptions.js";
import { USAGE_FOREIGN_CREDENTIAL, USAGE_NO_CREDENTIALS, USAGE_TOKEN_EXPIRED } from "../src/json_output.js";
import { FileLock } from "../src/locking.js";
import { getLogger, Handler, type LogRecord, WARNING } from "../src/logging_config.js";
import {
  type AccountIdentity,
  credentialFingerprint,
  internals as oauthInternals,
  type RefreshOutcome,
  refreshOutcome,
  type UsageOutcome,
  usageOutcome,
} from "../src/oauth.js";
import { ClaudeAccountSwitcher, internals } from "../src/switcher.js";
import type { SwitcherLockClass } from "../src/switcher/internals.js";
import type { FetchRecord } from "../src/usage_store.js";
import { mockClaudeConfig, sampleSequenceData } from "./helpers/fixtures.js";

type SequenceData = Omit<ReturnType<typeof sampleSequenceData>, "accounts"> & {
  accounts: Record<string, { email: string; uuid?: string; added: string }>;
};

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

function captureStdout(): string[] {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return chunks;
}

function oauthBlob(oauth: Record<string, unknown>): string {
  return JSON.stringify({ claudeAiOauth: oauth });
}

function sentinelOf(record: FetchRecord): string | null {
  return record.sentinel ?? null;
}

function errorOf(record: FetchRecord): string | null {
  return record.error ?? null;
}

function usageOf(record: FetchRecord): unknown {
  return record.usage ?? null;
}

const EXPIRED = oauthBlob({ accessToken: "sk-active", refreshToken: "rt-orig", expiresAt: 1000 });
const REFRESHED = oauthBlob({ accessToken: "sk-new", refreshToken: "rt-new", expiresAt: 9999999999000 });
const CC_ROTATED = oauthBlob({ accessToken: "sk-cc", refreshToken: "rt-cc-new", expiresAt: 9999999999000 });

/** What the profile oracle resolves for the credential of slot 1 (sequence uuid "uuid-1", no org). */
const PROFILE_SELF: AccountIdentity = { uuid: "uuid-1", email: "test@example.com", organizationUuid: null };

type Switcher = ClaudeAccountSwitcher;

function stubRefresh(impl?: (credentials: string, timeoutS?: number) => Promise<RefreshOutcome>) {
  return vi
    .spyOn(oauthInternals, "tryRefreshOauthCredentials")
    .mockImplementation(impl ?? (async () => refreshOutcome(null, "transient")));
}

const refreshOk = async (): Promise<RefreshOutcome> => refreshOutcome(REFRESHED, null);

function stubFetch(
  impl?: (accountNum: string, email: string, credentials: string, isActive: boolean) => Promise<UsageOutcome>,
) {
  return vi.spyOn(internals, "tryFetchUsageForAccount").mockImplementation(impl ?? (async () => usageOutcome(null)));
}

function fetchReturns(usage: UsageOutcome["usage"], error: string | null = null) {
  return stubFetch(async () => usageOutcome(usage, { error }));
}

function stubProbe(identity: AccountIdentity | null) {
  return vi.spyOn(oauthInternals, "fetchOauthProfile").mockResolvedValue(identity);
}

function readsLive(s: Switcher, live: string | null) {
  return vi.spyOn(s, "readCredentials").mockReturnValue(live);
}

function readsBackup(s: Switcher, backup: string) {
  return vi.spyOn(s, "readAccountCredentials").mockReturnValue(backup);
}

function spyWriteLive(s: Switcher) {
  return vi.spyOn(s, "writeCredentials").mockImplementation(() => {});
}

function spyWriteBackup(s: Switcher) {
  return vi.spyOn(s, "writeAccountCredentials").mockImplementation(() => {});
}

/** Run `body` while the primary refresh lock of Claude Code exists with a fresh mtime, like a live holder. */
async function withHeldRefreshLock<T>(body: () => Promise<T>): Promise<T> {
  const lock = oauthRefreshLockDir();
  fs.mkdirSync(lock, { recursive: true });
  try {
    return await body();
  } finally {
    fs.rmdirSync(lock);
  }
}

describe("TestActiveAccountRefresh", () => {
  let seq: SequenceData;
  const savedTimeout = claudeLocks.DEFAULT_TIMEOUT_S;
  const savedFileLock = internals.FileLock;

  beforeEach(() => {
    mockClaudeConfig();
    seq = sampleSequenceData();
  });

  afterEach(() => {
    claudeLocks.DEFAULT_TIMEOUT_S = savedTimeout;
    internals.FileLock = savedFileLock;
  });

  function switcherFor(data: SequenceData): Switcher {
    data.accounts!["1"]!.email = "test@example.com";
    const s = new ClaudeAccountSwitcher();
    s.setupDirectories();
    s.writeJson(s.sequenceFile, data);
    return s;
  }

  it("test_expired_refreshes_under_locks_and_persists_both_stores", async () => {
    const s = switcherFor(seq);
    const usageResult = { five_hour: { pct: 10 } };
    const locksHeldDuringPost: Record<string, boolean> = {};

    readsLive(s, EXPIRED);
    readsBackup(s, EXPIRED);
    const writeLive = spyWriteLive(s);
    const writeBackup = spyWriteBackup(s);
    stubRefresh(async () => {
      locksHeldDuringPost.primary = fs.existsSync(oauthRefreshLockDir());
      locksHeldDuringPost.legacy = fs.existsSync(credentialsLockDir());
      // Claude Code holds only the credential locks across its POST.
      // The config lock has a short retry budget on the side of Claude Code.
      locksHeldDuringPost.config = fs.existsSync(configLockDir());
      return refreshOutcome(REFRESHED, null);
    });
    stubFetch(async (_num, _email, credentials, isActive) => {
      expect(isActive).toBe(true);
      expect(credentials).toBe(REFRESHED);
      expect(fs.existsSync(oauthRefreshLockDir())).toBe(false);
      expect(fs.existsSync(credentialsLockDir())).toBe(false);
      expect(fs.existsSync(configLockDir())).toBe(false);
      return usageOutcome(usageResult);
    });

    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(usageOf(result)).toEqual(usageResult);
    expect(sentinelOf(result)).toBeNull();
    expect(locksHeldDuringPost).toEqual({ primary: true, legacy: true, config: false });
    expect(writeLive.mock.calls).toEqual([[REFRESHED]]);
    expect(writeBackup.mock.calls).toEqual([["1", "test@example.com", REFRESHED]]);
  });

  it("test_owner_present_no_longer_blocks_the_refresh", async () => {
    const s = switcherFor(seq);
    readsLive(s, EXPIRED);
    readsBackup(s, EXPIRED);
    vi.spyOn(s, "liveSessionPids").mockReturnValue([4242]);
    const writeLive = spyWriteLive(s);
    spyWriteBackup(s);
    stubRefresh(refreshOk);
    fetchReturns({ five_hour: { pct: 5 } });

    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(sentinelOf(result)).toBeNull();
    expect(writeLive.mock.calls).toEqual([[REFRESHED]]);
  });

  it("test_lock_reread_adopts_a_fresher_live_credential", async () => {
    const s = switcherFor(seq);
    const ccRotated = oauthBlob({ accessToken: "sk-cc", refreshToken: "rt-cc", expiresAt: 9999999999000 });
    readsLive(s, ccRotated);
    readsBackup(s, EXPIRED);
    const writeLive = spyWriteLive(s);
    const refresh = stubRefresh();
    stubFetch(async (_num, _email, credentials) => {
      expect(credentials).toBe(ccRotated);
      return usageOutcome({ five_hour: { pct: 7 } });
    });

    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(sentinelOf(result)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(writeLive).not.toHaveBeenCalled();
  });

  it("test_lock_reread_never_adopts_a_wiped_live_credential", async () => {
    const s = switcherFor(seq);
    const wipedFuture = oauthBlob({ accessToken: "", refreshToken: "", expiresAt: 9999999999000 });
    readsLive(s, wipedFuture);
    readsBackup(s, EXPIRED);
    const writeBackup = spyWriteBackup(s);
    const refresh = stubRefresh();
    const fetch = stubFetch();

    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(sentinelOf(result)).toBe(USAGE_TOKEN_EXPIRED);
    expect(refresh).not.toHaveBeenCalled();
    expect(writeBackup).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("test_non_oauth_live_with_moved_identity_is_never_clobbered", async () => {
    const s = switcherFor(seq);
    readsLive(s, "sk-ant-api03-somekey");
    readsBackup(s, EXPIRED);
    vi.spyOn(s, "getCurrentAccount").mockReturnValue(["console-api@token.local", ""]);
    const writeLive = spyWriteLive(s);
    const refresh = stubRefresh();
    const fetch = stubFetch();

    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(sentinelOf(result)).toBe(USAGE_TOKEN_EXPIRED);
    expect(refresh).not.toHaveBeenCalled();
    expect(writeLive).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("test_empty_live_with_matching_identity_still_recovers", async () => {
    const s = switcherFor(seq);
    readsLive(s, "");
    readsBackup(s, EXPIRED);
    const writeLive = spyWriteLive(s);
    spyWriteBackup(s);
    stubRefresh(refreshOk);
    fetchReturns({ five_hour: { pct: 5 } });

    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(sentinelOf(result)).toBeNull();
    expect(writeLive.mock.calls).toEqual([[REFRESHED]]);
  });

  it("test_a_held_consume_lock_defers_the_active_refresh", async () => {
    const s = switcherFor(seq);
    // The real FileLock waits 10 s before it gives up. A short timeout keeps the test fast.
    internals.FileLock = class extends FileLock {
      constructor(lockPath: string) {
        super(lockPath, 0.3);
      }
    } as SwitcherLockClass;
    const holder = new FileLock(`${s.credentialsDir}/.consume-1.lock`);
    expect(holder.acquire()).toBe(true);
    let result: FetchRecord;
    let refresh: ReturnType<typeof stubRefresh>;
    try {
      readsLive(s, EXPIRED);
      readsBackup(s, EXPIRED);
      refresh = stubRefresh();
      stubFetch();
      result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);
    } finally {
      holder.release();
    }

    expect(refresh, "POSTed a backup grant while another consume held its lock").not.toHaveBeenCalled();
    expect(sentinelOf(result)).toBe(USAGE_TOKEN_EXPIRED);
  });

  it("test_filelock_contention_defers_instead_of_raising", async () => {
    const s = switcherFor(seq);
    readsLive(s, EXPIRED);
    readsBackup(s, EXPIRED);
    internals.FileLock = class {
      constructor() {
        throw new LockError("held elsewhere");
      }
    } as unknown as SwitcherLockClass;
    const refresh = stubRefresh();
    const fetch = stubFetch();

    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(sentinelOf(result)).toBe(USAGE_TOKEN_EXPIRED);
    expect(refresh).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("test_unattributed_live_recovers_from_the_slots_backup", async () => {
    const s = switcherFor(seq);
    const slotBackup = oauthBlob({ accessToken: "sk-b", refreshToken: "rt-slot", expiresAt: 1000 });
    const consumed: string[] = [];
    readsLive(s, EXPIRED);
    readsBackup(s, slotBackup);
    const writeLive = spyWriteLive(s);
    spyWriteBackup(s);
    stubRefresh(async (credentials) => {
      consumed.push(credentials);
      return refreshOutcome(REFRESHED, null);
    });
    fetchReturns({ five_hour: { pct: 5 } });

    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(sentinelOf(result)).toBeNull();
    expect(consumed).toEqual([slotBackup]);
    expect(writeLive.mock.calls).toEqual([[REFRESHED]]);
  });

  it("test_unattributed_live_with_unusable_backup_never_consumes", async () => {
    const s = switcherFor(seq);
    const deadBackup = oauthBlob({ accessToken: "", refreshToken: "" });
    const foreignLive = oauthBlob({ accessToken: "sk-x", refreshToken: "rt-foreign", expiresAt: 1000 });
    readsLive(s, foreignLive);
    readsBackup(s, deadBackup);
    const refresh = stubRefresh();
    const fetch = stubFetch();

    const result = await s.fetchActiveUsage("1", "test@example.com", foreignLive);

    expect(sentinelOf(result)).toBe(USAGE_TOKEN_EXPIRED);
    expect(refresh).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("test_live_read_error_defers_instead_of_consuming", async () => {
    const s = switcherFor(seq);
    readsLive(s, null);
    readsBackup(s, EXPIRED);
    const refresh = stubRefresh();
    const fetch = stubFetch();

    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(sentinelOf(result)).toBe(USAGE_TOKEN_EXPIRED);
    expect(refresh).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("test_stranded_live_store_is_restored_from_the_backup", async () => {
    const s = switcherFor(seq);
    const successor = oauthBlob({ accessToken: "sk-successor", refreshToken: "rt-successor", expiresAt: 9999999999000 });
    readsLive(s, EXPIRED);
    readsBackup(s, successor);
    const writeLive = spyWriteLive(s);
    const writeBackup = spyWriteBackup(s);
    const refresh = stubRefresh();
    const fetch = fetchReturns({ five_hour: { pct: 5 } });

    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(sentinelOf(result)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(writeLive.mock.calls).toEqual([[successor]]);
    expect(writeBackup).not.toHaveBeenCalled();
    expect(fetch.mock.lastCall![2]).toBe(successor);
  });

  it("test_identity_check_compares_organization_too", async () => {
    const s = switcherFor(seq);
    const ccRotated = oauthBlob({ accessToken: "sk-cc", refreshToken: "rt-cc", expiresAt: 9999999999000 });
    readsLive(s, ccRotated);
    readsBackup(s, EXPIRED);
    vi.spyOn(s, "getCurrentAccount").mockReturnValue(["test@example.com", "org-OTHER"]);
    const writeBackup = spyWriteBackup(s);
    const refresh = stubRefresh();
    const fetch = stubFetch();

    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED, "");

    expect(sentinelOf(result)).toBe(USAGE_TOKEN_EXPIRED);
    expect(refresh).not.toHaveBeenCalled();
    expect(writeBackup).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("test_locally_valid_but_server_rejected_token_refreshes", async () => {
    const s = switcherFor(seq);
    const validButRevoked = oauthBlob({ accessToken: "sk-revoked", refreshToken: "rt-orig", expiresAt: 9999999999000 });
    const fetchCalls: string[] = [];
    readsLive(s, validButRevoked);
    readsBackup(s, validButRevoked);
    const writeLive = spyWriteLive(s);
    spyWriteBackup(s);
    stubRefresh(refreshOk);
    stubFetch(async (_num, _email, credentials) => {
      fetchCalls.push(credentials);
      if (credentials === validButRevoked) return usageOutcome(null, { error: "http-401" });
      return usageOutcome({ five_hour: { pct: 5 } });
    });

    const result = await s.fetchActiveUsage("1", "test@example.com", validButRevoked);

    expect(sentinelOf(result)).toBeNull();
    expect(usageOf(result)).toEqual({ five_hour: { pct: 5 } });
    expect(writeLive.mock.calls).toEqual([[REFRESHED]]);
    expect(fetchCalls).toEqual([validButRevoked, REFRESHED]);
  });

  it("test_server_rejected_token_with_no_recovery_surfaces_the_401", async () => {
    const s = switcherFor(seq);
    const validButRevoked = oauthBlob({ accessToken: "sk-revoked", refreshToken: "rt-foreign", expiresAt: 9999999999000 });
    const deadBackup = oauthBlob({ accessToken: "", refreshToken: "" });
    readsLive(s, validButRevoked);
    readsBackup(s, deadBackup);
    const refresh = stubRefresh();
    fetchReturns(null, "http-401");

    const result = await s.fetchActiveUsage("1", "test@example.com", validButRevoked);

    expect(errorOf(result)).toBe("http-401");
    expect(sentinelOf(result)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("test_server_rejected_token_lock_contention_still_surfaces_the_401", async () => {
    const s = switcherFor(seq);
    const validButRevoked = oauthBlob({ accessToken: "sk-revoked", refreshToken: "rt-orig", expiresAt: 9999999999000 });
    readsLive(s, validButRevoked);
    readsBackup(s, validButRevoked);
    claudeLocks.DEFAULT_TIMEOUT_S = 0.3;
    const refresh = stubRefresh();
    fetchReturns(null, "http-401");

    const result = await withHeldRefreshLock(() => s.fetchActiveUsage("1", "test@example.com", validButRevoked));

    expect(errorOf(result)).toBe("http-401");
    expect(sentinelOf(result)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("test_no_refresh_token_is_permanent_not_transient", async () => {
    const s = switcherFor(seq);
    const noRt = oauthBlob({ accessToken: "sk-only", expiresAt: 1000 });
    readsLive(s, noRt);
    readsBackup(s, noRt);
    const fetch = stubFetch();

    const result = await s.fetchActiveUsage("1", "test@example.com", noRt);

    expect(errorOf(result)).toBe("no_refresh_token");
    expect(sentinelOf(result)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("test_unexpected_exception_defers_never_raises", async () => {
    const s = switcherFor(seq);
    vi.spyOn(s, "readCredentials").mockImplementation(() => {
      throw Object.assign(new Error("config unreadable"), { code: "EACCES" });
    });
    readsBackup(s, EXPIRED);
    const fetch = stubFetch();

    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(sentinelOf(result)).toBe(USAGE_TOKEN_EXPIRED);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("test_transient_refresh_failure_backs_off_via_the_store", async () => {
    const s = switcherFor(seq);
    readsLive(s, EXPIRED);
    readsBackup(s, EXPIRED);
    const writeLive = spyWriteLive(s);
    stubRefresh(async () => refreshOutcome(null, "transient"));
    const fetch = stubFetch();

    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(errorOf(result)).toBe("refresh-failed");
    expect(sentinelOf(result)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(writeLive).not.toHaveBeenCalled();
  });

  it("test_lock_timeout_defers_to_the_holder", async () => {
    const s = switcherFor(seq);
    readsLive(s, EXPIRED);
    readsBackup(s, EXPIRED);
    claudeLocks.DEFAULT_TIMEOUT_S = 0.3;
    const refresh = stubRefresh();
    const fetch = stubFetch();

    const result = await withHeldRefreshLock(() => s.fetchActiveUsage("1", "test@example.com", EXPIRED));

    expect(sentinelOf(result)).toBe(USAGE_TOKEN_EXPIRED);
    expect(refresh).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("test_consumed_generation_survives_a_live_write_failure", async () => {
    const s = switcherFor(seq);
    readsLive(s, EXPIRED);
    readsBackup(s, EXPIRED);
    vi.spyOn(s, "writeCredentials").mockImplementation(() => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    const writeBackup = spyWriteBackup(s);
    stubRefresh(refreshOk);
    const fetch = stubFetch();

    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(writeBackup.mock.calls).toEqual([["1", "test@example.com", REFRESHED]]);
    // The live store still holds the consumed token: report expired, not usage.
    expect(sentinelOf(result)).toBe(USAGE_TOKEN_EXPIRED);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("test_non_expired_fetches_without_refreshing", async () => {
    const s = switcherFor(seq);
    const fresh = oauthBlob({ accessToken: "sk-live", refreshToken: "rt-live", expiresAt: 9999999999000 });
    const refresh = stubRefresh();
    const fetch = fetchReturns({ five_hour: { pct: 3 } });

    const result = await s.fetchActiveUsage("1", "test@example.com", fresh);

    expect(usageOf(result)).toEqual({ five_hour: { pct: 3 } });
    expect(refresh).not.toHaveBeenCalled();
    expect(fetch.mock.lastCall![3]).toBe(true);
  });

  it("test_fresh_fetch_resyncs_backup_after_external_rotation", async () => {
    const s = switcherFor(seq);
    readsLive(s, REFRESHED);
    readsBackup(s, EXPIRED);
    const writeBackup = spyWriteBackup(s);
    const probe = stubProbe(PROFILE_SELF);
    const refresh = stubRefresh();
    fetchReturns({ five_hour: { pct: 3 } });

    const result = await s.fetchActiveUsage("1", "test@example.com", REFRESHED);
    // The backup stays stale (the mock never updates it): the memoized verdict answers, no second probe.
    await s.fetchActiveUsage("1", "test@example.com", REFRESHED);

    expect(usageOf(result)).toEqual({ five_hour: { pct: 3 } });
    expect(refresh).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(writeBackup.mock.calls).toEqual([
      ["1", "test@example.com", REFRESHED],
      ["1", "test@example.com", REFRESHED],
    ]);
  });

  it("test_fresh_fetch_same_lineage_skips_the_resync", async () => {
    const s = switcherFor(seq);
    readsBackup(s, REFRESHED);
    const readLive = vi.spyOn(s, "readCredentials");
    const writeBackup = spyWriteBackup(s);
    fetchReturns({ five_hour: { pct: 3 } });

    await s.fetchActiveUsage("1", "test@example.com", REFRESHED);

    expect(writeBackup).not.toHaveBeenCalled();
    expect(readLive).not.toHaveBeenCalled();
  });

  /**
   * Drive the fresh fast path with a backup-lineage mismatch. The oracle
   * answers `probe`. Each pass gets new doubles, like a new `with patch` block.
   */
  async function freshDriftPass(s: Switcher, probe: AccountIdentity | null) {
    vi.restoreAllMocks();
    readsLive(s, REFRESHED);
    readsBackup(s, EXPIRED);
    const writeBackup = spyWriteBackup(s);
    const mockProbe = stubProbe(probe);
    fetchReturns({ five_hour: { pct: 3 } });
    const result = await s.fetchActiveUsage("1", "test@example.com", REFRESHED);
    const doubles = { writeBackup: [...writeBackup.mock.calls], probeCalls: mockProbe.mock.calls.length };
    vi.restoreAllMocks();
    return { result, ...doubles };
  }

  it("test_fresh_foreign_probe_mismatch_skips_resync_warns_once_and_caches", async () => {
    const s = switcherFor(seq);
    const foreign: AccountIdentity = { uuid: "uuid-foreign", email: "other@example.com", organizationUuid: null };
    const records = captureLogs(WARNING);

    const first = await freshDriftPass(s, foreign);
    const second = await freshDriftPass(s, foreign);

    expect(sentinelOf(first.result)).toBe(USAGE_FOREIGN_CREDENTIAL);
    expect(usageOf(first.result)).toBeNull();
    expect(sentinelOf(second.result)).toBe(USAGE_FOREIGN_CREDENTIAL);
    expect(first.writeBackup).toEqual([]);
    expect(second.writeBackup).toEqual([]);
    expect(first.probeCalls).toBe(1);
    expect(second.probeCalls).toBe(0);
    const warnings = records.filter((r) => r.message.includes("resolves to a different account"));
    expect(warnings).toHaveLength(1);
  });

  it("test_fresh_probe_failure_skips_resync_and_retries_next_pass", async () => {
    const s = switcherFor(seq);

    const first = await freshDriftPass(s, null);
    const second = await freshDriftPass(s, PROFILE_SELF);

    expect(usageOf(first.result)).toEqual({ five_hour: { pct: 3 } });
    expect(first.writeBackup).toEqual([]);
    expect(first.probeCalls).toBe(1);
    // The next pass probes again. A matching answer licenses the resync.
    expect(second.probeCalls).toBe(1);
    expect(second.writeBackup).toEqual([["1", "test@example.com", REFRESHED]]);
  });

  it("test_fresh_probe_unverifiable_not_cached", async () => {
    delete seq.accounts["1"]!.uuid;
    const s = switcherFor(seq);
    const partial: AccountIdentity = { uuid: "uuid-x", email: null, organizationUuid: null };

    const first = await freshDriftPass(s, partial);
    const second = await freshDriftPass(s, partial);

    expect(first.writeBackup).toEqual([]);
    expect(second.writeBackup).toEqual([]);
    expect(first.probeCalls).toBe(1);
    expect(second.probeCalls).toBe(1);
    expect(s.probeVerdicts.size).toBe(0);
  });

  it("test_uuid_less_slot_email_match_with_missing_org_is_unverifiable", async () => {
    delete seq.accounts["1"]!.uuid;
    const s = switcherFor(seq);
    const orgless: AccountIdentity = { uuid: "uuid-x", email: "test@example.com", organizationUuid: null };

    const first = await freshDriftPass(s, orgless);

    expect(first.writeBackup).toEqual([]);
    expect(s.probeVerdicts.size).toBe(0);
    expect(s.accountIdentity("1").uuid).toBe("");
    expect(usageOf(first.result)).toEqual({ five_hour: { pct: 3 } });
  });

  it("test_uuid_less_personal_slot_rejects_same_email_under_foreign_org", async () => {
    delete seq.accounts["1"]!.uuid;
    const s = switcherFor(seq);
    const sibling: AccountIdentity = { uuid: "uuid-org-sibling", email: "test@example.com", organizationUuid: "org-B" };

    const first = await freshDriftPass(s, sibling);
    const second = await freshDriftPass(s, sibling);

    expect(first.writeBackup).toEqual([]);
    expect(second.writeBackup).toEqual([]);
    expect(sentinelOf(first.result)).toBe(USAGE_FOREIGN_CREDENTIAL);
    expect(second.probeCalls).toBe(0);
    expect(s.accountIdentity("1").uuid).toBe("");
  });

  it("test_uuid_less_slot_exact_email_org_match_resyncs_and_backfills", async () => {
    delete seq.accounts["1"]!.uuid;
    const s = switcherFor(seq);
    const complete: AccountIdentity = { uuid: "uuid-resolved", email: "test@example.com", organizationUuid: "" };

    const first = await freshDriftPass(s, complete);

    expect(usageOf(first.result)).toEqual({ five_hour: { pct: 3 } });
    expect(first.writeBackup).toEqual([["1", "test@example.com", REFRESHED]]);
    expect(s.accountIdentity("1").uuid).toBe("uuid-resolved");
  });

  it("test_lineage_key_binds_the_stored_email_too", () => {
    delete seq.accounts["1"]!.uuid;
    const s = switcherFor(seq);
    const before = s.lineageKey("1", "test@example.com", "fp");

    const data = s.getSequenceData()!;
    data.accounts!["1"]!.email = "new@example.com";
    s.writeJson(s.sequenceFile, data);

    expect(s.lineageKey("1", "test@example.com", "fp")).not.toBe(before);
  });

  it("test_verdict_does_not_survive_a_slot_identity_change", async () => {
    const s = switcherFor(seq);
    const liveB = oauthBlob({ accessToken: "sk-B", refreshToken: "rt-B", expiresAt: 2000 });
    const backupA = oauthBlob({ accessToken: "sk-A", refreshToken: "rt-A", expiresAt: 1000 });
    s.probeVerdicts.set(s.lineageKey("1", "test@example.com", credentialFingerprint(liveB)!), true);
    // The slot is re-created for a different account: same number and email, new uuid.
    const data = s.getSequenceData()!;
    data.accounts!["1"]!.uuid = "uuid-recreated";
    s.writeJson(s.sequenceFile, data);

    readsLive(s, liveB);
    readsBackup(s, backupA);
    const writeLive = spyWriteLive(s);
    const refresh = stubRefresh();
    const fetch = stubFetch();

    const result = await s.fetchActiveUsage("1", "test@example.com", liveB);

    expect(sentinelOf(result)).toBe(USAGE_TOKEN_EXPIRED);
    expect(refresh).not.toHaveBeenCalled();
    expect(writeLive).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("test_expiry_after_unresynced_rotation_defers_without_verified_lineage", async () => {
    const s = switcherFor(seq);
    const liveB = oauthBlob({ accessToken: "sk-B", refreshToken: "rt-B", expiresAt: 2000 });
    const backupA = oauthBlob({ accessToken: "sk-A", refreshToken: "rt-A-consumed", expiresAt: 1000 });
    readsLive(s, liveB);
    readsBackup(s, backupA);
    const writeLive = spyWriteLive(s);
    const writeBackup = spyWriteBackup(s);
    const refresh = stubRefresh();
    const fetch = stubFetch();

    const result = await s.fetchActiveUsage("1", "test@example.com", liveB);

    expect(sentinelOf(result)).toBe(USAGE_TOKEN_EXPIRED);
    expect(refresh).not.toHaveBeenCalled();
    expect(writeBackup).not.toHaveBeenCalled();
    expect(writeLive).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("test_expiry_after_unresynced_rotation_consumes_live_when_verified", async () => {
    const s = switcherFor(seq);
    const liveB = oauthBlob({ accessToken: "sk-B", refreshToken: "rt-B", expiresAt: 2000 });
    const backupA = oauthBlob({ accessToken: "sk-A", refreshToken: "rt-A-consumed", expiresAt: 1000 });
    s.probeVerdicts.set(s.lineageKey("1", "test@example.com", credentialFingerprint(liveB)!), true);
    readsLive(s, liveB);
    readsBackup(s, backupA);
    const writeLive = spyWriteLive(s);
    const writeBackup = spyWriteBackup(s);
    const refresh = stubRefresh(refreshOk);
    const fetch = fetchReturns({ five_hour: { pct: 5 } });

    const result = await s.fetchActiveUsage("1", "test@example.com", liveB);

    expect(sentinelOf(result)).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]![0]).toBe(liveB);
    expect(writeBackup.mock.calls).toEqual([["1", "test@example.com", REFRESHED]]);
    expect(writeLive.mock.calls).toEqual([[REFRESHED]]);
    expect(fetch.mock.lastCall![2]).toBe(REFRESHED);
  });

  it("test_expiry_after_tolerated_backup_write_failure_consumes_live", async () => {
    const s = switcherFor(seq);
    // The live store of pass 2: the successor lineage rt-new, with an expired access token.
    const liveS = oauthBlob({ accessToken: "sk-S", refreshToken: "rt-new", expiresAt: 3000 });
    const successor2 = oauthBlob({ accessToken: "sk-newer", refreshToken: "rt-newer", expiresAt: 9999999999000 });

    vi.spyOn(s, "readCredentials").mockReturnValueOnce(EXPIRED).mockReturnValueOnce(liveS);
    readsBackup(s, EXPIRED);
    spyWriteLive(s);
    vi.spyOn(s, "writeAccountCredentials").mockImplementation(() => {
      throw new Error("disk full");
    });
    const refresh = vi
      .spyOn(oauthInternals, "tryRefreshOauthCredentials")
      .mockResolvedValueOnce(refreshOutcome(REFRESHED, null))
      .mockResolvedValueOnce(refreshOutcome(successor2, null));
    fetchReturns({ five_hour: { pct: 5 } });
    const probe = stubProbe(null);

    const first = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);
    const second = await s.fetchActiveUsage("1", "test@example.com", liveS);

    expect(sentinelOf(first)).toBeNull();
    expect(sentinelOf(second)).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh.mock.calls[1]![0]).toBe(liveS);
    expect(probe).not.toHaveBeenCalled();
  });

  it("test_stranded_backup_newer_still_restores_not_consumes_live", async () => {
    const s = switcherFor(seq);
    const successor = oauthBlob({ accessToken: "sk-successor", refreshToken: "rt-successor", expiresAt: 9999999999000 });
    readsLive(s, EXPIRED);
    readsBackup(s, successor);
    const writeLive = spyWriteLive(s);
    const refresh = stubRefresh();
    fetchReturns({ five_hour: { pct: 5 } });

    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(sentinelOf(result)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(writeLive.mock.calls).toEqual([[successor]]);
  });

  it("test_no_token_returns_no_credentials", async () => {
    const s = switcherFor(seq);
    const fetch = stubFetch();

    const result = await s.fetchActiveUsage("1", "test@example.com", "");

    expect(sentinelOf(result)).toBe(USAGE_NO_CREDENTIALS);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("test_list_renders_token_expired_line_on_lock_contention", async () => {
    const s = switcherFor(seq);
    vi.spyOn(s, "readActiveCredentials").mockReturnValue(activeCredentials(EXPIRED, false));
    readsBackup(s, EXPIRED);
    readsLive(s, EXPIRED);
    claudeLocks.DEFAULT_TIMEOUT_S = 0.3;
    fetchReturns(null);
    const out = captureStdout();

    await withHeldRefreshLock(() => s.listAccounts());

    expect(out.join("")).toContain("token expired");
  });

  it("test_expired_active_is_no_longer_statically_gated", async () => {
    const s = switcherFor(seq);
    readsLive(s, EXPIRED);
    readsBackup(s, EXPIRED);
    vi.spyOn(s, "liveSessionPids").mockReturnValue([]);
    spyWriteLive(s);
    spyWriteBackup(s);
    stubRefresh(refreshOk);
    fetchReturns({ five_hour: { pct: 25.0 } });

    const entry = (await s.collectUsageEntries([[1, "test@example.com", "", "", true, EXPIRED, ""]]))["1"]!;

    expect(entry.sentinel).toBeNull();
    expect(entry.lastGood).toEqual({ five_hour: { pct: 25.0 } });
  });

  it("test_foreign_live_credential_under_the_lock_is_never_consumed", async () => {
    const s = switcherFor(seq);
    const foreignLive = oauthBlob({ accessToken: "sk-other", refreshToken: "rt-other-slot", expiresAt: 1000 });
    readsLive(s, foreignLive);
    readsBackup(s, EXPIRED);
    const writeLive = spyWriteLive(s);
    const writeBackup = spyWriteBackup(s);
    const refresh = stubRefresh();
    const fetch = stubFetch();

    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(sentinelOf(result)).toBe(USAGE_TOKEN_EXPIRED);
    expect(refresh).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(writeLive).not.toHaveBeenCalled();
    expect(writeBackup).not.toHaveBeenCalled();
  });

  it("test_backup_write_failure_still_persists_live_and_never_raises", async () => {
    const s = switcherFor(seq);
    readsLive(s, EXPIRED);
    readsBackup(s, EXPIRED);
    vi.spyOn(s, "writeAccountCredentials").mockImplementation(() => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    const writeLive = spyWriteLive(s);
    stubRefresh(refreshOk);
    fetchReturns({ five_hour: { pct: 4 } });

    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(writeLive.mock.calls).toEqual([[REFRESHED]]);
    expect(usageOf(result)).toEqual({ five_hour: { pct: 4 } });
  });

  it("test_dead_lineage_surfaces_invalid_grant_not_a_silent_sentinel", async () => {
    const s = switcherFor(seq);
    readsLive(s, EXPIRED);
    readsBackup(s, EXPIRED);
    stubRefresh(async () => refreshOutcome(null, "invalid_grant"));
    const fetch = stubFetch();

    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(errorOf(result)).toBe("invalid_grant");
    expect(sentinelOf(result)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  /** Drive the adopt branch: expired credentials, a fresh unrelated live credential. */
  async function adoptPass(s: Switcher) {
    readsLive(s, CC_ROTATED);
    readsBackup(s, EXPIRED);
    vi.spyOn(s, "getCurrentAccount").mockReturnValue(["test@example.com", ""]);
    const writeLive = spyWriteLive(s);
    const writeBackup = spyWriteBackup(s);
    const refresh = stubRefresh();
    const fetch = fetchReturns({ five_hour: { pct: 7 } });
    const result = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);
    return { result, writeLive, writeBackup, refresh, fetch };
  }

  it("test_adopting_a_cc_rotation_skips_the_resync_without_a_verdict", async () => {
    const s = switcherFor(seq);
    const { result, writeLive, writeBackup, refresh } = await adoptPass(s);

    expect(sentinelOf(result)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(writeLive).not.toHaveBeenCalled();
    expect(writeBackup).not.toHaveBeenCalled();
  });

  it("test_adopting_a_cc_rotation_resyncs_the_slot_backup_when_verified", async () => {
    const s = switcherFor(seq);
    s.probeVerdicts.set(s.lineageKey("1", "test@example.com", credentialFingerprint(CC_ROTATED)!), true);
    const { result, writeLive, writeBackup, refresh } = await adoptPass(s);

    expect(sentinelOf(result)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(writeLive).not.toHaveBeenCalled();
    expect(writeBackup.mock.calls).toEqual([["1", "test@example.com", CC_ROTATED]]);
  });

  it("test_adopting_a_known_foreign_credential_defers", async () => {
    const s = switcherFor(seq);
    s.probeVerdicts.set(s.lineageKey("1", "test@example.com", credentialFingerprint(CC_ROTATED)!), false);
    const { result, writeLive, writeBackup, refresh, fetch } = await adoptPass(s);

    expect(sentinelOf(result)).toBe(USAGE_FOREIGN_CREDENTIAL);
    expect(refresh).not.toHaveBeenCalled();
    expect(writeLive).not.toHaveBeenCalled();
    expect(writeBackup).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
