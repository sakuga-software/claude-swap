import { describe, expect, it, vi } from "vitest";
import {
  AllExhaustedEvent,
  NoSwitchEvent,
  PollEvent,
  SwitchEvent,
  TickOutcome,
  pctLabel,
} from "../src/autoswitch.js";
import { USAGE_TOKEN_EXPIRED } from "../src/json_output.js";
import { Platform, accountSnapshot } from "../src/models.js";
import { EXHAUSTED_INTERVAL_S } from "../src/poll_policy.js";
import type { AutoSwitchSettings } from "../src/settings.js";
import { SnapshotSource } from "../src/snapshot_source.js";
import { UsageEntry } from "../src/usage_store.js";
import { EngineHarness, makeHarness, usage } from "./helpers/autoswitch_harness.js";

function harness(settings: Partial<AutoSwitchSettings> = {}): EngineHarness {
  return makeHarness(settings);
}

describe("AutoSwitchEngineSmoke", () => {
  it("below_threshold_is_no_action", async () => {
    const h = harness();
    expect(await h.tickWithUsage({ "1": usage(50), "2": usage(10), "3": usage(10) })).toBe(TickOutcome.NO_ACTION);
    expect(h.activeNumber()).toBe(1);
    expect(h.reasons()).toEqual(["below-threshold"]);
    expect(h.events.map((e) => e.kind)).toEqual(["poll", "no-switch"]);
  });

  it("poll_then_switch_to_max_headroom", async () => {
    const h = harness();
    expect(await h.tickWithUsage({ "1": usage(95), "2": usage(40), "3": usage(20) })).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(3);
    const sw = h.events.find((e) => e instanceof SwitchEvent) as SwitchEvent;
    expect(sw.trigger).toBe("proactive");
    expect(sw.toRef).toEqual({ number: 3, email: "c@example.com" });
    expect(sw.toJson()).toMatchObject({
      schemaVersion: 1,
      event: "switch",
      from: { number: 1, email: "a@example.com" },
      to: { number: 3, email: "c@example.com" },
      dryRun: false,
    });
    for (const event of h.events) {
      const payload = event.toJson();
      expect(payload.event).toBe(event.kind);
      expect(String(payload.ts)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    }
    const state = h.state();
    expect(state.lastSwitchTo).toBe("3");
    expect(state.lastSwitchFrom).toBe(1);
    expect(state.leftTrigger).toBe("proactive");
    expect(state.leftHeadroom).toBe(5);

    // The cooldown stops the next proactive move.
    h.clock.advance(60);
    expect(await h.tickWithUsage({ "3": usage(95), "1": usage(10), "2": usage(10) })).toBe(TickOutcome.NO_ACTION);
    expect(h.reasons()).toEqual(["cooldown"]);
  });

  it("hysteresis_blocks_marginal_candidates", async () => {
    const h = harness();
    const outcome = await h.tickWithUsage({ "1": usage(95), "2": usage(86), "3": usage(88) });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    expect(h.reasons()).toEqual(["no-qualifying-candidate"]);
    expect(h.engine.sleepUntilTs).toBeNull();
    expect(await h.engine.nextDelay(outcome)).toBeLessThanOrEqual(1.1 * h.settings.intervalSeconds);
  });

  it("all_exhausted_sleeps_toward_the_reset", async () => {
    const h = harness();
    const reset = new Date((h.clock.now + 1800) * 1000).toISOString().replace(".000Z", "Z");
    const outcome = await h.tickWithUsage({
      "1": usage(100, reset),
      "2": usage(100, reset),
      "3": usage(100, reset),
    });
    expect(outcome).toBe(TickOutcome.BLOCKED);
    const exhausted = h.events.find((e) => e instanceof AllExhaustedEvent) as AllExhaustedEvent;
    expect(exhausted.earliestResetAt).toBe(reset);
    expect(h.engine.blockedWaitLong).toBe(true);
    expect(h.engine.sleepUntilTs).toBe(h.clock.now + 1800 + 60);
    expect(await h.engine.nextDelay(outcome)).toBe(EXHAUSTED_INTERVAL_S);
  });

  it("unknown_active_usage_counts_then_fails_over", async () => {
    const h = harness({ unhealthyTicks: 2 });
    const values = { "1": null, "2": usage(10), "3": usage(30) };
    expect(await h.tickWithUsage(values)).toBe(TickOutcome.NO_ACTION);
    expect(h.reasons()).toEqual(["active-usage-unknown"]);
    expect(await h.tickWithUsage(values)).toBe(TickOutcome.SWITCHED);
    expect((h.events.at(-1) as SwitchEvent).trigger).toBe("failover");
    expect(h.activeNumber()).toBe(2);
  });

  it("expired_active_token_holds_idle", async () => {
    const h = harness();
    expect(await h.tickWithUsage({ "1": USAGE_TOKEN_EXPIRED, "2": usage(10) })).toBe(TickOutcome.NO_ACTION);
    expect(h.reasons()).toEqual(["active-idle"]);
    expect(await h.engine.nextDelay(TickOutcome.NO_ACTION)).toBe(300);
  });

  it("dry_run_writes_nothing", async () => {
    const h = harness();
    h.engine.dryRun = true;
    expect(await h.tickWithUsage({ "1": usage(95), "2": usage(10), "3": usage(50) })).toBe(TickOutcome.SWITCHED);
    expect(h.activeNumber()).toBe(1);
    expect((h.events.at(-1) as SwitchEvent).human()).toBe("[dry-run] would switch Account-1 -> Account-2 (b@example.com) (proactive)");
    expect(h.state()).toEqual({});
  });

  it("no_active_account", async () => {
    const h = new EngineHarness();
    expect(await h.engine.tick()).toBe(TickOutcome.NO_ACTION);
    expect(h.reasons()).toEqual(["no-active-account"]);
  });

  it("poll_event_human_line", async () => {
    const h = harness();
    await h.tickWithUsage({ "1": usage(42), "2": usage(10), "3": null });
    const poll = h.events.find((e) => e instanceof PollEvent) as PollEvent;
    expect(poll.human()).toBe("Account-1 (a@example.com): 42% used (switch at 90%) | others: #2: 5h 10% · 7d 0%, #3: ?");
    expect(pctLabel(99.9)).toBe("99.9");
    expect(pctLabel(85.555555)).toBe("85.555555");
  });

  it("tick_outcome_values_are_the_once_exit_codes", () => {
    expect(TickOutcome).toEqual({ SWITCHED: 0, ERROR: 1, NO_ACTION: 2, BLOCKED: 3 });
  });
});

describe("AutoSwitchRunLoopSmoke", () => {
  it("loop_ticks_until_stopped", async () => {
    const h = harness();
    let ticks = 0;
    vi.spyOn(h.engine, "tick").mockImplementation(async () => {
      ticks += 1;
      if (ticks >= 2) h.engine.stop();
      return TickOutcome.NO_ACTION;
    });
    vi.spyOn(h.engine.wakeEvent, "wait").mockResolvedValue(false);
    expect(await h.engine.runLoop()).toBe(0);
    expect(ticks).toBe(2);
  });

  it("stop_before_start_is_not_lost", async () => {
    const h = harness();
    h.engine.stop();
    const tick = vi.spyOn(h.engine, "tick");
    expect(await h.engine.runLoop()).toBe(0);
    expect(tick).not.toHaveBeenCalled();
  });

  it("abort_signal_stops_the_sleep", async () => {
    const h = harness();
    let ticks = 0;
    vi.spyOn(h.engine, "tick").mockImplementation(async () => {
      ticks += 1;
      return TickOutcome.NO_ACTION;
    });
    const controller = new AbortController();
    const loop = h.engine.runLoop({ signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    expect(await loop).toBe(0);
    expect(ticks).toBe(1);
  });

  it("wake_during_tick_cuts_the_following_sleep_short", async () => {
    const h = harness();
    let ticks = 0;
    vi.spyOn(h.engine, "tick").mockImplementation(async () => {
      ticks += 1;
      if (ticks === 1) h.engine.wake();
      else h.engine.stop();
      return TickOutcome.NO_ACTION;
    });
    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 5000));
    const result = await Promise.race([h.engine.runLoop(), timeout]);
    h.engine.stop();
    expect(result).toBe(0);
    expect(ticks).toBe(2);
  });

  it("failing_tick_does_not_kill_the_loop", async () => {
    const h = harness();
    let calls = 0;
    vi.spyOn(h.engine, "tickInner").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      h.engine.stop();
      return TickOutcome.NO_ACTION;
    });
    vi.spyOn(h.engine.wakeEvent, "wait").mockResolvedValue(false);
    await h.engine.runLoop();
    expect(calls).toBe(2);
    expect(h.events.map((e) => e.kind)).toContain("error");
  });
});

describe("SnapshotSourceSmoke", () => {
  it("keeps_the_newer_reading_when_a_pass_regresses", async () => {
    const make = (fetchedAt: number | null) =>
      Object.freeze({
        activeNumber: "1",
        takenAt: 2000,
        accounts: [
          accountSnapshot({
            number: "1",
            email: "a@example.com",
            orgName: "",
            orgUuid: "",
            isActive: true,
            kind: "oauth",
            switchable: true,
            usage: new UsageEntry({ lastGood: { five_hour: { pct: 1 } }, fetchedAt, ageS: 0 }),
          }),
        ],
      });
    const snaps = [make(1500), make(1000)];
    const source = new SnapshotSource({ accountsSnapshot: async () => snaps.shift()! });
    await source.take();
    const second = await source.take({ storeOnly: true });
    expect(second.accounts[0]!.usage.fetchedAt).toBe(1500);
    expect(second.accounts[0]!.usage.ageS).toBe(500);
  });
});
