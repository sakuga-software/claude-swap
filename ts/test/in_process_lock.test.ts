import { describe, expect, it, vi } from "vitest";
import { LockError } from "../src/exceptions.js";
import { internals as oauthInternals, refreshOutcome, usageOutcome } from "../src/oauth.js";
import { ClaudeAccountSwitcher, whenNoLockHeldInProcess } from "../src/switcher.js";
import { internals } from "../src/switcher/internals.js";
import { mockClaudeConfig, sampleSequenceData } from "./helpers/fixtures.js";

const EXPIRED = JSON.stringify({ claudeAiOauth: { accessToken: "sk-a", refreshToken: "rt-a", expiresAt: 1000 } });
const FRESH = JSON.stringify({ claudeAiOauth: { accessToken: "sk-b", refreshToken: "rt-b", expiresAt: 9999999999000 } });

/** The TUI runs the refresh lane and the actions in one process. Python runs them on two threads. */
describe("TestSyncMutatorBesideAnAsyncLockHolder", () => {
  it("test_sync_mutator_fails_fast_instead_of_blocking_the_holder", async () => {
    mockClaudeConfig();
    const data = sampleSequenceData();
    data.accounts["1"].email = "test@example.com";
    const s = new ClaudeAccountSwitcher();
    s.setupDirectories();
    s.writeJson(s.sequenceFile, data);
    vi.spyOn(s, "readCredentials").mockReturnValue(EXPIRED);
    vi.spyOn(s, "readAccountCredentials").mockReturnValue(EXPIRED);
    vi.spyOn(s, "writeCredentials").mockImplementation(() => {});
    vi.spyOn(s, "writeAccountCredentials").mockImplementation(() => {});
    vi.spyOn(internals, "tryFetchUsageForAccount").mockResolvedValue(usageOutcome(null));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let posted = false;
    vi.spyOn(oauthInternals, "tryRefreshOauthCredentials").mockImplementation(async () => {
      posted = true;
      await gate;
      return refreshOutcome(FRESH, null);
    });

    const refresh = s.fetchActiveUsage("1", "test@example.com", EXPIRED);
    await vi.waitFor(() => expect(posted).toBe(true));

    const started = Date.now();
    expect(() => s.persistBackupCredentials("2", "account2@example.com", FRESH)).toThrow(LockError);
    expect(Date.now() - started).toBeLessThan(1000);

    const idle = whenNoLockHeldInProcess(5);
    release();
    await refresh;
    await idle;
    expect(() => s.persistBackupCredentials("2", "account2@example.com", FRESH)).not.toThrow();
  });
});
