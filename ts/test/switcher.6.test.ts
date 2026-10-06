import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { activeCredentials } from "../src/credentials.js";
import { SwitchError } from "../src/exceptions.js";
import { ERROR, Handler, type LogRecord, WARNING } from "../src/logging_config.js";
import { KeychainError, internals as keychainInternals } from "../src/macos_keychain.js";
import { Platform } from "../src/models.js";
import * as oauth from "../src/oauth.js";
import { isSessionStale, sessionDirFor, STALE_MARKER } from "../src/session.js";
import { ClaudeAccountSwitcher, internals, type SequenceData } from "../src/switcher.js";
import type { SwitcherLock, SwitcherLockClass } from "../src/switcher/internals.js";
import { mockClaudeConfig, sampleSequenceData } from "./helpers/fixtures.js";
import { RealStoreWriteBlocked } from "./helpers/real-store-guard.js";

type SampleData = ReturnType<typeof sampleSequenceData>;

const POSIX_NON_ROOT = process.platform !== "win32" && process.getuid?.() !== 0;

function raiseLocked(): never {
  throw new KeychainError("locked");
}

function osError(code: string, errno: number, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code, errno });
}

function oauthCreds(accessToken: string, refreshToken: string, expiresAt: number): string {
  return JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt } });
}

function newSwitcher(data: SampleData, email = "test@example.com"): ClaudeAccountSwitcher {
  data.accounts["1"].email = email;
  const s = new ClaudeAccountSwitcher();
  s.setupDirectories();
  s.writeJson(s.sequenceFile, data);
  return s;
}

function spyRefresh() {
  return vi.spyOn(oauth.internals, "tryRefreshOauthCredentials");
}

/** Replace the `FileLock` seam of the switcher while `body` runs. */
async function withFileLock<T>(lockClass: SwitcherLockClass, body: () => Promise<T>): Promise<T> {
  const original = internals.FileLock;
  internals.FileLock = lockClass;
  try {
    return await body();
  } finally {
    internals.FileLock = original;
  }
}

class CaptureHandler extends Handler {
  readonly records: LogRecord[] = [];

  protected emit(record: LogRecord): void {
    this.records.push(record);
  }
}

const OLD = oauthCreds("sk-old", "rt-old", 1000);
const NEW = oauthCreds("sk-new", "rt-new", 9999999999000);

describe("TestGateUltraReviewFixes", () => {
  it("test_a_cas_conflict_is_not_reported_as_a_failed_freshen", async () => {
    const racer = oauthCreds("sk-rac", "rt-rac", 8888888888000);
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);

    spyRefresh().mockImplementation(async () => {
      s.store.writeAccountCredentials("1", "test@example.com", racer);
      return oauth.refreshOutcome(NEW, null);
    });
    const out = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(s.readAccountCredentials("1", "test@example.com"), "premise: the store holds the racer's newer lineage").toBe(
      racer,
    );
    expect(out.credentials).toBe(racer);
    expect(out.error, "a freshened slot reported as a failure: the caller skips it").toBeNull();
  });

  it("test_a_cas_conflict_stash_does_not_accumulate_forever", async () => {
    const THIRD = oauthCreds("sk-3rd", "rt-3rd", 9999999999000);
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);

    // The pre-POST read sees the consumed generation. The post-POST CAS re-read sees THIRD.
    const reads: Array<[string, boolean]> = [[OLD, false]];
    const plain = vi.spyOn(s, "readAccountCredentials").mockReturnValue(THIRD);
    const ex = vi.spyOn(s, "readAccountCredentialsEx").mockImplementation(() => reads.shift() ?? [THIRD, false]);
    spyRefresh().mockResolvedValue(oauth.refreshOutcome(NEW, null));
    const out = await s.consumeBackupGrant("1", "test@example.com", OLD);
    plain.mockRestore();
    ex.mockRestore();

    expect(out.credentials).toBe(THIRD);
    const stashed = s.listUnclaimedCredentials();
    expect(Object.keys(stashed).length, "the consumed successor must be preserved").toBeGreaterThan(0);

    const adopted = s.adoptStashedSuccessor("1", "test@example.com", THIRD);
    expect(adopted).toBeNull();
    const manifest = s.store.readStashManifest() as Record<string, Record<string, unknown> | undefined>;
    expect(
      Object.keys(s.listUnclaimedCredentials()).filter((e) => manifest[e]?.reason === "consume-gate-cas-conflict"),
      "a CAS-conflict entry stays pending forever: it can never match the adoption condition, so every conflict leaks one file",
    ).toEqual([]);
  });

  it("test_no_store_read_happens_before_the_consume_lock", async () => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);

    const order: string[] = [];
    const realRead = s.readAccountCredentials.bind(s);
    const realReadEx = s.readAccountCredentialsEx.bind(s);
    const RealLock = internals.FileLock;

    class WatchedLock implements SwitcherLock {
      private readonly name: string;
      private readonly inner: SwitcherLock;

      constructor(lockPath: string, timeout?: number) {
        this.name = lockPath;
        this.inner = new RealLock(lockPath, timeout);
      }

      acquire(timeout?: number): boolean {
        if (this.name.includes(".consume-")) order.push("consume-lock");
        return this.inner.acquire(timeout);
      }

      release(): void {
        this.inner.release();
      }

      enter(): unknown {
        return this.inner.enter();
      }

      exit(): void {
        this.inner.exit();
      }
    }

    vi.spyOn(s, "readAccountCredentials").mockImplementation((n, e) => {
      order.push("read");
      return realRead(n, e);
    });
    vi.spyOn(s, "readAccountCredentialsEx").mockImplementation((n, e) => {
      order.push("read");
      return realReadEx(n, e);
    });
    spyRefresh().mockResolvedValue(oauth.refreshOutcome(NEW, null));
    await withFileLock(WatchedLock, () => s.consumeBackupGrant("1", "test@example.com", OLD));

    expect(order, "the consume lock must be taken").toContain("consume-lock");
    expect(
      order.indexOf("consume-lock"),
      `order was ${JSON.stringify(order)}: the store is read before the consume lock, so two gates can select the same one-time-use grant`,
    ).toBe(0);
  });

  it("test_contention_reports_its_own_kind_not_transient", async () => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);
    const RealLock = internals.FileLock;

    class ConsumeLockBusy implements SwitcherLock {
      private readonly busy: boolean;
      private readonly inner: SwitcherLock;

      constructor(lockPath: string, timeout?: number) {
        this.busy = lockPath.includes(".consume-");
        this.inner = new RealLock(lockPath, timeout);
      }

      acquire(timeout?: number): boolean {
        return this.busy ? false : this.inner.acquire(timeout);
      }

      release(): void {
        if (!this.busy) this.inner.release();
      }

      enter(): unknown {
        return this.inner.enter();
      }

      exit(): void {
        this.inner.exit();
      }
    }

    const out = await withFileLock(ConsumeLockBusy, () => s.consumeBackupGrant("1", "test@example.com", OLD));

    expect(out.error, `got ${out.error}: contention reads as a transient failure and surfaces as (network?)`).toBe(
      "consume-busy",
    );
  });

  it("test_persist_oserror_after_post_stashes_and_never_raises", async () => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);

    const realWrite = s.writeAccountCredentials.bind(s);
    let postDone = false;
    vi.spyOn(s, "writeAccountCredentials").mockImplementation((n, e, c) => {
      if (postDone) throw osError("ENOSPC", 28, "No space left on device");
      realWrite(n, e, c);
    });
    spyRefresh().mockImplementation(async () => {
      postDone = true;
      return oauth.refreshOutcome(NEW, null);
    });
    const out = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(out.error).toBe("transient");
    expect(out.credentials).toBe(NEW);
    expect(Object.keys(s.listUnclaimedCredentials()).length, "successor must be stashed").toBeGreaterThan(0);
  });

  it("test_persist_and_stash_both_failing_still_never_raises", async () => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);
    let postDone = false;
    const realWrite = s.writeAccountCredentials.bind(s);
    vi.spyOn(s, "writeAccountCredentials").mockImplementation((n, e, c) => {
      if (postDone) throw osError("ENOSPC", 28, "No space left on device");
      realWrite(n, e, c);
    });
    vi.spyOn(s.store, "writeUnclaimedCredential").mockImplementation(() => {
      throw osError("ENOSPC", 28, "No space left on device");
    });
    spyRefresh().mockImplementation(async () => {
      postDone = true;
      return oauth.refreshOutcome(NEW, null);
    });
    const out = await s.consumeBackupGrant("1", "test@example.com", OLD);
    expect(out.error, "reported success on a spent grant with nothing stashed").toBe("transient");
    expect(out.credentials).toBe(NEW);
  });

  it("test_failure_outcome_carries_consumed_fp_of_posted_bytes", async () => {
    const s = newSwitcher(sampleSequenceData());
    const fresher = oauthCreds("sk-fresher", "rt-fresher", 2000);
    s.writeAccountCredentials("1", "test@example.com", fresher);

    spyRefresh().mockResolvedValue(oauth.refreshOutcome(null, "invalid_grant"));
    const out = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(out.error).toBe("invalid_grant");
    expect(out.consumedFp).toBe(oauth.credentialFingerprint(fresher));
    expect(out.consumedFp).not.toBe(oauth.credentialFingerprint(OLD));
  });

  it("test_concurrent_gates_consume_only_one_grant", async () => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);
    const posted: string[] = [];
    let signalInPost!: () => void;
    const inPost = new Promise<void>((resolve) => (signalInPost = resolve));
    let releasePost!: () => void;
    const released = new Promise<void>((resolve) => (releasePost = resolve));

    spyRefresh().mockImplementation(async (credentials: string) => {
      posted.push((JSON.parse(credentials) as { claudeAiOauth: { refreshToken: string } }).claudeAiOauth.refreshToken);
      signalInPost();
      await Promise.race([released, new Promise((resolve) => setTimeout(resolve, 5000))]);
      return oauth.refreshOutcome(NEW, null);
    });

    // Each gate gets its own switcher (the cross-process shape).
    const gate = () => new ClaudeAccountSwitcher().consumeBackupGrant("1", "test@example.com", OLD);
    const a = gate();
    await inPost;
    const b = gate();
    // Gate b must wait on the consume lock.
    await new Promise((resolve) => setTimeout(resolve, 300));
    releasePost();
    const results = { a: await a, b: await b };

    expect(posted, "one grant consumed exactly once").toEqual(["rt-old"]);
    for (const tag of ["a", "b"] as const) {
      expect(results[tag].error).toBeNull();
      expect(results[tag].credentials).toBe(NEW);
    }
  });

  it("test_next_gate_pass_adopts_stashed_successor", async () => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);
    s.store.writeUnclaimedCredential(NEW, {
      reason: "consume-gate-persist-lock-failed",
      configSlot: "1",
      consumedFp: oauth.credentialFingerprint(OLD),
      fingerprint: oauth.credentialFingerprint(NEW),
    });

    const post = spyRefresh();
    const out = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(post).not.toHaveBeenCalled();
    expect(out.error).toBeNull();
    expect(out.credentials).toBe(NEW);
    expect(s.readAccountCredentials("1", "test@example.com")).toBe(NEW);
    expect(s.listUnclaimedCredentials(), "stash entry consumed").toEqual({});
  });

  it("test_slot_removed_mid_post_stashes_instead_of_resurrecting", async () => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);

    spyRefresh().mockImplementation(async () => {
      s.store.deleteAccountCredentials("1", "test@example.com");
      return oauth.refreshOutcome(NEW, null);
    });
    const out = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(out.error).toBeNull();
    expect(s.readAccountCredentials("1", "test@example.com"), "removed slot must stay empty").toBe("");
    expect(Object.keys(s.listUnclaimedCredentials()).length, "successor parked in stash").toBeGreaterThan(0);
  });

  it("test_stale_marked_profile_never_supersedes_backup", async () => {
    const s = newSwitcher(sampleSequenceData());
    const reimported = oauthCreds("sk-readd", "rt-readd", 1000);
    s.writeAccountCredentials("1", "test@example.com", reimported);
    const staleProfile = oauthCreds("sk-stale", "rt-stale", 999999);
    const sdir = sessionDirFor(s.backupDir, "1", "test@example.com");
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, ".credentials.json"), staleProfile);
    fs.writeFileSync(path.join(sdir, STALE_MARKER), "");
    const posted: { creds?: string } = {};

    spyRefresh().mockImplementation(async (credentials: string) => {
      posted.creds = credentials;
      return oauth.refreshOutcome(NEW, null);
    });
    vi.spyOn(s, "liveSessionPids").mockReturnValue([]);
    await s.consumeBackupGrant("1", "test@example.com", reimported);

    expect(posted.creds, "the re-added backup, not the presumed-stale profile").toBe(reimported);
  });

  it("test_the_consume_lock_is_released_even_when_the_post_raises", async () => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);
    const post = spyRefresh().mockRejectedValue(new Error("boom"));
    await expect(s.consumeBackupGrant("1", "test@example.com", OLD)).rejects.toThrow("boom");

    post.mockResolvedValue(oauth.refreshOutcome(NEW, null));
    const out = await s.consumeBackupGrant("1", "test@example.com", OLD);
    expect(out.error).not.toBe("consume-busy");
  });

  it("test_a_foreign_profile_never_supersedes_the_backup", async () => {
    const s = newSwitcher(sampleSequenceData());
    const backup = oauthCreds("sk-bk", "rt-bk", 1000);
    s.writeAccountCredentials("1", "test@example.com", backup);
    const foreign = oauthCreds("sk-foreign", "rt-foreign", 999999);
    const sdir = sessionDirFor(s.backupDir, "1", "test@example.com");
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, ".credentials.json"), foreign);
    s.writeJson(path.join(sdir, ".claude.json"), {
      oauthAccount: {
        emailAddress: "SOMEONE-ELSE@example.com",
        accountUuid: "other-uuid",
        organizationUuid: "",
        organizationName: "",
      },
    });
    const posted: { creds?: string } = {};

    spyRefresh().mockImplementation(async (credentials: string) => {
      posted.creds = credentials;
      return oauth.refreshOutcome(NEW, null);
    });
    vi.spyOn(s, "liveSessionPids").mockReturnValue([]);
    await s.consumeBackupGrant("1", "test@example.com", backup);

    expect(posted.creds, "the gate POSTed a profile logged in as another account").toBe(backup);
    expect(s.readAccountCredentials("1", "test@example.com"), "a foreign lineage was written into the slot").not.toContain(
      "rt-foreign",
    );
  });

  it("test_an_older_profile_never_supersedes_the_backup", async () => {
    const s = newSwitcher(sampleSequenceData());
    const backup = oauthCreds("sk-bk", "rt-bk", 5000);
    s.writeAccountCredentials("1", "test@example.com", backup);
    const older = oauthCreds("sk-pf", "rt-pf-SPENT", 1000);
    const sdir = sessionDirFor(s.backupDir, "1", "test@example.com");
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, ".credentials.json"), older);
    const posted: { creds?: string } = {};

    spyRefresh().mockImplementation(async (credentials: string) => {
      posted.creds = credentials;
      return oauth.refreshOutcome(NEW, null);
    });
    vi.spyOn(s, "liveSessionPids").mockReturnValue([]);
    await s.consumeBackupGrant("1", "test@example.com", backup);

    expect(
      posted.creds,
      "the gate POSTed the profile's older, already-superseded generation instead of the backup",
    ).toBe(backup);
  });

  it("test_unreadable_backup_defers_instead_of_posting_snapshot", async () => {
    const s = newSwitcher(sampleSequenceData());
    vi.spyOn(s, "readAccountCredentialsEx").mockReturnValue(["", true]);
    const post = spyRefresh();
    const out = await s.consumeBackupGrant("1", "test@example.com", OLD);
    expect(post).not.toHaveBeenCalled();
    expect(out.error).toBe("transient");
  });

  it("test_fresh_rotated_reread_adopted_without_second_consume", async () => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", NEW);
    const post = spyRefresh();
    const out = await s.consumeBackupGrant("1", "test@example.com", OLD);
    expect(post).not.toHaveBeenCalled();
    expect(out.error).toBeNull();
    expect(out.credentials).toBe(NEW);
  });

  it.each([false, true])("test_a_failed_retire_does_not_unwind_a_completed_adoption", (retireFails) => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);
    s.store.writeUnclaimedCredential(NEW, {
      reason: "consume-gate-persist-lock-failed",
      configSlot: "1",
      consumedFp: oauth.credentialFingerprint(OLD),
      fingerprint: oauth.credentialFingerprint(NEW),
    });

    const realRetire = s.store.removeUnclaimedCredential.bind(s.store);
    vi.spyOn(s.store, "removeUnclaimedCredential").mockImplementation((entryId) => {
      if (retireFails) throw osError("ENOSPC", 28, "No space left on device");
      realRetire(entryId);
    });
    const adopted = s.adoptStashedSuccessor("1", "test@example.com", OLD);

    expect(s.readAccountCredentials("1", "test@example.com"), "premise: the adoption write lands in both arms").toBe(NEW);
    expect(
      adopted,
      "the adoption completed but its credentials were not returned: the caller re-POSTs a generation this pass already consumed",
    ).toBe(NEW);
  });

  it.each([false, true])("test_a_failed_housekeeping_retire_does_not_abort_the_scan", (deadRowIsByteless) => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);

    // Row A is dead and comes first, so the scan reaches it before the adoptable row.
    const deadMeta = deadRowIsByteless
      ? { reason: "consume-gate-persist-failed", consumedFp: oauth.credentialFingerprint(OLD) }
      : { reason: "consume-gate-cas-conflict", consumedFp: "sha256:gone" };
    const deadId = s.store.writeUnclaimedCredential(NEW, { configSlot: "1", ...deadMeta });
    if (deadRowIsByteless) fs.unlinkSync(s.store.stashEntryPath(deadId));

    const liveId = s.store.writeUnclaimedCredential(NEW, {
      reason: "consume-gate-persist-lock-failed",
      configSlot: "1",
      consumedFp: oauth.credentialFingerprint(OLD),
      fingerprint: oauth.credentialFingerprint(NEW),
    });
    expect(Object.keys(s.store.readStashManifest()), "premise: the dead row is scanned before the adoptable one").toEqual([
      deadId,
      liveId,
    ]);

    const realRetire = s.store.removeUnclaimedCredential.bind(s.store);
    vi.spyOn(s.store, "removeUnclaimedCredential").mockImplementation((entryId) => {
      if (entryId === deadId) throw osError("ENOSPC", 28, "No space left on device");
      realRetire(entryId);
    });
    const adopted = s.adoptStashedSuccessor("1", "test@example.com", OLD);

    expect(adopted, "a failed housekeeping retire aborted the scan before the adoptable row behind it was reached").toBe(
      NEW,
    );
    expect(s.readAccountCredentials("1", "test@example.com")).toBe(NEW);
  });

  it.each([true, false])("test_a_byteless_non_matching_row_is_retired", (bytesSurvive) => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", NEW);
    const entryId = s.store.writeUnclaimedCredential(NEW, {
      reason: "consume-gate-persist-lock-failed",
      configSlot: "1",
      // The row keys against a generation that the slot has already moved past.
      consumedFp: oauth.credentialFingerprint(OLD),
      fingerprint: oauth.credentialFingerprint(NEW),
    });
    if (!bytesSurvive) fs.unlinkSync(s.store.stashEntryPath(entryId));

    const adopted = s.adoptStashedSuccessor("1", "test@example.com", NEW);

    expect(adopted, "premise: a non-matching row is never adopted").toBeNull();
    const listed = entryId in s.store.readStashManifest();
    if (bytesSurvive) {
      expect(
        listed,
        "a superseded row that still holds its bytes is a real credential; dropping it is the operator's call (--purge)",
      ).toBe(true);
    } else {
      expect(
        listed,
        "a row whose bytes are gone can never be adopted by any pass, yet nothing retires it: permanent junk in --json",
      ).toBe(false);
    }
  });

  it.each([true, false])("test_a_failed_session_invalidation_does_not_discard_the_adoption", (storeWriteLands) => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);
    s.store.writeUnclaimedCredential(NEW, {
      reason: "consume-gate-persist-lock-failed",
      configSlot: "1",
      consumedFp: oauth.credentialFingerprint(OLD),
      fingerprint: oauth.credentialFingerprint(NEW),
    });

    const boom = () => {
      throw osError("EACCES", 13, "Permission denied");
    };
    if (storeWriteLands) {
      // Only the session invalidation after the write fails.
      vi.spyOn(s, "postBackupWrite").mockImplementation(boom);
    } else {
      // The store write itself fails: the slot never advances.
      vi.spyOn(s.store, "writeAccountCredentials").mockImplementation(boom);
    }

    let adopted: string | null = null;
    let raised: unknown = null;
    try {
      adopted = s.adoptStashedSuccessor("1", "test@example.com", OLD);
    } catch (e) {
      raised = e;
    }
    vi.restoreAllMocks();

    const stored = s.readAccountCredentials("1", "test@example.com");
    if (storeWriteLands) {
      expect(stored, "premise: the store took the write").toBe(NEW);
      expect(raised).toBeNull();
      expect(adopted, "a completed adoption was discarded because the session profile could not be invalidated").toBe(NEW);
    } else {
      expect(stored, "premise: the store rejected the write").toBe(OLD);
      expect(
        (raised as NodeJS.ErrnoException | null)?.code,
        "the store never advanced; claiming an adoption would return credentials the slot does not hold",
      ).toBe("EACCES");
    }
  });

  it.skipIf(!POSIX_NON_ROOT).each([null, "session_dir", "session_dir_and_parent"] as const)(
    "test_a_denied_session_dir_still_leaves_the_stale_marker",
    (denied) => {
      const s = newSwitcher(sampleSequenceData());
      const sess = s.sessionDir("1", "test@example.com");
      fs.mkdirSync(sess, { recursive: true });
      fs.writeFileSync(path.join(sess, ".credentials.json"), OLD);

      const chmodded: string[] = [];
      if (denied === "session_dir" || denied === "session_dir_and_parent") chmodded.push(sess);
      if (denied === "session_dir_and_parent") chmodded.push(path.dirname(sess));
      const caplog = new CaptureHandler();
      s.logger.addHandler(caplog);
      const level = s.logger.level;
      try {
        for (const d of chmodded) fs.chmodSync(d, 0o500);
        s.logger.setLevel(WARNING);
        s.writeAccountCredentials("1", "test@example.com", NEW);
      } finally {
        s.logger.setLevel(level);
        s.logger.removeHandler(caplog);
        for (const d of [...chmodded].reverse()) fs.chmodSync(d, 0o700);
      }

      expect(s.readAccountCredentials("1", "test@example.com"), "premise: the store write ADVANCED the slot").toBe(NEW);
      if (denied === null) {
        expect(
          fs.existsSync(path.join(sess, ".credentials.json")),
          "CONTROL: the invalidation really ran on a healthy dir",
        ).toBe(false);
        expect(isSessionStale(sess), "CONTROL: nothing failed, so nothing to mark").toBe(false);
        return;
      }

      expect(
        fs.existsSync(path.join(sess, ".credentials.json")),
        `premise (${denied}): the unlink was denied, so the profile still holds the superseded credential`,
      ).toBe(true);
      if (denied === "session_dir") {
        expect(
          isSessionStale(sess),
          "DEFECT: the invalidation was denied and NO stale marker landed — the marker's own write target was the directory that denied it",
        ).toBe(true);
      } else {
        expect(
          isSessionStale(sess),
          "premise: the whole sessions root is denied, so no marker location under it can land",
        ).toBe(false);
        expect(
          caplog.records.some((r) => r.levelno >= ERROR && r.message.includes("1")),
          "DEFECT: the profile keeps serving the superseded generation and nothing says so above WARNING",
        ).toBe(true);
      }
    },
  );

  it("test_the_suites_real_store_guard_is_not_absorbed_by_the_wrapper", () => {
    const s = newSwitcher(sampleSequenceData());
    vi.spyOn(s, "postBackupWrite").mockImplementation(() => {
      throw new RealStoreWriteBlocked("refused: the REAL store");
    });
    expect(() => s.writeAccountCredentials("1", "test@example.com", NEW)).toThrow(RealStoreWriteBlocked);
  });

  it.each([true, false])("test_an_unreadable_non_matching_row_does_not_abort_the_scan", (rowAReadable) => {
    // A chmod 000 file stays readable for root, and Windows has no POSIX modes.
    if (!rowAReadable && !POSIX_NON_ROOT) return;
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);

    // Row A does not match (the dead-row classifier sees it). Its bytes are present.
    const rowA = s.store.writeUnclaimedCredential(NEW, {
      reason: "consume-gate-persist-failed",
      configSlot: "1",
      consumedFp: "sha256:some-other-generation",
    });
    // Row B is the adoptable successor, behind A.
    const rowB = s.store.writeUnclaimedCredential(NEW, {
      reason: "consume-gate-persist-lock-failed",
      configSlot: "1",
      consumedFp: oauth.credentialFingerprint(OLD),
      fingerprint: oauth.credentialFingerprint(NEW),
    });
    expect(Object.keys(s.store.readStashManifest()), "premise: the dead row is classified before the adoptable one").toEqual(
      [rowA, rowB],
    );

    // A real permission fault replaces the Python patch of `Path.stat` and `Path.read_text`.
    const pathA = s.store.stashEntryPath(rowA);
    let adopted: string | null;
    try {
      if (!rowAReadable) fs.chmodSync(pathA, 0o000);
      adopted = s.adoptStashedSuccessor("1", "test@example.com", OLD);
    } finally {
      fs.chmodSync(pathA, 0o600);
    }

    expect(adopted, "an unreadable dead row aborted the scan before the adoptable row behind it was reached").toBe(NEW);
    expect(
      rowA in s.store.readStashManifest(),
      "a row whose bytes are merely unreadable still holds a real credential; only a byte-less one is free to retire",
    ).toBe(true);
  });
});

describe("TestActiveSlotStrikeParity", () => {
  function switcherWithB(data: SampleData): ClaudeAccountSwitcher {
    data.accounts["2"].email = "b@example.com";
    const s = new ClaudeAccountSwitcher();
    s.setupDirectories();
    s.writeJson(s.sequenceFile, data);
    return s;
  }

  it("test_active_strike_bound_to_backup_not_healed_by_live_fp", () => {
    mockClaudeConfig();
    const s = switcherWithB(sampleSequenceData());
    const deadBackup = oauthCreds("sk-dead", "rt-dead", 1000);
    const live = oauthCreds("sk-live", "rt-live", 2000);
    s.writeAccountCredentials("2", "b@example.com", deadBackup);
    const identities = { "2": ["b@example.com", ""] as [string, string] };
    s.usageStore.record({ "2": { error: "invalid_grant", struckFp: oauth.credentialFingerprint(deadBackup) } }, identities);
    // The stored source of the active slot is the LIVE credential, another lineage than the struck backup.
    const entry = s.usageStore.entries(identities, [])["2"]!;
    expect(
      s.entryTokenDead(entry, "2", "b@example.com", live, true),
      "backup-bound strike must hold while the backup still stores the condemned generation",
    ).toBe(true);
  });

  it("test_idle_slot_keeps_live_fp_heal_semantics", () => {
    mockClaudeConfig();
    const s = switcherWithB(sampleSequenceData());
    const replaced = oauthCreds("sk-re", "rt-re", 2000);
    s.writeAccountCredentials("2", "b@example.com", replaced);
    const identities = { "2": ["b@example.com", ""] as [string, string] };
    s.usageStore.record({ "2": { error: "invalid_grant", struckFp: "sha256:deadbeef" } }, identities);
    const entry = s.usageStore.entries(identities, [])["2"]!;
    expect(s.entryTokenDead(entry, "2", "b@example.com", replaced, false)).toBe(false);
  });

  it("test_active_path_refuses_consume_under_securestorage_env", async () => {
    mockClaudeConfig();
    const s = switcherWithB(sampleSequenceData());
    const expired = oauthCreds("sk-exp", "rt-exp", 1000);
    s.writeAccountCredentials("2", "b@example.com", expired);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/tmp/redir");
    const post = spyRefresh();
    const rec = await s.fetchActiveUsage("2", "b@example.com", expired);
    expect(post).not.toHaveBeenCalled();
    expect(rec.error).toBe("store-unmirrored");
  });

  it("test_degraded_read_never_feeds_resync_write", async () => {
    mockClaudeConfig();
    const s = switcherWithB(sampleSequenceData());
    const fresh = oauthCreds("sk-a", "rt-a", 9999999999000);
    s.recordActiveVerdict(activeCredentials("", false, true));
    const resync = vi.spyOn(s, "resyncRotatedBackup").mockResolvedValue(undefined);
    vi.spyOn(internals, "tryFetchUsageForAccount").mockResolvedValue(
      oauth.usageOutcome({ five_hour: { utilization: 10 } } as unknown as oauth.UsageDict),
    );
    await s.fetchActiveUsage("2", "b@example.com", fresh);
    expect(resync).not.toHaveBeenCalled();
  });
});

describe("TestUltraReviewCoverageGaps", () => {
  const EXPIRED = oauthCreds("sk-active", "rt-orig", 1000);

  function stubUsageFetch(): void {
    vi.spyOn(internals, "tryFetchUsageForAccount").mockResolvedValue(oauth.usageOutcome(null));
  }

  it("test_demotion_downgrades_invalid_grant_when_source_moved", async () => {
    mockClaudeConfig();
    const s = newSwitcher(sampleSequenceData());
    const moved = oauthCreds("sk-moved", "rt-moved", 5000);
    let reads = 0;

    vi.spyOn(s, "readCredentials").mockReturnValue(EXPIRED);
    // The first read is the recovery input. The demotion re-read sees another lineage.
    vi.spyOn(s, "readAccountCredentials").mockImplementation(() => (++reads <= 1 ? EXPIRED : moved));
    spyRefresh().mockResolvedValue(oauth.refreshOutcome(null, "invalid_grant"));
    stubUsageFetch();
    const rec = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(rec.error).toBe("refresh-failed");
    expect(rec.struckFp ?? null).toBeNull();
  });

  it("test_demotion_reread_error_still_strikes", async () => {
    mockClaudeConfig();
    const s = newSwitcher(sampleSequenceData());
    let reads = 0;

    vi.spyOn(s, "readCredentials").mockReturnValue(EXPIRED);
    vi.spyOn(s, "readAccountCredentials").mockImplementation(() => {
      if (++reads <= 1) return EXPIRED;
      throw osError("EIO", 5, "transient read failure");
    });
    spyRefresh().mockResolvedValue(oauth.refreshOutcome(null, "invalid_grant"));
    stubUsageFetch();
    const rec = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(rec.error).toBe("invalid_grant");
  });

  it("test_active_invalid_grant_binds_strike_to_posted_input", async () => {
    mockClaudeConfig();
    const s = newSwitcher(sampleSequenceData());
    vi.spyOn(s, "readCredentials").mockReturnValue(EXPIRED);
    vi.spyOn(s, "readAccountCredentials").mockReturnValue(EXPIRED);
    spyRefresh().mockResolvedValue(oauth.refreshOutcome(null, "invalid_grant"));
    stubUsageFetch();
    const rec = await s.fetchActiveUsage("1", "test@example.com", EXPIRED);

    expect(rec.error).toBe("invalid_grant");
    expect(rec.struckFp).toBe(oauth.credentialFingerprint(EXPIRED));
  });

  it("test_degraded_plus_server_401_defers_with_the_401_record", async () => {
    mockClaudeConfig();
    const s = newSwitcher(sampleSequenceData());
    const fresh = oauthCreds("sk-f", "rt-f", 9999999999000);
    s.recordActiveVerdict(activeCredentials("", false, true));
    vi.spyOn(internals, "tryFetchUsageForAccount").mockResolvedValue(oauth.usageOutcome(null, { error: "http-401" }));
    const post = spyRefresh();
    const rec = await s.fetchActiveUsage("1", "test@example.com", fresh);
    expect(post).not.toHaveBeenCalled();
    expect(rec.error).toBe("http-401");
    expect(rec.sentinel ?? null).toBeNull();
  });

  it("test_add_account_refuses_inside_session_shell", async () => {
    mockClaudeConfig();
    const s = newSwitcher(sampleSequenceData());
    const inside = path.join(s.backupDir, "sessions", "1-test-example-com");
    fs.mkdirSync(inside, { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", inside);
    await expect(s.addAccount()).rejects.toThrow(SwitchError);
  });

  it("test_add_token_refuses_inside_session_shell", () => {
    mockClaudeConfig();
    const s = newSwitcher(sampleSequenceData());
    const inside = path.join(s.backupDir, "sessions", "1-test-example-com");
    fs.mkdirSync(inside, { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", inside);
    expect(() => s.addAccountFromToken("sk-ant-oat01-xyz")).toThrow(SwitchError);
  });

  it("test_gate_success_never_touches_live_store", async () => {
    const s = newSwitcher(sampleSequenceData());
    const old = oauthCreds("a", "rt", 1000);
    const fresh = oauthCreds("b", "rt2", 9999999999000);
    s.writeAccountCredentials("1", "test@example.com", old);
    spyRefresh().mockResolvedValue(oauth.refreshOutcome(fresh, null));
    const writeLive = vi.spyOn(s, "writeCredentials");
    const out = await s.consumeBackupGrant("1", "test@example.com", old);
    expect(out.credentials).toBe(fresh);
    expect(writeLive).not.toHaveBeenCalled();
    expect(s.readAccountCredentials("1", "test@example.com")).toBe(fresh);
  });
});

describe("TestUnreadableBackupIsNotAbsent", () => {
  function macosSwitcher(data: SampleData, email = "test@example.com"): ClaudeAccountSwitcher {
    data.accounts["1"].email = email;
    const s = new ClaudeAccountSwitcher();
    s.platform = Platform.MACOS;
    s.setupDirectories();
    s.writeJson(s.sequenceFile, data);
    return s;
  }

  function lockKeychain(): void {
    keychainInternals.getPassword = raiseLocked;
  }

  it("test_backup_unreadable_after_post_is_not_a_removed_slot", async () => {
    const s = macosSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);
    expect(s.readAccountCredentials("1", "test@example.com")).toBe(OLD);

    spyRefresh().mockImplementation(async () => {
      // The screen locks during the POST.
      lockKeychain();
      return oauth.refreshOutcome(NEW, null);
    });
    const out = await s.consumeBackupGrant("1", "test@example.com", OLD);

    const reasons = Object.values(s.listUnclaimedCredentials()).map((m) => m.reason);
    expect(reasons.length, "the consumed successor must still be stashed").toBeGreaterThan(0);
    expect(reasons, "an unreadable Keychain is not a removed slot").not.toContain("consume-gate-slot-removed");
    expect(
      out.error,
      "the slot still holds the generation whose grant was just spent, so `error is None` tells every caller it is safe to activate",
    ).not.toBeNull();
  });

  it("test_unreadable_backup_never_erases_a_live_dead_token_strike", async () => {
    const s = macosSwitcher(sampleSequenceData(), "b@example.com");
    const live = oauthCreds("sk-live", "rt-live", 9999999999000);
    const deadBackup = OLD;
    s.writeAccountCredentials("1", "b@example.com", deadBackup);
    const identities = { "1": ["b@example.com", ""] as [string, string] };
    // The strike binds to the BACKUP generation. The live credential has rotated since.
    for (let i = 0; i < 6; i++) {
      s.usageStore.record(
        { "1": { error: "invalid_grant", struckFp: oauth.credentialFingerprint(deadBackup) } },
        identities,
      );
    }
    const entry = s.usageStore.entries(identities, [])["1"]!;
    expect(entry.tokenDead(), "the row must be struck to begin with").toBe(true);

    const info: Parameters<typeof s.collectUsageEntries>[0] = [[1, "b@example.com", "", "", true, live, ""]];
    expect(
      s.entryTokenDead(entry, "1", "b@example.com", live, true),
      "with a readable backup the backup-bound strike holds",
    ).toBe(true);

    lockKeychain();
    await s.collectUsageEntries(info, new Set());

    const after = s.usageStore.entries(identities, [])["1"]!;
    expect(after.authDeadStrikes, "one unreadable pass erased the persisted strike count").toBeGreaterThan(0);
    expect(after.struckFingerprint, "one unreadable pass erased the persisted struck fingerprint").not.toBeNull();
  });

  it("test_active_slot_with_zero_strikes_and_unreadable_backup_is_not_dead", () => {
    const s = macosSwitcher(sampleSequenceData(), "b@example.com");
    const live = oauthCreds("sk-live", "rt-live", 9999999999000);
    const identities = { "1": ["b@example.com", ""] as [string, string] };
    const entry = s.usageStore.entries(identities, [])["1"]!;
    expect(entry.authDeadStrikes, "the row must never have been struck").toBe(0);

    lockKeychain();
    expect(
      s.entryTokenDead(entry, "1", "b@example.com", live, true),
      "zero strikes plus an unreadable backup must not report dead",
    ).toBe(false);
  });

  it("test_unreadable_backup_is_not_a_dead_slot_for_import", () => {
    const s = macosSwitcher(sampleSequenceData(), "b@example.com");
    // The strike binds to a generation that the slot no longer stores: the verdict is "healed".
    s.writeAccountCredentials("1", "b@example.com", NEW);
    const identities = { "1": ["b@example.com", ""] as [string, string] };
    for (let i = 0; i < 6; i++) {
      s.usageStore.record({ "1": { error: "invalid_grant", struckFp: "sha256:condemnedgen" } }, identities);
    }
    expect(s.usageStore.entries(identities, [])["1"]!.tokenDead()).toBe(true);
    expect(s.slotTokenDead("1", "b@example.com"), "with a readable backup the strike is healed by the fingerprint").toBe(
      false,
    );

    lockKeychain();
    expect(
      s.slotTokenDead("1", "b@example.com"),
      "an unreadable backup skips the fingerprint binding entirely, so a healthy slot reads as dead and a plain import replaces it",
    ).toBe(false);
  });

  it("test_an_active_slot_with_an_unreadable_backup_is_not_dead_for_import", () => {
    mockClaudeConfig();
    const s = macosSwitcher(sampleSequenceData(), "b@example.com");
    const live = oauthCreds("sk-live", "rt-live", 9999999999000);
    const cfg = s.getClaudeConfigPath();
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    s.writeJson(cfg, {
      oauthAccount: { emailAddress: "b@example.com", accountUuid: "uuid-1", organizationUuid: "", organizationName: "" },
    });
    s.store.writeActiveCredentialsFile(live);
    s.writeAccountCredentials("1", "b@example.com", NEW);
    expect(s.currentAccountNumber()).toBe("1");

    const identities = { "1": ["b@example.com", ""] as [string, string] };
    // The strike binds to a generation that NEITHER stored source holds: healed.
    for (let i = 0; i < 6; i++) {
      s.usageStore.record({ "1": { error: "invalid_grant", struckFp: "sha256:condemnedgen" } }, identities);
    }
    expect(s.usageStore.entries(identities, [])["1"]!.tokenDead()).toBe(true);
    expect(s.slotTokenDead("1", "b@example.com")).toBe(false);

    lockKeychain();
    expect(
      s.slotTokenDead("1", "b@example.com"),
      "the active path delegates to the collectors' rule, which holds an unprovable strike — correct there, destructive here",
    ).toBe(false);
  });

  it("test_active_read_error_is_not_condemned_as_dead", () => {
    mockClaudeConfig();
    const s = new ClaudeAccountSwitcher();
    s.platform = Platform.LINUX;
    s.setupDirectories();
    const data = sampleSequenceData();
    data.accounts["1"].email = "b@example.com";
    s.writeJson(s.sequenceFile, data);
    const dead = oauthCreds("sk-dead", "rt-dead", 1000);
    const live = oauthCreds("sk-live", "rt-live", 9999999999000);
    const cfg = s.getClaudeConfigPath();
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    s.writeJson(cfg, {
      oauthAccount: { emailAddress: "b@example.com", accountUuid: "uuid-1", organizationUuid: "", organizationName: "" },
    });
    const identities = { "1": ["b@example.com", ""] as [string, string] };
    for (let i = 0; i < 6; i++) {
      s.usageStore.record(
        { "1": { error: "invalid_grant", struckFp: oauth.credentialFingerprint(dead) } },
        identities,
      );
    }
    expect(s.usageStore.entries(identities, [])["1"]!.tokenDead(), "premise: the row must be struck to begin with").toBe(
      true,
    );

    const readActive = vi.spyOn(s.store, "readActiveCredentials");
    const verdict = (activeValue: string | null): boolean => {
      readActive.mockReturnValue(activeCredentials(activeValue, false, false));
      return s.slotTokenDead("1", "b@example.com");
    };
    vi.spyOn(s, "currentAccountNumber").mockReturnValue("1");

    expect(verdict(dead), "control A broken: the instrument never says yes (matches struck)").toBe(true);
    expect(verdict(live), "control B broken: the instrument never says no (replaced since)").toBe(false);
    expect(
      verdict(null),
      "an active credential that could not be READ (plaintext-file error) was condemned as refresh-token-dead",
    ).toBe(false);
  });
});

describe("TestStashReaderUnreadableVsAbsent", () => {
  function stashSuccessor(s: ClaudeAccountSwitcher): string {
    return s.store.writeUnclaimedCredential(NEW, {
      reason: "consume-gate-persist-lock-failed",
      configSlot: "1",
      consumedFp: oauth.credentialFingerprint(OLD),
      fingerprint: oauth.credentialFingerprint(NEW),
    });
  }

  /** The tests here only give the gate the spent snapshot. An adopted successor never reaches the POST. */
  async function postRejectsSpent(credentials: string): Promise<oauth.RefreshOutcome> {
    expect(credentials, "posted something other than the spent snapshot").toBe(OLD);
    return oauth.refreshOutcome(null, "invalid_grant");
  }

  it.skipIf(!POSIX_NON_ROOT)("test_row_a_unreadable_entry_does_not_post_the_spent_generation", async () => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);
    const entryPath = s.store.stashEntryPath(stashSuccessor(s));
    fs.chmodSync(entryPath, 0o000);
    const post = spyRefresh().mockImplementation(postRejectsSpent);
    let out: oauth.RefreshOutcome;
    try {
      out = await s.consumeBackupGrant("1", "test@example.com", OLD);
    } finally {
      fs.chmodSync(entryPath, 0o600);
    }

    expect(
      post,
      "DEFECT: an unreadable stash entry made adoption fall through and POST the spent generation it was supposed to replace",
    ).not.toHaveBeenCalled();
    expect(out.error, `unreadable stash entry -> error=${out.error}; the gate must defer`).toBe("stash-unreadable");
    expect(
      Object.keys(s.listUnclaimedCredentials()).length,
      "the entry must survive for the next pass to adopt",
    ).toBeGreaterThan(0);
  });

  it("test_row_b_control_readable_entry_adopts", async () => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);
    stashSuccessor(s);

    const post = spyRefresh();
    const out = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(post, "adopted successor must short-circuit the POST").not.toHaveBeenCalled();
    expect(out.error).toBeNull();
    expect(out.credentials).toBe(NEW);
    expect(s.listUnclaimedCredentials(), "stash entry consumed").toEqual({});
  });

  it("test_row_c_control_nothing_stashed_posts_the_snapshot", async () => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);

    const post = spyRefresh().mockImplementation(postRejectsSpent);
    const out = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(post).toHaveBeenCalled();
    expect(out.error).toBe("invalid_grant");
  });

  it.skipIf(!POSIX_NON_ROOT)("test_corrupt_entry_keeps_its_current_behaviour", async () => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);
    const entryPath = s.store.stashEntryPath(stashSuccessor(s));
    fs.writeFileSync(entryPath, "not-valid-base64!!!", "utf8");

    const post = spyRefresh().mockImplementation(postRejectsSpent);
    const out = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(post, "a corrupt (undecodable) entry must behave like ABSENT, not like unreadable").toHaveBeenCalled();
    expect(out.error).toBe("invalid_grant");
    expect(
      s.readAccountCredentials("1", "test@example.com"),
      "an unreadable/undecodable stash entry must never be written into the slot",
    ).toBe(OLD);
  });

  it("test_row_d_absent_entry_bytes_terminate_instead_of_deferring", async () => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);
    fs.unlinkSync(s.store.stashEntryPath(stashSuccessor(s)));

    const post = spyRefresh().mockImplementation(postRejectsSpent);
    const out = await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(post, "an absent entry must not defer -- nothing can ever adopt bytes that are already gone").toHaveBeenCalled();
    expect(out.error).toBe("invalid_grant");
  });

  it("test_absent_entry_is_retired_not_rescanned_forever", async () => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);
    fs.unlinkSync(s.store.stashEntryPath(stashSuccessor(s)));

    spyRefresh().mockImplementation(postRejectsSpent);
    await s.consumeBackupGrant("1", "test@example.com", OLD);

    expect(
      s.listUnclaimedCredentials(),
      "an absent-bytes stash entry must be retired once the gate confirms it can never be adopted",
    ).toEqual({});
  });

  it.skipIf(!POSIX_NON_ROOT)("test_unreadable_row_does_not_starve_a_readable_sibling", async () => {
    const s = newSwitcher(sampleSequenceData());
    s.writeAccountCredentials("1", "test@example.com", OLD);
    const unreadableId = stashSuccessor(s);
    const entryPath = s.store.stashEntryPath(unreadableId);
    fs.chmodSync(entryPath, 0o000);
    let out: oauth.RefreshOutcome;
    let secondId: string;
    const post = spyRefresh();
    try {
      // A second, readable row on the SAME generation must still be reached and adopted.
      secondId = s.store.writeUnclaimedCredential(NEW, {
        reason: "consume-gate-persist-lock-failed",
        configSlot: "1",
        consumedFp: oauth.credentialFingerprint(OLD),
        fingerprint: oauth.credentialFingerprint(NEW),
      });
      out = await s.consumeBackupGrant("1", "test@example.com", OLD);
    } finally {
      fs.chmodSync(entryPath, 0o600);
    }

    expect(
      post,
      "a readable sibling on the same generation must be adopted instead of POSTing the spent snapshot",
    ).not.toHaveBeenCalled();
    expect(
      out.credentials,
      `expected the readable sibling's credentials to be adopted (error=${out.error}) -- the unreadable row starved the scan`,
    ).toBe(NEW);
    expect(Object.keys(s.listUnclaimedCredentials())).not.toContain(secondId);
  });
});

describe("TestSessionShellGuardCoversEveryMutator", () => {
  function shellSwitcher(data: SampleData): ClaudeAccountSwitcher {
    mockClaudeConfig();
    const s = newSwitcher(data);
    const inside = path.join(s.backupDir, "sessions", "1-test-example-com");
    fs.mkdirSync(inside, { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", inside);
    return s;
  }

  it("test_remove_account_refuses_inside_a_session_shell", () => {
    const s = shellSwitcher(sampleSequenceData());
    expect(() => s.removeAccount("2", true)).toThrow(SwitchError);
    expect((s.getSequenceData() as SequenceData).sequence, "the roster was mutated from inside a session shell").toEqual([
      1, 2,
    ]);
  });

  it("test_swap_accounts_refuses_inside_a_session_shell", () => {
    const s = shellSwitcher(sampleSequenceData());
    expect(() => s.swapAccounts("1", "2")).toThrow(SwitchError);
  });

  it("test_move_account_refuses_inside_a_session_shell", () => {
    const s = shellSwitcher(sampleSequenceData());
    expect(() => s.moveAccount("2", "5")).toThrow(SwitchError);
  });

  it("test_purge_refuses_inside_a_session_shell", () => {
    // The guard must refuse BEFORE the confirmation prompt.
    const s = shellSwitcher(sampleSequenceData());
    const prompt = vi.spyOn(internals, "input").mockReturnValue("n");
    expect(() => s.purge()).toThrow(SwitchError);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("test_set_alias_refuses_inside_a_session_shell", () => {
    const s = shellSwitcher(sampleSequenceData());
    expect(() => s.setAlias("2", "work")).toThrow(SwitchError);
  });

  it("test_unset_alias_refuses_inside_a_session_shell", () => {
    const s = shellSwitcher(sampleSequenceData());
    expect(() => s.unsetAlias("2")).toThrow(SwitchError);
  });
});
