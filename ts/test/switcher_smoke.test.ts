import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "../src/models.js";
import { internals as oauthInternals, refreshOutcome } from "../src/oauth.js";
import type { SessionHost } from "../src/session.js";
import {
  ClaudeAccountSwitcher,
  ERROR_NOTES,
  SENTINEL_NOTES,
  formatUsageLines,
  internals,
} from "../src/switcher.js";
import { testHome } from "./helpers/home.js";

const FUTURE_MS = Date.now() + 3600_000;

function creds(tag: string, expiresAt = FUTURE_MS): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: `at-${tag}`, refreshToken: `rt-${tag}`, expiresAt, scopes: ["user:inference"] },
  });
}

/** Log in as `email` on this machine: the live config and the live credential file. */
function login(email: string, uuid: string, credentials: string): void {
  const home = testHome();
  const configPath = path.join(home, ".claude.json");
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.oauthAccount = { emailAddress: email, accountUuid: uuid, organizationUuid: "", organizationName: "" };
  config.projects = { "/tmp/p": {} };
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), credentials);
}

function liveConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(testHome(), ".claude.json"), "utf8")) as Record<string, unknown>;
}

function liveCredentials(): string {
  return fs.readFileSync(path.join(testHome(), ".claude", ".credentials.json"), "utf8");
}

function newSwitcher(): ClaudeAccountSwitcher {
  const s = new ClaudeAccountSwitcher();
  s.platform = Platform.LINUX;
  return s;
}

let stdout: string[];

beforeEach(() => {
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  internals.FETCH_STAGGER_S = 0;
  oauthInternals.requestUsageData = async () => ({
    five_hour: { utilization: 12, resets_at: null },
    seven_day: { utilization: 34, resets_at: null },
  });
});

afterEach(() => {
  internals.FETCH_STAGGER_S = 0.25;
});

describe("ClaudeAccountSwitcherSmoke", () => {
  it("constructs_inside_the_isolated_home", () => {
    const s = new ClaudeAccountSwitcher();
    const host: SessionHost = s;
    expect(host.backupDir.startsWith(testHome())).toBe(true);
    expect(s.sequenceFile).toBe(path.join(s.backupDir, "sequence.json"));
    expect(s.getSequenceData()).toBeNull();
    expect(s.validateEmail("user@example.com")).toBe(true);
    expect(s.validateEmail("user@com")).toBe(false);
  });

  it("add_list_and_switch_between_two_accounts", async () => {
    const s = newSwitcher();
    login("a@example.com", "uuid-a", creds("a"));
    await s.addAccount();
    login("b@example.com", "uuid-b", creds("b"));
    await s.addAccount();

    const data = s.getSequenceData()!;
    expect(data.sequence).toEqual([1, 2]);
    expect(data.activeAccountNumber).toBe(2);
    expect(s.readAccountCredentials("1", "a@example.com")).toBe(creds("a"));

    const payload = (await s.listAccounts(false, true))!;
    expect(payload.activeAccountNumber).toBe(2);
    const rows = payload.accounts as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.usageStatus)).toEqual(["ok", "ok"]);
    expect((rows[0]!.usage as Record<string, unknown>).fiveHour).toBeDefined();

    const result = (await s.switchTo("1", true))!;
    expect(result.switched).toBe(true);
    expect(result.from).toEqual({ number: 2, email: "b@example.com" });
    expect(result.to).toEqual({ number: 1, email: "a@example.com" });
    expect((liveConfig().oauthAccount as Record<string, unknown>).emailAddress).toBe("a@example.com");
    expect(liveConfig().projects).toEqual({ "/tmp/p": {} });
    expect(JSON.parse(liveCredentials()).claudeAiOauth.accessToken).toBe("at-a");
    expect(s.getSequenceData()!.activeAccountNumber).toBe(1);
    // The outgoing live credential went back to its own slot.
    expect(s.readAccountCredentials("2", "b@example.com")).toBe(creds("b"));

    const again = (await s.switchTo("1", true))!;
    expect(again.switched).toBe(false);
    expect(again.reason).toBe("already-active");
  });

  it("plain_rotation_prints_the_human_view", async () => {
    const s = newSwitcher();
    login("a@example.com", "uuid-a", creds("a"));
    await s.addAccount();
    login("b@example.com", "uuid-b", creds("b"));
    await s.addAccount();
    stdout.length = 0;

    expect(await s.switch()).toBeNull();
    const text = stdout.join("");
    expect(text).toContain("Switched to Account-1 (a@example.com)");
    expect(text).toContain("Accounts:");
    expect(text).toContain("  1: a@example.com [personal] (active)");
    expect(text).toContain("New account is active on your next message — no restart needed.");
  });

  it("token_accounts_alias_move_and_remove", async () => {
    const s = newSwitcher();
    s.addAccountFromToken("sk-ant-oat-setup", null, null, true);
    s.addAccountFromToken("sk-ant-api03-key", "key@example.com");
    const data = s.getSequenceData()!;
    expect(data.accounts!["1"]!.email).toBe("setup-token-1@token.local");
    expect(data.accounts!["2"]!.kind).toBe("api_key");
    expect(s.readAccountCredentials("2", "key@example.com")).toBe("sk-ant-api03-key");
    expect(JSON.parse(s.readAccountCredentials("1", "setup-token-1@token.local"))).toEqual({
      claudeAiOauth: { accessToken: "sk-ant-oat-setup", scopes: ["user:inference"] },
    });

    expect(s.setAlias("2", "Work")).toEqual(["2", "work"]);
    expect(s.resolveAccount("work")).toEqual(["2", "key@example.com", ""]);
    expect(s.moveAccount("work", "5")).toEqual(["2", "5", false]);
    expect(s.getSequenceData()!.sequence).toEqual([1, 5]);
    expect(s.readAccountCredentials("5", "key@example.com")).toBe("sk-ant-api03-key");
    expect(s.swapAccounts("1", "5")).toEqual(["1", "5"]);
    expect(s.getSequenceData()!.accounts!["1"]!.email).toBe("key@example.com");

    s.removeAccount("work", true);
    expect(Object.keys(s.getSequenceData()!.accounts!)).toEqual(["5"]);
    expect(stdout.join("")).toContain("Removed Account-1 (key@example.com)");
  });

  it("consume_gate_persists_a_refreshed_backup", async () => {
    const s = newSwitcher();
    login("a@example.com", "uuid-a", creds("a"));
    await s.addAccount();
    const expired = creds("old", 1000);
    s.writeAccountCredentials("1", "a@example.com", expired);
    const refresh = vi.fn(async () => refreshOutcome(creds("new"), null));
    oauthInternals.tryRefreshOauthCredentials = refresh;

    const out = await s.consumeBackupGrant("1", "a@example.com", expired);

    expect(refresh).toHaveBeenCalledOnce();
    expect(out.error).toBeNull();
    expect(out.credentials).toBe(creds("new"));
    expect(s.readAccountCredentials("1", "a@example.com")).toBe(creds("new"));
    expect(Object.keys(s.listUnclaimedCredentials())).toEqual([]);
  });

  it("concurrent_gates_on_one_slot_post_once", async () => {
    const s = newSwitcher();
    login("a@example.com", "uuid-a", creds("a"));
    await s.addAccount();
    const expired = creds("old", 1000);
    s.writeAccountCredentials("1", "a@example.com", expired);
    const refresh = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return refreshOutcome(creds("new"), null);
    });
    oauthInternals.tryRefreshOauthCredentials = refresh;

    const started = Date.now();
    const [first, second] = await Promise.all([
      s.consumeBackupGrant("1", "a@example.com", expired),
      s.consumeBackupGrant("1", "a@example.com", expired),
    ]);

    // The second gate waits for the first without a blocked event loop, then adopts its successor.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(refresh).toHaveBeenCalledOnce();
    expect(first.credentials).toBe(creds("new"));
    expect(second.credentials).toBe(creds("new"));
    expect(second.error).toBeNull();
  });

  it("expired_active_token_is_refreshed_under_the_locks", async () => {
    const s = newSwitcher();
    login("a@example.com", "uuid-a", creds("a", 1000));
    await s.addAccount();
    const refresh = vi.fn(async () => refreshOutcome(creds("new"), null));
    oauthInternals.tryRefreshOauthCredentials = refresh;

    const payload = (await s.listAccounts(false, true))!;

    expect(refresh).toHaveBeenCalledOnce();
    expect(JSON.parse(liveCredentials()).claudeAiOauth.accessToken).toBe("at-new");
    expect(s.readAccountCredentials("1", "a@example.com")).toBe(creds("new"));
    expect((payload.accounts as Array<Record<string, unknown>>)[0]!.usageStatus).toBe("ok");
    // Every lock was released: a second pass and a switch-time lock work at once.
    s.persistBackupCredentials("1", "a@example.com", creds("new"));
  });

  it("usage_aware_strategies_report_json_no_ops", async () => {
    const s = newSwitcher();
    login("a@example.com", "uuid-a", creds("a"));
    await s.addAccount();
    login("b@example.com", "uuid-b", creds("b"));
    await s.addAccount();

    const best = (await s.switch("best", true))!;
    expect(best).toMatchObject({ switched: false, strategy: "best", reason: "already-best" });
    expect(best.message).toBe("Already on the account with the most remaining quota (Account-2).");

    oauthInternals.requestUsageData = async () => ({
      five_hour: { utilization: 100, resets_at: null },
      seven_day: { utilization: 34, resets_at: null },
    });
    const later = new ClaudeAccountSwitcher();
    later.platform = Platform.LINUX;
    later.usageStore.clock = () => Date.now() / 1000 + 3600;
    const next = (await later.switch("next-available", true))!;
    expect(next).toMatchObject({ switched: false, reason: "candidates-exhausted" });
    expect(next.warnings).toEqual(["Skipped Account-1 (at 5h/7d limit)"]);
  });

  it("purge_removes_the_backup_dir", async () => {
    const s = newSwitcher();
    login("a@example.com", "uuid-a", creds("a"));
    await s.addAccount();
    vi.spyOn(internals, "input").mockReturnValue("y");

    s.purge();

    expect(fs.existsSync(s.backupDir)).toBe(false);
    expect(stdout.join("")).toContain("Purge complete.");
  });

  it("first_run_setup_uses_the_input_seam", async () => {
    const s = newSwitcher();
    login("a@example.com", "uuid-a", creds("a"));
    const input = vi.spyOn(internals, "input").mockReturnValue("y");

    expect(await s.listAccounts()).toBeNull();

    expect(input).toHaveBeenCalledOnce();
    expect(s.getSequenceData()!.accounts!["1"]!.email).toBe("a@example.com");
  });

  it("usage_lines_and_notes", () => {
    const lines = formatUsageLines({ five_hour: { pct: 2.5 }, seven_day: { pct: 40 }, scoped: [{ name: "Fable", pct: 100 }] });
    expect(lines).toEqual(["5h:      2%", "7d:     40%", "Fable: 100%  (!)"]);
    expect(SENTINEL_NOTES["api key"]).toBe("API key (no quota)");
    expect(ERROR_NOTES["consume-busy"]).toContain("another cswap surface");
  });
});
