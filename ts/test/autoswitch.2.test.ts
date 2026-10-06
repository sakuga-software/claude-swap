import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AllExhaustedEvent,
  ConfigWarningEvent,
  ErrorEvent,
  NO_RESET_FALLBACK_S,
  NoSwitchEvent,
  PollEvent,
  QuarantineEvent,
  SwitchEvent,
  TickOutcome,
  UnquarantineEvent,
  pctLabel,
} from "../src/autoswitch.js";
import * as oauth from "../src/oauth.js";
import * as pollPolicy from "../src/poll_policy.js";
import type { AutoSwitchSettings } from "../src/settings.js";
import { UsageEntry } from "../src/usage_store.js";
import { testHome } from "./helpers/home.js";
import { EngineHarness, entryFor, makeHarness, usage } from "./helpers/autoswitch_harness.js";

type Dict = Record<string, unknown>;

function liveCredsPath(): string {
  return path.join(testHome(), ".claude", ".credentials.json");
}

function refreshSpy() {
  return vi.spyOn(oauth.internals, "tryRefreshOauthCredentials");
}

function find<T>(events: unknown[], cls: new (...args: never[]) => T): T {
  const found = events.find((e) => e instanceof cls);
  if (found === undefined) throw new Error(`no ${cls.name} event`);
  return found as T;
}

function quarantineOf(h: EngineHarness): Record<string, Dict> {
  return (h.state().quarantine ?? {}) as Record<string, Dict>;
}

function modelUsage(fiveH: number, fable: number): Dict {
  return {
    five_hour: { pct: fiveH },
    seven_day: { pct: 0.0 },
    scoped: [{ name: "Fable", pct: fable }],
  };
}

describe("TestApiKeyAccounts", () => {
  function markApiKey(h: EngineHarness, num: number): void {
    const data = h.switcher.getSequenceData()!;
    (data.accounts![String(num)] as Dict).kind = "api_key";
    h.switcher.writeJson(h.switcher.sequenceFile, data);
  }

  it("test_api_key_candidate_excluded_by_default", async () => {
    const h = new EngineHarness();
    h.seed(1, "a@example.com");
    h.seed(2, "key@token.local");
    h.makeLive("a@example.com", 1);
    markApiKey(h, 2);
    const outcome = await h.tickWithUsage({ "1": usage(95), "2": "api key" });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    expect(h.activeNumber()).toBe(1);
  });

  it("test_api_key_is_last_resort_when_included", async () => {
    const h = new EngineHarness(null, { includeApiKeyAccounts: true });
    h.seed(1, "a@example.com");
    h.seed(2, "key@token.local");
    h.seed(3, "c@example.com");
    h.makeLive("a@example.com", 1);
    markApiKey(h, 2);
    const outcome = await h.tickWithUsage({ "1": usage(95), "2": "api key", "3": usage(10) });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(3);
  });

  it("test_api_key_used_when_oauth_exhausted", async () => {
    const h = new EngineHarness(null, { includeApiKeyAccounts: true });
    h.seed(1, "a@example.com");
    h.seed(2, "key@token.local");
    h.seed(3, "c@example.com");
    h.makeLive("a@example.com", 1);
    markApiKey(h, 2);
    const outcome = await h.tickWithUsage({ "1": usage(100), "2": "api key", "3": usage(100) });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
  });

  it("test_active_api_key_idles_engine", async () => {
    const h = new EngineHarness();
    h.seed(1, "key@token.local");
    h.seed(2, "b@example.com");
    h.makeLive("key@token.local", 1);
    markApiKey(h, 1);
    const outcome = await h.tickWithUsage({ "1": "api key", "2": usage(10) });
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(h.reasons()).toEqual(["active-api-key"]);
  });
});

describe("TestFreshening", () => {
  it("test_near_expiry_target_is_refreshed_and_persisted", async () => {
    const h = new EngineHarness();
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com", { expiresAt: Math.trunc(h.clock() * 1000) + 60_000 });
    h.makeLive("a@example.com", 1);

    const rotated = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-2-new",
        refreshToken: "rt-2-new",
        expiresAt: Math.trunc(h.clock() * 1000) + 3_600_000,
      },
    });
    const liveBefore = fs.readFileSync(liveCredsPath(), "utf8");
    const mockRefresh = refreshSpy().mockResolvedValue(oauth.refreshOutcome(rotated, null));
    const outcome = await h.tickWithUsage({ "1": usage(95), "2": usage(10) });

    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    const liveAfter = fs.readFileSync(liveCredsPath(), "utf8");
    expect(liveAfter).toContain("sk-2-new");
    expect(liveAfter).not.toBe(liveBefore);
  });

  it("test_fresh_target_is_not_refreshed", async () => {
    const h = new EngineHarness();
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com", { expiresAt: Math.trunc(h.clock() * 1000) + 3_600_000 });
    h.makeLive("a@example.com", 1);
    const mockRefresh = refreshSpy();
    const outcome = await h.tickWithUsage({ "1": usage(95), "2": usage(10) });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("test_invalid_grant_quarantines_and_tries_next", async () => {
    const h = new EngineHarness();
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com", { expiresAt: 1 });
    h.seed(3, "c@example.com");
    h.makeLive("a@example.com", 1);
    refreshSpy().mockResolvedValue(oauth.refreshOutcome(null, "invalid_grant"));
    const outcome = await h.tickWithUsage({ "1": usage(95), "2": usage(10), "3": usage(20) });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(3);
    const q = find(h.events, QuarantineEvent);
    expect([q.number, q.reason]).toEqual(["2", "invalid_grant"]);
    expect(quarantineOf(h)).toHaveProperty("2");
  });

  it("test_transient_failure_skips_without_quarantine", async () => {
    const h = new EngineHarness();
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com", { expiresAt: 1 });
    h.makeLive("a@example.com", 1);
    refreshSpy().mockResolvedValue(oauth.refreshOutcome(null, "transient"));
    const outcome = await h.tickWithUsage({ "1": usage(95), "2": usage(10) });
    expect(outcome).toBe(TickOutcome.ERROR);
    expect(h.activeNumber()).toBe(1);
    expect(Object.keys(quarantineOf(h))).toHaveLength(0);
    expect(h.events.some((e) => e instanceof ErrorEvent)).toBe(true);
  });

  it("test_live_session_target_is_skipped_even_with_fresh_token", async () => {
    // Auto never activates an account with a live `cswap run` session: two owners of one refresh token.
    const h = new EngineHarness();
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com", { expiresAt: Math.trunc(h.clock() * 1000) + 3_600_000 });
    h.makeLive("a@example.com", 1);
    vi.spyOn(h.switcher, "liveSessionPidsFor").mockReturnValue([4242]);
    const mockRefresh = refreshSpy();
    const outcome = await h.tickWithUsage({ "1": usage(95), "2": usage(10) });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(h.activeNumber()).toBe(1);
  });

  it("test_live_session_near_expiry_is_skipped", async () => {
    const h = new EngineHarness();
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com", { expiresAt: 1 });
    h.makeLive("a@example.com", 1);
    vi.spyOn(h.switcher, "liveSessionPidsFor").mockReturnValue([4242]);
    const mockRefresh = refreshSpy();
    const outcome = await h.tickWithUsage({ "1": usage(95), "2": usage(10) });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(h.activeNumber()).toBe(1);
  });
});

describe("TestQuarantineLifecycle", () => {
  it("test_quarantine_persists_across_engine_instances", async () => {
    const harness = makeHarness();
    harness.engine.quarantine("2", "b@example.com", "invalid_grant");
    harness.events.length = 0;
    const freshEngine = harness.makeEngine();
    const values = { "1": usage(95), "2": usage(0), "3": usage(50) };
    const entries: Record<string, UsageEntry> = {};
    for (const [num, value] of Object.entries(values)) entries[num] = entryFor(value, harness.clock.now);
    vi.spyOn(harness.switcher, "usageEntriesByAccount").mockResolvedValue(entries);
    const outcome = await freshEngine.tick();
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber()).toBe(3);
  });

  it("test_replaced_credentials_lift_quarantine", async () => {
    const harness = makeHarness();
    harness.engine.quarantine("2", "b@example.com", "invalid_grant");
    harness.switcher.writeAccountCredentials(
      "2",
      "b@example.com",
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-2b", refreshToken: "rt-2b" } }),
    );
    harness.events.length = 0;
    const outcome = await harness.tickWithUsage({ "1": usage(95), "2": usage(0), "3": usage(50) });
    expect(harness.events.some((e) => e instanceof UnquarantineEvent)).toBe(true);
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber()).toBe(2);
    expect(quarantineOf(harness)).not.toHaveProperty("2");
  });

  it("test_state_lock_preserves_concurrent_writes", () => {
    const harness = makeHarness();
    harness.engine.mutateState((s) => {
      s.quarantine ??= {};
      (s.quarantine as Dict)["3"] = {
        email: "c@example.com",
        reason: "invalid_grant",
        at: "x",
        refreshTokenFingerprint: null,
      };
    });
    harness.engine.mutateState((s) => {
      s.lastSwitchAt = 123.0;
    });
    const state = harness.state();
    expect(state.lastSwitchAt).toBe(123.0);
    expect(state.quarantine).toHaveProperty("3");
  });
});

describe("TestDryRunAndNoOp", () => {
  it("test_dry_run_mutates_nothing", async () => {
    const h = new EngineHarness();
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com");
    h.makeLive("a@example.com", 1);
    h.engine = h.makeEngine({ dryRun: true });
    const liveBefore = fs.readFileSync(liveCredsPath(), "utf8");

    const outcome = await h.tickWithUsage({ "1": usage(95), "2": usage(10) });

    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(find(h.events, SwitchEvent).dryRun).toBe(true);
    expect(h.activeNumber()).toBe(1);
    expect(fs.readFileSync(liveCredsPath(), "utf8")).toBe(liveBefore);
    expect(h.state()).toEqual({});
  });

  it("test_dry_run_never_freshens_or_quarantines", async () => {
    // Dry-run stops at the decision: no refresh of a near-expiry target, no quarantine write.
    const h = new EngineHarness();
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com", { expiresAt: 1 });
    h.makeLive("a@example.com", 1);
    h.engine = h.makeEngine({ dryRun: true });
    const backupBefore = h.switcher.readAccountCredentials("2", "b@example.com");

    const mockRefresh = refreshSpy();
    const outcome = await h.tickWithUsage({ "1": usage(95), "2": usage(10) });

    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(h.switcher.readAccountCredentials("2", "b@example.com")).toBe(backupBefore);
    expect(h.state()).toEqual({});
  });

  it("test_dry_run_does_not_release_quarantines", async () => {
    const h = new EngineHarness();
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com");
    h.makeLive("a@example.com", 1);
    h.engine.quarantine("2", "b@example.com", "invalid_grant");
    h.switcher.writeAccountCredentials(
      "2",
      "b@example.com",
      JSON.stringify({ claudeAiOauth: { accessToken: "n", refreshToken: "n" } }),
    );
    h.events.length = 0;
    h.engine = h.makeEngine({ dryRun: true });
    const stateBefore = h.state();

    const outcome = await h.tickWithUsage({ "1": usage(95), "2": usage(10) });

    expect(h.events.some((e) => e instanceof UnquarantineEvent)).toBe(false);
    expect(h.state()).toEqual(stateBefore);
    expect(outcome).toBe(TickOutcome.BLOCKED);
  });

  it("test_already_active_result_is_noop", async () => {
    const harness = makeHarness();
    vi.spyOn(harness.switcher, "switchTo").mockResolvedValue({
      switched: false,
      reason: "already-active",
    } as unknown as Awaited<ReturnType<typeof harness.switcher.switchTo>>);
    const outcome = await harness.tickWithUsage({ "1": usage(95), "2": usage(10), "3": usage(50) });
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(harness.state()).not.toHaveProperty("lastSwitchAt");
  });
});

describe("TestEventsShape", () => {
  it("test_every_event_has_envelope", async () => {
    const harness = makeHarness();
    await harness.tickWithUsage({ "1": usage(95), "2": usage(10), "3": usage(50) });
    expect(harness.events.length).toBeGreaterThan(0);
    for (const event of harness.events) {
      const payload = event.toJson();
      expect(payload.schemaVersion).toBe(1);
      expect(payload.event).toBe(event.kind);
      expect(String(payload.ts).endsWith("Z")).toBe(true);
    }
  });

  it("test_switch_event_refs_match_account_ref_shape", async () => {
    const harness = makeHarness();
    await harness.tickWithUsage({ "1": usage(95), "2": usage(10), "3": usage(50) });
    const payload = find(harness.events, SwitchEvent).toJson();
    expect(payload.from).toEqual({ number: 1, email: "a@example.com" });
    expect(payload.to).toEqual({ number: 2, email: "b@example.com" });
  });

  it("test_poll_event_human_line", async () => {
    const harness = makeHarness();
    await harness.tickWithUsage({ "1": usage(42), "2": usage(10), "3": null });
    const line = find(harness.events, PollEvent).human();
    expect(line).toContain("Account-1");
    expect(line).toContain("42% used");
    expect(line).toContain("#2: 5h 10% · 7d 0%");
    expect(line).toContain("#3: ?");
  });

  it("test_poll_event_windows_match_the_decision_set", async () => {
    // Scoped windows appear only when configured: an ignored Fable 100% next to a switch onto it reads as a bug.
    const values = {
      "1": usage(42),
      "2": {
        five_hour: { pct: 3.0 },
        seven_day: { pct: 89.0 },
        scoped: [{ name: "Fable", pct: 21.0 }],
      },
    };
    const build = (kw: Partial<AutoSwitchSettings> = {}) => {
      const h = new EngineHarness(null, kw);
      h.seed(1, "a@example.com");
      h.seed(2, "b@example.com");
      h.makeLive("a@example.com", 1);
      return h;
    };

    const plain = build();
    await plain.tickWithUsage(values);
    let poll = find(plain.events, PollEvent);
    expect(poll.human()).toContain("#2: 5h 3% · 7d 89%");
    expect(poll.human()).not.toContain("Fable");
    expect((poll.toJson().windowsPct as Dict)["2"]).toEqual({ "5h": 3.0, "7d": 89.0 });

    const modeled = build({ model: "Fable" });
    await modeled.tickWithUsage(values);
    poll = find(modeled.events, PollEvent);
    expect(poll.human()).toContain("#2: 5h 3% · 7d 89% · Fable 21%");
    expect((poll.toJson().windowsPct as Dict)["2"]).toEqual({ "5h": 3.0, "7d": 89.0, Fable: 21.0 });
  });
});

describe("TestRunLoop", () => {
  it("test_loop_ticks_until_stopped", async () => {
    const harness = makeHarness();
    const ticks: number[] = [];
    vi.spyOn(harness.engine, "tick").mockImplementation(async () => {
      ticks.push(1);
      if (ticks.length >= 2) harness.engine.stop();
      return TickOutcome.NO_ACTION;
    });
    vi.spyOn(harness.engine.wakeEvent, "wait").mockResolvedValue(false);
    expect(await harness.engine.runLoop()).toBe(0);
    expect(ticks).toHaveLength(2);
  });

  it("test_loop_survives_raising_tick", async () => {
    const harness = makeHarness();
    const calls: number[] = [];
    vi.spyOn(harness.engine, "tickInner").mockImplementation(async () => {
      calls.push(1);
      if (calls.length === 1) throw new Error("boom");
      harness.engine.stop();
      return TickOutcome.NO_ACTION;
    });
    vi.spyOn(harness.engine.wakeEvent, "wait").mockResolvedValue(false);
    await harness.engine.runLoop();
    expect(calls).toHaveLength(2);
    expect(harness.events.some((e) => e instanceof ErrorEvent)).toBe(true);
  });

  it("test_stop_before_start_is_not_lost", async () => {
    const harness = makeHarness();
    harness.engine.stop();
    const tick = vi.spyOn(harness.engine, "tick");
    expect(await harness.engine.runLoop()).toBe(0);
    expect(tick).not.toHaveBeenCalled();
  });

  it("test_wake_during_tick_cuts_the_following_sleep_short", async () => {
    // The wait is real on purpose. If the loop clears the wake after the wait, the
    // wake of tick 1 is lost and the loop blocks on the 60 s sleep: the timeout catches it.
    const harness = makeHarness();
    const ticks: number[] = [];
    vi.spyOn(harness.engine, "tick").mockImplementation(async () => {
      ticks.push(1);
      if (ticks.length === 1) harness.engine.wake();
      else harness.engine.stop();
      return TickOutcome.NO_ACTION;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), 10_000);
    });
    const loop = harness.engine.runLoop();
    const finished = (await Promise.race([loop, timedOut])) !== "timeout";
    clearTimeout(timer);
    harness.engine.stop();
    await loop;
    expect(finished).toBe(true);
    expect(ticks).toHaveLength(2);
  }, 20_000);

  it("test_blocked_with_reset_rechecks_at_exhausted_cadence", async () => {
    const harness = makeHarness();
    harness.engine.sleepUntilTs = harness.clock() + 1800;
    const delay = await harness.engine.nextDelay(TickOutcome.BLOCKED);
    expect(delay).toBe(pollPolicy.EXHAUSTED_INTERVAL_S);
  });

  it("test_blocked_exhausted_without_reset_uses_fallback", async () => {
    const harness = makeHarness();
    harness.engine.sleepUntilTs = null;
    harness.engine.blockedWaitLong = true;
    expect(await harness.engine.nextDelay(TickOutcome.BLOCKED)).toBe(300.0);
  });

  it("test_blocked_on_resolvable_condition_keeps_normal_cadence", async () => {
    const harness = makeHarness();
    harness.engine.sleepUntilTs = null;
    harness.engine.blockedWaitLong = false;
    const delay = await harness.engine.nextDelay(TickOutcome.BLOCKED);
    expect(delay).toBeGreaterThanOrEqual(0.9 * 60);
    expect(delay).toBeLessThanOrEqual(1.1 * 60);
  });

  it("test_normal_delay_is_jittered_interval", async () => {
    const harness = makeHarness();
    const delay = await harness.engine.nextDelay(TickOutcome.NO_ACTION);
    expect(delay).toBeGreaterThanOrEqual(0.9 * 60);
    expect(delay).toBeLessThanOrEqual(1.1 * 60);
  });

  it("test_sleep_cap", async () => {
    const harness = makeHarness();
    harness.engine.sleepUntilTs = harness.clock() + 50 * 3600;
    expect(await harness.engine.nextDelay(TickOutcome.BLOCKED)).toBe(pollPolicy.EXHAUSTED_INTERVAL_S);
  });
});

describe("TestLoopObeysThePollPlan", () => {
  function plan(harness: EngineHarness, dueIn: number): void {
    const sw = harness.switcher;
    const num = sw.currentAccountNumber()!;
    const real = sw.usageEntriesByAccount.bind(sw);
    vi.spyOn(sw, "usageEntriesByAccount").mockImplementation(async (fetch = new Set(), opts = {}) => {
      const entries = { ...(await real(fetch, opts)) };
      entries[num] = new UsageEntry({ ...entries[num], nextPollAt: harness.clock() + dueIn });
      return entries;
    });
  }

  it("test_sleep_is_cut_to_the_rows_next_poll", async () => {
    const harness = makeHarness();
    harness.engine.settings = Object.freeze({ ...harness.engine.settings, intervalSeconds: 360.0 });
    plan(harness, 60.0);
    expect(await harness.engine.nextDelay(TickOutcome.NO_ACTION)).toBe(60.0);
  });

  it("test_never_sleeps_below_the_planners_own_floor", async () => {
    // A row that is already overdue must not spin: the floor is the rate budget.
    const harness = makeHarness();
    harness.engine.settings = Object.freeze({ ...harness.engine.settings, intervalSeconds: 360.0 });
    plan(harness, -500.0);
    expect(await harness.engine.nextDelay(TickOutcome.NO_ACTION)).toBe(pollPolicy.URGENT_INTERVAL_S);
  });

  it("test_a_relaxed_plan_never_lengthens_the_sleep", async () => {
    const harness = makeHarness();
    harness.engine.settings = Object.freeze({ ...harness.engine.settings, intervalSeconds: 60.0 });
    plan(harness, 3600.0);
    expect(await harness.engine.nextDelay(TickOutcome.NO_ACTION)).toBeLessThanOrEqual(1.1 * 60);
  });

  it("test_a_store_failure_leaves_the_cadence_alone", async () => {
    const harness = makeHarness();
    vi.spyOn(harness.switcher, "usageEntriesByAccount").mockRejectedValue(new Error("store unreadable"));
    const delay = await harness.engine.nextDelay(TickOutcome.NO_ACTION);
    expect(delay).toBeGreaterThanOrEqual(0.9 * 60);
    expect(delay).toBeLessThanOrEqual(1.1 * 60);
  });
});

describe("TestSessionThreshold", () => {
  it("test_apply_threshold_retargets_trigger_and_poll_pin", async () => {
    const harness = makeHarness();
    harness.engine.applyThreshold(72.0);
    expect(harness.engine.settings.threshold).toBe(72.0);
    expect(harness.switcher.pollInputsOverride).toEqual([72.0, []]);
    const outcome = await harness.tickWithUsage({ "1": usage(80), "2": usage(10), "3": usage(10) });
    expect(outcome).toBe(TickOutcome.SWITCHED);
  });

  it("test_clear_poll_policy_inputs_unpins", () => {
    const harness = makeHarness();
    harness.engine.applyThreshold(72.0);
    harness.switcher.clearPollPolicyInputs();
    expect(harness.switcher.pollInputsOverride).toBeNull();
  });

  async function collectFetchSets(harness: EngineHarness, threshold: number): Promise<string[][]> {
    const entries: Record<string, UsageEntry> = {};
    for (const n of ["1", "2", "3"]) entries[n] = entryFor(usage(n === "1" ? 80.0 : 10.0), harness.clock.now);
    const collect = vi.spyOn(harness.switcher, "usageEntriesByAccount").mockResolvedValue(entries);
    await harness.engine.collectScheduledUsage("1", new Set(), threshold);
    const sets = collect.mock.calls.map((c) => [...(c[0] ?? [])].sort());
    collect.mockRestore();
    return sets;
  }

  it("test_collect_escalates_on_the_tick_snapshot_threshold", async () => {
    // Escalation keys on the threshold of the tick, not on a new read of the settings (90 here).
    const harness = makeHarness();
    expect(await collectFetchSets(harness, 90.0)).toContainEqual(["1", "2", "3"]);
    expect(await collectFetchSets(harness, 99.9)).not.toContainEqual(["1", "2", "3"]);
  });
});

describe("TestPctLabel", () => {
  it("test_whole_numbers_drop_the_decimal", () => {
    expect(pctLabel(90.0)).toBe("90");
  });

  it("test_fractional_threshold_keeps_one_decimal", () => {
    expect(pctLabel(99.9)).toBe("99.9");
  });

  it("test_configured_precision_is_preserved", () => {
    expect(pctLabel(85.55)).toBe("85.55");
    expect(pctLabel(85.555555)).toBe("85.555555");
  });

  it("test_float_noise_is_absorbed", () => {
    expect(pctLabel(100.0 - 37.4)).toBe("62.6");
    expect(pctLabel(99.85000000000001)).toBe("99.85");
  });

  it("test_poll_event_shows_fractional_threshold", () => {
    const poll = new PollEvent({
      active: { number: 1, email: "a@example.com" },
      headroom: { "1": 40.0 },
      threshold: 99.9,
    });
    expect(poll.human()).toContain("switch at 99.9%");
  });

  it("test_below_threshold_detail_shows_fractional_threshold", async () => {
    const h = new EngineHarness(null, { threshold: 99.9 });
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com");
    h.makeLive("a@example.com", 1);
    await h.tickWithUsage({ "1": usage(50), "2": usage(10) });
    const details = h.events.filter((e) => e instanceof NoSwitchEvent).map((e) => (e as NoSwitchEvent).detail);
    expect(details).toEqual(["50% < 99.9%"]);
  });

  it("test_below_threshold_detail_never_shows_impossible_comparison", async () => {
    const h = new EngineHarness(null, { threshold: 99.9 });
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com");
    h.makeLive("a@example.com", 1);
    await h.tickWithUsage({ "1": usage(99.85), "2": usage(10) });
    const details = h.events.filter((e) => e instanceof NoSwitchEvent).map((e) => (e as NoSwitchEvent).detail);
    expect(details).toEqual(["99.85% < 99.9%"]);
  });
});

describe("TestTokenIdentity", () => {
  const FRESH = JSON.stringify({
    claudeAiOauth: { accessToken: "sk-2f", refreshToken: "rt-2f", expiresAt: 99_999_999_999_000 },
  });

  function expireSlot2(h: EngineHarness, access = "sk-2", refresh = "rt-2"): void {
    h.switcher.writeAccountCredentials(
      "2",
      "b@example.com",
      JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: 0 } }),
    );
  }

  function setSlot2(h: EngineHarness, fields: Dict): void {
    const data = h.switcher.getSequenceData()!;
    Object.assign(data.accounts!["2"] as Dict, fields);
    h.switcher.writeJson(h.switcher.sequenceFile, data);
  }

  function slot2Uuid(h: EngineHarness): unknown {
    return (h.switcher.getSequenceData()!.accounts!["2"] as Dict).uuid;
  }

  function withTokenAccount(tokenAccount: unknown): oauth.RefreshOutcome {
    return oauth.refreshOutcome(FRESH, null, { tokenAccount: tokenAccount as oauth.RefreshOutcome["tokenAccount"] });
  }

  it("test_uuid_backfill_from_token_account_on_freshen", async () => {
    const harness = makeHarness();
    setSlot2(harness, { uuid: "" });
    expireSlot2(harness);
    refreshSpy().mockResolvedValue(
      withTokenAccount({ uuid: "uuid-2-real", email: "b@example.com", organizationUuid: "" }),
    );
    const status = await harness.engine.freshenTarget("2", "b@example.com");
    expect(status).toBe("ok");
    expect(slot2Uuid(harness)).toBe("uuid-2-real");
  });

  it("test_conflicting_token_identity_returns_identity_conflict", async () => {
    // The slot is not a viable target, but the rotated generation stays persisted.
    const harness = makeHarness();
    expireSlot2(harness);
    refreshSpy().mockResolvedValue(
      withTokenAccount({ uuid: "uuid-somebody-else", email: "z@example.com", organizationUuid: "" }),
    );
    const status = await harness.engine.freshenTarget("2", "b@example.com");
    expect(status).toBe("identity-conflict");
    expect(harness.switcher.readAccountCredentials("2", "b@example.com")).toBe(FRESH);
  });

  it("test_identity_conflict_quarantines_instead_of_activating", async () => {
    const harness = makeHarness();
    expireSlot2(harness);
    refreshSpy().mockImplementation(async (creds: string) => {
      const data = (JSON.parse(creds) as { claudeAiOauth: Dict }).claudeAiOauth;
      if (data.refreshToken === "rt-2") {
        return withTokenAccount({ uuid: "uuid-somebody-else", email: "z@example.com", organizationUuid: "" });
      }
      return oauth.refreshOutcome(creds, null);
    });
    const outcome = await harness.tickWithUsage({ "1": usage(95), "2": usage(10), "3": usage(80) });
    expect(harness.kinds()).toContain("account-quarantined");
    expect(quarantineOf(harness)["2"]?.reason).toBe("identity-conflict");
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber()).toBe(3);
  });

  it("test_dead_slot_quarantined_even_with_safety_copy_present", async () => {
    // A dead slot goes to quarantine. A safety copy is never promoted automatically.
    const harness = makeHarness();
    harness.switcher.store.writeUnclaimedCredential(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-2-successor",
          refreshToken: "rt-2-successor",
          expiresAt: 99_999_999_999_000,
        },
      }),
      { resolvedIdentity: { uuid: "uuid-2", email: "b@example.com", organizationUuid: "" } },
    );
    expireSlot2(harness, "sk-2-dead", "rt-2-dead");
    refreshSpy().mockImplementation(async (creds: string) => {
      const data = (JSON.parse(creds) as { claudeAiOauth: Dict }).claudeAiOauth;
      if (data.refreshToken === "rt-2-dead") return oauth.refreshOutcome(null, "invalid_grant");
      return oauth.refreshOutcome(creds, null);
    });
    const outcome = await harness.tickWithUsage({ "1": usage(95), "2": usage(10), "3": usage(80) });
    expect(quarantineOf(harness)["2"]?.reason).toBe("invalid_grant");
    expect(Object.keys(harness.switcher.listUnclaimedCredentials())).toHaveLength(1);
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(harness.activeNumber()).toBe(3);
  });

  it("test_same_uuid_different_org_is_identity_conflict", async () => {
    // The same account uuid under a different organization is a conflict.
    const harness = makeHarness();
    setSlot2(harness, { organizationUuid: "org-2" });
    expireSlot2(harness);
    refreshSpy().mockResolvedValue(
      withTokenAccount({ uuid: "uuid-2", email: "b@example.com", organizationUuid: "org-other" }),
    );
    const status = await harness.engine.freshenTarget("2", "b@example.com");
    expect(status).toBe("identity-conflict");
  });

  it("test_malformed_token_identity_never_breaks_freshen", async () => {
    // A non-string uuid must be ignored: the refreshed credential is already persisted at this point.
    const harness = makeHarness();
    expireSlot2(harness);
    refreshSpy().mockResolvedValue(withTokenAccount({ uuid: 12345, email: ["weird"] }));
    const status = await harness.engine.freshenTarget("2", "b@example.com");
    expect(status).toBe("ok");
    expect(harness.switcher.readAccountCredentials("2", "b@example.com")).toBe(FRESH);
  });

  it("test_blank_uuid_slot_with_org_conflict_quarantines_not_backfills", async () => {
    // The org check comes before the blank-uuid backfill, so a foreign uuid never sticks to the slot.
    const harness = makeHarness();
    setSlot2(harness, { uuid: "", organizationUuid: "org-A" });
    expireSlot2(harness);
    refreshSpy().mockResolvedValue(
      withTokenAccount({ uuid: "uuid-real", email: "z@example.com", organizationUuid: "org-B" }),
    );
    const status = await harness.engine.freshenTarget("2", "b@example.com");
    expect(status).toBe("identity-conflict");
    expect(slot2Uuid(harness)).toBe("");
    expect(harness.switcher.readAccountCredentials("2", "b@example.com")).toBe(FRESH);
  });
});

describe("TestModelAwareSwitch", () => {
  function seed(kw: Partial<AutoSwitchSettings> = {}): EngineHarness {
    const h = new EngineHarness(null, kw);
    h.seed(1, "a@example.com");
    h.seed(2, "b@example.com");
    h.seed(3, "c@example.com");
    h.makeLive("a@example.com", 1);
    return h;
  }

  it("test_model_maxed_switches_despite_session_headroom", async () => {
    const h = seed({ model: "Fable" });
    const outcome = await h.tickWithUsage({
      "1": modelUsage(5, 100),
      "2": modelUsage(5, 30),
      "3": modelUsage(5, 60),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
    expect(find(h.events, SwitchEvent).toRef).toEqual({ number: 2, email: "b@example.com" });
  });

  it("test_without_model_setting_the_same_usage_holds", async () => {
    const h = seed();
    const outcome = await h.tickWithUsage({
      "1": modelUsage(5, 100),
      "2": modelUsage(5, 30),
      "3": modelUsage(5, 60),
    });
    expect(outcome).toBe(TickOutcome.NO_ACTION);
    expect(h.activeNumber()).toBe(1);
    expect(h.reasons()).toEqual(["below-threshold"]);
  });

  it("test_model_headroom_still_gated_by_session_window", async () => {
    const h = seed({ model: "Fable" });
    const outcome = await h.tickWithUsage({
      "1": modelUsage(100, 40),
      "2": modelUsage(10, 40),
      "3": modelUsage(20, 40),
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
  });

  it("test_comma_separated_models_switch_on_any", async () => {
    const h = seed({ model: "Fable,Opus" });
    const u = (fiveH: number, fable: number, opus: number) => ({
      five_hour: { pct: fiveH },
      seven_day: { pct: 0.0 },
      scoped: [
        { name: "Fable", pct: fable },
        { name: "Opus", pct: opus },
      ],
    });
    const outcome = await h.tickWithUsage({ "1": u(5, 20, 100), "2": u(5, 20, 30), "3": u(5, 20, 70) });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
  });

  it("test_all_sentinel_binds_every_scoped_window", async () => {
    const h = seed({ model: "all" });
    const outcome = await h.tickWithUsage({
      "1": { five_hour: { pct: 5.0 }, seven_day: { pct: 0.0 }, scoped: [{ name: "Sonnet", pct: 100.0 }] },
      "2": { five_hour: { pct: 5.0 }, seven_day: { pct: 0.0 }, scoped: [{ name: "Sonnet", pct: 20.0 }] },
      "3": { five_hour: { pct: 5.0 }, seven_day: { pct: 0.0 }, scoped: [{ name: "Opus", pct: 60.0 }] },
    });
    expect(outcome).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(2);
  });

  it("test_dual_exhausted_candidate_recovers_at_its_later_reset", async () => {
    // #2 recovers only at the LATER of its 5h and Fable resets. #3 recovers later still.
    const h = seed({ model: "Fable" });
    const fableReset = "2026-07-05T15:00:00Z";
    const outcome = await h.tickWithUsage({
      "1": modelUsage(95, 10),
      "2": {
        five_hour: { pct: 100.0, resets_at: "2026-07-05T12:00:00Z" },
        seven_day: { pct: 0.0 },
        scoped: [{ name: "Fable", pct: 100.0, resets_at: fableReset }],
      },
      "3": {
        five_hour: { pct: 100.0, resets_at: "2026-07-05T20:00:00Z" },
        seven_day: { pct: 0.0 },
      },
    });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    expect(find(h.events, AllExhaustedEvent).earliestResetAt).toBe(fableReset);
  });

  it("test_unknown_recovery_falls_back_instead_of_oversleeping", async () => {
    // #2 has no reset time and can recover at any moment, so the wake time is unknown.
    const h = seed({ model: "Fable" });
    const outcome = await h.tickWithUsage({
      "1": modelUsage(95, 10),
      "2": {
        five_hour: { pct: 0.0 },
        seven_day: { pct: 0.0 },
        scoped: [{ name: "Fable", pct: 100.0 }],
      },
      "3": {
        five_hour: { pct: 100.0, resets_at: "2026-07-05T20:00:00Z" },
        seven_day: { pct: 0.0 },
      },
    });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    expect(find(h.events, AllExhaustedEvent).earliestResetAt).toBeNull();
    expect(h.engine.sleepUntilTs).toBeNull();
    expect(await h.engine.nextDelay(outcome)).toBe(NO_RESET_FALLBACK_S);
  });

  it("test_scoped_only_exhaustion_drives_the_wake_time", async () => {
    const h = seed({ model: "Fable" });
    const fableReset = "2026-07-06T09:00:00Z";
    const blocked = {
      five_hour: { pct: 3.0, resets_at: "2026-07-05T12:00:00Z" },
      seven_day: { pct: 0.0 },
      scoped: [{ name: "Fable", pct: 100.0, resets_at: fableReset }],
    };
    const outcome = await h.tickWithUsage({ "1": modelUsage(95, 10), "2": blocked, "3": blocked });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    expect(find(h.events, AllExhaustedEvent).earliestResetAt).toBe(fableReset);
  });

  it("test_scoped_binding_window_keeps_active_cadence_tight", () => {
    const kwargs = {
      prevIntervalS: pollPolicy.MIN_INTERVAL_S,
      prevUsage: modelUsage(5, 84),
      newUsage: modelUsage(5, 88),
      isActive: true,
      threshold: 90.0,
      recent429: false,
      now: 1000.0,
      rng: () => 0.5,
    } as Omit<pollPolicy.PlanAfterFetchOptions, "models">;
    const [, scoped] = pollPolicy.planAfterFetch({ ...kwargs, models: ["Fable"] });
    expect(scoped).toBe(pollPolicy.URGENT_INTERVAL_S);
    const [, unscoped] = pollPolicy.planAfterFetch({ ...kwargs, models: [] });
    expect(unscoped).toBeGreaterThan(pollPolicy.MIN_INTERVAL_S);
  });

  it("test_unmatched_model_name_warns_once", async () => {
    const h = seed({ model: "Fabel" });
    const values = { "1": modelUsage(5, 10), "2": modelUsage(5, 10), "3": modelUsage(5, 10) };
    await h.tickWithUsage(values);
    let warnings = h.events.filter((e) => e instanceof ConfigWarningEvent) as ConfigWarningEvent[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("Fabel");
    expect(warnings[0]!.toJson().event).toBe("config-warning");
    await h.tickWithUsage(values);
    warnings = h.events.filter((e) => e instanceof ConfigWarningEvent) as ConfigWarningEvent[];
    expect(warnings).toHaveLength(1);
  });

  it("test_no_false_warning_while_an_account_is_unreadable", async () => {
    const h = seed({ model: "Fabel" });
    await h.tickWithUsage({ "1": modelUsage(5, 10), "2": modelUsage(5, 10), "3": null });
    expect(h.events.some((e) => e instanceof ConfigWarningEvent)).toBe(false);
    await h.tickWithUsage({ "1": modelUsage(5, 10), "2": modelUsage(5, 10), "3": modelUsage(5, 10) });
    expect(h.events.some((e) => e instanceof ConfigWarningEvent)).toBe(true);
  });

  it("test_matching_name_never_warns", async () => {
    const h = seed({ model: "Fable" });
    await h.tickWithUsage({ "1": modelUsage(5, 10), "2": modelUsage(5, 10), "3": modelUsage(5, 10) });
    expect(h.events.some((e) => e instanceof ConfigWarningEvent)).toBe(false);
  });
});
