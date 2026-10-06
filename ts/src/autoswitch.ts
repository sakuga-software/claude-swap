/**
 * Auto-switch engine: poll usage, and switch accounts before they hit a rate limit.
 *
 * `AutoSwitchEngine` has no UI: no print, no argument parse, no TUI import.
 * It uses a `ClaudeAccountSwitcher`, applies a threshold policy on each
 * `tick()`, and reports all results as typed events to an `onEvent` callback.
 * The CLI renders the events as text lines or JSONL. The TUI and the menu bar
 * read the same stream.
 *
 * The policy:
 * - When the binding window of the active account (the higher of its 5h/7d
 *   percentages) gets to `settings.threshold`, switch to the candidate with
 *   the most headroom. The old account is still valid while a running Claude
 *   Code reads the new one, so the macOS Keychain cache latency (about 30 s) does no harm.
 * - A candidate must be `hysteresisPct` better, so two accounts near the line do not flap.
 *   `cooldownSeconds` limits the switch rate, except when the active account is at its limit.
 * - Before the switch, the engine refreshes the token of the target if it expires
 *   in less than 10 minutes. A target with a dead refresh token goes to quarantine.
 * - When the usage of the active account stays unreadable for `unhealthyTicks`
 *   ticks, the engine fails over to a healthy candidate.
 *
 * The cooldown and the quarantine persist in `<backup_root>/autoswitch_state.json`,
 * so the `cswap auto --once` ticks of a cron job agree. A file lock protects
 * each read-modify-write of that file.
 */
import fs from "node:fs";
import path from "node:path";
import { ClaudeSwitchError } from "./exceptions.js";
import { SCHEMA_VERSION, USAGE_TOKEN_EXPIRED } from "./json_output.js";
import { FileLock } from "./locking.js";
import { getLogger } from "./logging_config.js";
import * as oauth from "./oauth.js";
import * as pollPolicy from "./poll_policy.js";
import { ESCALATION_MARGIN_PCT, RESET_SLACK_S, bindingPct } from "./poll_policy.js";
import { type AutoSwitchSettings, atomicWriteJson, parseModelNames } from "./settings.js";
import { isoformat } from "./support/py.js";
import { pyFixed } from "./support/pyformat.js";
import type { ClaudeAccountSwitcher } from "./switcher.js";
import { type UsageEntry, dueCandidate, planOversleepsInterval } from "./usage_store.js";

export { RESET_SLACK_S };

export const STATE_FILENAME = "autoswitch_state.json";
export const STATE_SCHEMA_VERSION = 1;

const logger = getLogger("claude-swap");

/**
 * Systemic freshen refusals, with the most actionable first.
 *
 * All candidates get the same refusal, so a tick reports only one. The order
 * decides which one: a cause that needs a person must not hide behind a cause
 * that clears itself (`consume-busy`).
 */
export const SYSTEMIC_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  "store-unmirrored": "CLAUDE_SECURESTORAGE_CONFIG_DIR is set — unset it or run cswap from a normal shell",
  invalid_client: "cswap's OAuth client was rejected — systemic, not this account",
  "stash-unreadable":
    "a stashed successor is unreadable — unlock the keychain or fix the file, then retry; " +
    "`cswap unclaimed` inspects it",
  "consume-busy": "another cswap surface holds the slot — retries next pass",
});
export const SYSTEMIC_STATUSES: readonly string[] = Object.freeze(Object.keys(SYSTEMIC_MESSAGES));

/**
 * Refresh a target whose access token expires in this window. It is two times the
 * 5-minute refresh buffer of Claude Code, so its "abort the refresh if not expired"
 * re-read stays true after the switch.
 */
export const FRESHEN_BUFFER_MS = 10 * 60 * 1000;

/**
 * Maximum sleep before a known quota reset. A provider can give quota back before the
 * reported reset, so a long sleep must not skip the fetch that finds it.
 */
export const MAX_SLEEP_S = pollPolicy.EXHAUSTED_INTERVAL_S;
export const NO_RESET_FALLBACK_S = 300.0;

/**
 * Maximum elapsed time of an idle hold. An expired token that Claude Code owns
 * usually means an idle Claude Code. A dead refresh token with an active user
 * looks the same, so after this time the engine counts unhealthy ticks again.
 */
export const IDLE_HOLD_MAX_S = 30 * 60.0;

/**
 * Anti-flap margin of the escape when all accounts are above the threshold: a target must
 * come back at least this much sooner than the active account. It is longer than one poll
 * cycle, so measurement jitter cannot make two accounts trade places.
 */
export const RECOVERY_HYSTERESIS_S = 300.0;

/**
 * Past this horizon, a sooner reset is not worth real headroom: the reset is outside the
 * session. 4 h keeps most of a 5-hour cycle on the recovery ranking.
 */
export const RECOVERY_HORIZON_S = 4 * 3600.0;

/** Anti-flap margin on the headroom axis, as a ratio. A ratio makes the move one-way. */
export const HORIZON_HEADROOM_RATIO = 2.0;

/**
 * Below this headroom an account is spent: a difference is less than two poll intervals of work.
 * When all candidates are spent, rank by reset instead of by headroom.
 */
export const SPENT_HEADROOM_PCT = 3.0;

/** Seams that the tests replace. */
export const internals = {
  FileLock,
  /** The jitter source of `nextDelay`. */
  random: (): number => Math.random(),
  /** The wall time of the event timestamps. */
  now: (): Date => new Date(),
};

/**
 * True if the ranking of THIS candidate uses the soonest reset instead of the headroom.
 *
 * Reset wins if the active account and the best candidate are both spent, or if this
 * candidate or the active account comes back inside `RECOVERY_HORIZON_S`.
 *
 * WARNING: The axis must be a property of the pair, not of the candidate alone.
 * A switch swaps which account is active, and "either side inside" stays true after
 * the swap. If only the candidate decides, the outbound move and the return move use
 * different gates, and the pair flaps.
 */
export function recoveryIsUseful(
  candidateRecoveryTs: number,
  activeRecoveryTs: number,
  activeHeadroom: number,
  bestCandidateHeadroom: number,
  now: number,
): boolean {
  if (activeHeadroom <= SPENT_HEADROOM_PCT && bestCandidateHeadroom <= SPENT_HEADROOM_PCT) {
    return true;
  }
  return candidateRecoveryTs - now <= RECOVERY_HORIZON_S || activeRecoveryTs - now <= RECOVERY_HORIZON_S;
}

/** The present wall time as an ISO string with a `Z` suffix, in whole seconds. */
export function nowIso(): string {
  return isoUtcSeconds(internals.now());
}

function isoUtcSeconds(date: Date): string {
  return isoformat(date, { timespec: "seconds" }).replace("+00:00", "Z");
}

/**
 * A percentage for display, as configured (Python `.10g`). 85.555555 stays itself and
 * 99.9 never shows as "100". Ten significant digits remove the float noise.
 * A displayed comparison must format the two sides with this function.
 */
export function pctLabel(value: number): string {
  return pyGeneral(value, 10);
}

/** Python `format(x, ".{precision}g")`. */
function pyGeneral(x: number, precision: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const [mantissa = "", expText = "0"] = x.toExponential(precision - 1).split("e");
  const exp = Number(expText);
  const strip = (text: string) => (text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text);
  if (exp < -4 || exp >= precision) {
    const sign = exp < 0 ? "-" : "+";
    return `${strip(mantissa)}e${sign}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return strip(x.toFixed(Math.max(0, precision - 1 - exp)));
}

/** Python `round(x, 1)`. */
function round1(x: number): number {
  return Number(pyFixed(x, 1));
}

export type UsageValue = oauth.UsageDict | string | null;
export type AccountRef = { number: number | null; email: string };
export type AutoSwitchState = Record<string, unknown>;

function isDict(value: unknown): value is oauth.UsageDict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Base event. `toJson()` payloads are additive: a consumer must ignore unknown `event` kinds and fields. */
export abstract class AutoSwitchEvent {
  static readonly KIND: string = "event";
  readonly ts: string;

  constructor(ts?: string) {
    this.ts = ts ?? nowIso();
  }

  get kind(): string {
    return (this.constructor as typeof AutoSwitchEvent).KIND;
  }

  fields(): Record<string, unknown> {
    return {};
  }

  toJson(): Record<string, unknown> {
    return { schemaVersion: SCHEMA_VERSION, event: this.kind, ts: this.ts, ...this.fields() };
  }

  human(): string {
    return this.kind;
  }
}

export interface PollEventInit {
  active: AccountRef | null;
  /** Account number → headroom pct, or null if unknown. */
  headroom: Record<string, number | null>;
  threshold: number;
  /** Account number → last fetch error cause ("http-429", "timeout", ...) when the usage is unknown. */
  fetchErrors?: Record<string, string>;
  /** Account number → window label → utilization pct ("5h", "7d", then the scoped model names). */
  windows?: Record<string, Record<string, number>>;
  ts?: string;
}

export class PollEvent extends AutoSwitchEvent {
  static override readonly KIND = "poll";
  readonly active: AccountRef | null;
  readonly headroom: Record<string, number | null>;
  readonly threshold: number;
  readonly fetchErrors: Record<string, string>;
  readonly windows: Record<string, Record<string, number>>;

  constructor(init: PollEventInit) {
    super(init.ts);
    this.active = init.active;
    this.headroom = init.headroom;
    this.threshold = init.threshold;
    this.fetchErrors = init.fetchErrors ?? {};
    this.windows = init.windows ?? {};
  }

  override fields(): Record<string, unknown> {
    const fields: Record<string, unknown> = {
      active: this.active,
      headroomPct: this.headroom,
      threshold: this.threshold,
    };
    if (Object.keys(this.fetchErrors).length > 0) fields.fetchErrors = this.fetchErrors;
    if (Object.keys(this.windows).length > 0) fields.windowsPct = this.windows;
    return fields;
  }

  describe(num: string): string {
    const wins = own(this.windows, num);
    if (wins && Object.keys(wins).length > 0) {
      return Object.entries(wins)
        .map(([name, pct]) => `${name} ${pyFixed(pct, 0)}%`)
        .join(" · ");
    }
    const h = own(this.headroom, num);
    if (h != null) return `${pyFixed(100 - h, 0)}%`;
    const err = own(this.fetchErrors, num);
    return err ? `? (${err})` : "?";
  }

  override human(): string {
    if (this.active === null) return "poll: no active account";
    const num = String(this.active.number);
    const h = own(this.headroom, num);
    let used: string;
    if (h != null) {
      used = `${pyFixed(100 - h, 0)}% used`;
    } else {
      const err = own(this.fetchErrors, num);
      used = err ? `usage unknown (${err})` : "usage unknown";
    }
    const others = Object.keys(this.headroom)
      .filter((n) => n !== num)
      .map((n) => `#${n}: ${this.describe(n)}`)
      .join(", ");
    const tail = others ? ` | others: ${others}` : "";
    return `Account-${num} (${this.active.email}): ${used} (switch at ${pctLabel(this.threshold)}%)${tail}`;
  }
}

export interface SwitchEventInit {
  /** "proactive" | "at-limit" | "failover" | "consume-first" */
  trigger: string;
  fromRef: AccountRef | null;
  toRef: AccountRef | null;
  warnings?: string[];
  dryRun?: boolean;
  ts?: string;
}

export class SwitchEvent extends AutoSwitchEvent {
  static override readonly KIND = "switch";
  readonly trigger: string;
  readonly fromRef: AccountRef | null;
  readonly toRef: AccountRef | null;
  readonly warnings: string[];
  readonly dryRun: boolean;

  constructor(init: SwitchEventInit) {
    super(init.ts);
    this.trigger = init.trigger;
    this.fromRef = init.fromRef;
    this.toRef = init.toRef;
    this.warnings = init.warnings ?? [];
    this.dryRun = init.dryRun ?? false;
  }

  override fields(): Record<string, unknown> {
    return { trigger: this.trigger, from: this.fromRef, to: this.toRef, warnings: this.warnings, dryRun: this.dryRun };
  }

  override human(): string {
    const src = this.fromRef ? `Account-${this.fromRef.number}` : "(none)";
    const dst = this.toRef ? `Account-${this.toRef.number} (${this.toRef.email})` : "?";
    const prefix = this.dryRun ? "[dry-run] would switch" : "Switched";
    return `${prefix} ${src} -> ${dst} (${this.trigger})`;
  }
}

export class NoSwitchEvent extends AutoSwitchEvent {
  static override readonly KIND = "no-switch";
  readonly reason: string;
  readonly detail: string;

  constructor(init: { reason: string; detail?: string; ts?: string }) {
    super(init.ts);
    this.reason = init.reason;
    this.detail = init.detail ?? "";
  }

  override fields(): Record<string, unknown> {
    return { reason: this.reason, detail: this.detail };
  }

  override human(): string {
    return `no switch: ${this.reason}` + (this.detail ? ` (${this.detail})` : "");
  }
}

export class QuarantineEvent extends AutoSwitchEvent {
  static override readonly KIND = "account-quarantined";
  readonly number: string;
  readonly email: string;
  readonly reason: string;

  constructor(init: { number: string; email: string; reason: string; ts?: string }) {
    super(init.ts);
    this.number = init.number;
    this.email = init.email;
    this.reason = init.reason;
  }

  override fields(): Record<string, unknown> {
    return { number: this.number, email: this.email, reason: this.reason };
  }

  override human(): string {
    return (
      `Account-${this.number} (${this.email}) quarantined: ${this.reason}. ` +
      `Log in with it and run 'cswap --add-account --slot ${this.number}' to recover.`
    );
  }
}

export class UnquarantineEvent extends AutoSwitchEvent {
  static override readonly KIND = "account-unquarantined";
  readonly number: string;
  readonly email: string;
  readonly reason: string;

  constructor(init: { number: string; email: string; reason?: string; ts?: string }) {
    super(init.ts);
    this.number = init.number;
    this.email = init.email;
    this.reason = init.reason ?? "credentials-replaced";
  }

  override fields(): Record<string, unknown> {
    return { number: this.number, email: this.email, reason: this.reason };
  }

  override human(): string {
    return `Account-${this.number} (${this.email}) back in rotation (${this.reason})`;
  }
}

export class AllExhaustedEvent extends AutoSwitchEvent {
  static override readonly KIND = "all-exhausted";
  readonly earliestResetAt: string | null;

  constructor(init: { earliestResetAt: string | null; ts?: string }) {
    super(init.ts);
    this.earliestResetAt = init.earliestResetAt;
  }

  override fields(): Record<string, unknown> {
    return { earliestResetAt: this.earliestResetAt };
  }

  override human(): string {
    if (this.earliestResetAt) return `all accounts exhausted; earliest reset ${this.earliestResetAt}`;
    return "all accounts exhausted; no reset time known";
  }
}

export class SleepEvent extends AutoSwitchEvent {
  static override readonly KIND = "sleep";
  readonly seconds: number;
  readonly until: string;

  constructor(init: { seconds: number; until: string; ts?: string }) {
    super(init.ts);
    this.seconds = init.seconds;
    this.until = init.until;
  }

  override fields(): Record<string, unknown> {
    return { seconds: round1(this.seconds), until: this.until };
  }

  override human(): string {
    return `sleeping ${pyFixed(this.seconds / 60, 0)}m (until ${this.until})`;
  }
}

export class ErrorEvent extends AutoSwitchEvent {
  static override readonly KIND = "error";
  readonly message: string;
  readonly transient: boolean;

  constructor(init: { message: string; transient?: boolean; ts?: string }) {
    super(init.ts);
    this.message = init.message;
    this.transient = init.transient ?? true;
  }

  override fields(): Record<string, unknown> {
    return { message: this.message, transient: this.transient };
  }

  override human(): string {
    return `error: ${this.message}` + (this.transient ? " (will retry)" : "");
  }
}

/**
 * A configuration value that is valid but has no effect (for example an
 * `autoswitch.model` name that no account reports). It is not an error:
 * the engine continues on the axes that exist.
 */
export class ConfigWarningEvent extends AutoSwitchEvent {
  static override readonly KIND = "config-warning";
  readonly message: string;

  constructor(init: { message: string; ts?: string }) {
    super(init.ts);
    this.message = init.message;
  }

  override fields(): Record<string, unknown> {
    return { message: this.message };
  }

  override human(): string {
    return `warning: ${this.message}`;
  }
}

/** Outcome of one tick. The values are also the exit codes of `cswap auto --once`. */
export const TickOutcome = Object.freeze({
  SWITCHED: 0,
  ERROR: 1,
  NO_ACTION: 2,
  /** The engine wanted to switch, but no target is viable, or all accounts are exhausted. */
  BLOCKED: 3,
} as const);
export type TickOutcome = (typeof TickOutcome)[keyof typeof TickOutcome];

/** `oauth.credentialFingerprint`: the quarantine binds to this fingerprint of the stored credential. */
export const refreshFingerprint = oauth.credentialFingerprint;

/**
 * Ordered window label → pct: "5h", "7d", then the configured scoped names.
 * Only the windows that the decision reads, so the display agrees with the decision.
 */
export function windowPcts(usage: oauth.UsageDict | null, models: readonly string[] = []): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, pct] of oauth.relevantWindows(usage, models)) out[name] = pct;
  return out;
}

export const limitingResetTs = pollPolicy.limitingResetTs;
export const earliestFutureResetTs = pollPolicy.earliestFutureResetTs;
export const parseResetTs = pollPolicy.parseResetTs;

/**
 * Epoch of the 7-day window reset of an account, or null if unknown or past.
 *
 * Consume-first ranks by this value. A past reset counts as unknown: as a real
 * instant, it would rank the account that just rolled over as the "soonest".
 */
export function sevenDayResetTs(usage: UsageValue | undefined, now: number): number | null {
  if (isDict(usage)) {
    const window: unknown = usage.seven_day;
    if (isRecord(window)) {
      const ts = parseResetTs(window.resets_at as string | null | undefined);
      if (ts !== null && ts > now) return ts;
    }
  }
  return null;
}

/**
 * When the binding window of this account resets, as a sort key.
 *
 * The binding window is the relevant window with the highest pct. The function
 * picks it first, then reads its reset: a filter on the reset before the max
 * lets a lower window win. Returns `Infinity` if the reset is unknown or past,
 * so that account sorts last.
 */
export function bindingRecoveryTs(usage: UsageValue | undefined, models: readonly string[], now: number): number {
  const windows = oauth.relevantWindows(isDict(usage) ? usage : null, models);
  if (windows.length === 0) return Infinity;
  let binding = windows[0]!;
  for (const w of windows) if (w[1] > binding[1]) binding = w;
  const ts = parseResetTs(binding[2]);
  return ts !== null && ts > now ? ts : Infinity;
}

/**
 * True if the active account AND every measured candidate are at or over the threshold.
 *
 * The headroom of the active account must be known. At least one candidate must be measured.
 */
export function everyAccountAboveThreshold(
  candidates: readonly string[],
  headroom: Readonly<Record<string, number | null>>,
  activeHeadroom: number | null,
  threshold: number,
): boolean {
  if (activeHeadroom === null || 100.0 - activeHeadroom < threshold) return false;
  const measured = candidates.map((n) => own(headroom, n)).filter((h): h is number => h != null);
  if (measured.length === 0) return false;
  return measured.every((h) => 100.0 - h >= threshold);
}

export function ref(number: string, email: string): AccountRef {
  return { number: Number.parseInt(number, 10), email };
}

/** Headroom per account, from the decision values. */
export function headroomByAccount(
  usage: Readonly<Record<string, UsageValue>>,
  models: readonly string[],
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [num, value] of Object.entries(usage)) out[num] = oauth.accountHeadroom(isDict(value) ? value : null, models);
  return out;
}

/** Elementwise comparison of two sort keys, like a Python tuple comparison. */
function compareKeys(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return a.length - b.length;
}

/**
 * Python `threading.Event` for one event loop. `wait` returns at the timeout or at
 * `set()`, the first that comes. It always clears its timer, so a stopped loop lets the process exit.
 */
export class WakeEvent {
  private flag = false;
  private readonly waiters = new Set<() => void>();

  set(): void {
    this.flag = true;
    for (const resolve of [...this.waiters]) resolve();
    this.waiters.clear();
  }

  clear(): void {
    this.flag = false;
  }

  isSet(): boolean {
    return this.flag;
  }

  /** Wait at most `seconds`. Returns true if the event is set. */
  async wait(seconds: number): Promise<boolean> {
    if (this.flag) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done: (() => void) | undefined;
    try {
      await new Promise<void>((resolve) => {
        done = resolve;
        this.waiters.add(resolve);
        timer = setTimeout(resolve, Math.max(0, seconds) * 1000);
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (done !== undefined) this.waiters.delete(done);
    }
    return this.flag;
  }
}

/** The part of `ClaudeAccountSwitcher` that the engine uses. */
export type EngineSwitcher = Pick<
  ClaudeAccountSwitcher,
  | "backupDir"
  | "setPollPolicyInputs"
  | "readAccountCredentials"
  | "accountEmail"
  | "accountKindFor"
  | "liveSessionPidsFor"
  | "consumeBackupGrant"
  | "accountIdentity"
  | "backfillAccountUuid"
  | "currentAccountNumber"
  | "hasLiveLogin"
  | "switchableAccountNumbers"
  | "usageEntriesByAccount"
  | "switchTo"
>;

export interface AutoSwitchEngineOptions {
  dryRun?: boolean;
  statePath?: string | null;
  /** Wall time in seconds. The persisted cooldown timestamps must stay valid across processes. */
  clock?: () => number;
}

/** The inputs of `rankCandidates`, without `noReturn`. */
export interface RankArgs {
  trigger: string;
  consumeFirst: boolean;
  oauthCandidates: readonly string[];
  usage: Readonly<Record<string, UsageValue>>;
  headroom: Readonly<Record<string, number | null>>;
  current: string;
  activeHeadroom: number | null;
  settings: AutoSwitchSettings;
  now: number;
}

/** `[ordered, anyKnown, activeResetTs]` */
export type RankResult = [ordered: string[], anyKnown: boolean, activeResetTs: number | null];

/** `[activeHeadroom, bindingRecoveryTs]` of the account that a switch leaves. */
export type LeftSnapshot = readonly [headroom: number | null, recovery: number];

export type FreshenStatus = string;

/**
 * Threshold-policy auto-switcher over a `ClaudeAccountSwitcher`.
 *
 * `onEvent` gets every `AutoSwitchEvent` synchronously. The engine does not catch
 * its errors: a broken frontend must fail loudly in the tests.
 */
export class AutoSwitchEngine {
  switcher: EngineSwitcher;
  settings: AutoSwitchSettings;
  onEvent: (event: AutoSwitchEvent) => void;
  dryRun: boolean;
  statePath: string;
  clock: () => number;
  /** The model names whose weekly limit also binds the decision. Empty means the 5h/7d windows only. */
  readonly models: readonly string[];
  readonly stopEvent = new WakeEvent();
  /** Cuts the inter-tick sleep short, for example after a threshold change in the TUI. */
  readonly wakeEvent = new WakeEvent();
  unhealthyTicks = 0;
  /** Set on each tick: the target time of a sleep toward a known reset. */
  sleepUntilTs: number | null = null;
  /** Set on each tick: a BLOCKED outcome that cannot change soon can wait longer than the interval. */
  blockedWaitLong = false;
  /** Start of the idle hold. It stays across ticks, for the elapsed-time cap. */
  idleHoldSince: number | null = null;
  /** Set on each tick: the idle hold slows the cadence. */
  idleHoldSlow = false;
  /** The one-time check of `autoswitch.model` for a name that no account reports. */
  modelCheckDone: boolean;

  constructor(
    switcher: EngineSwitcher,
    settings: AutoSwitchSettings,
    onEvent: (event: AutoSwitchEvent) => void,
    { dryRun = false, statePath = null, clock = () => Date.now() / 1000 }: AutoSwitchEngineOptions = {},
  ) {
    this.switcher = switcher;
    this.settings = settings;
    this.models = parseModelNames(settings.model);
    // The collector writes poll plans with the threshold and models of the engine, CLI overrides included.
    switcher.setPollPolicyInputs(settings.threshold, this.models);
    this.onEvent = onEvent;
    this.dryRun = dryRun;
    this.statePath = statePath ?? path.join(switcher.backupDir, STATE_FILENAME);
    this.clock = clock;
    this.modelCheckDone = this.models.length === 0;
  }

  stateLock(): FileLock {
    return new internals.FileLock(path.join(path.dirname(this.statePath), ".autoswitch_state.lock"));
  }

  readState(): AutoSwitchState {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    } catch {
      return {};
    }
    return isDict(raw) ? (raw as AutoSwitchState) : {};
  }

  /**
   * Read-modify-write the state file under its lock. Returns the new state.
   *
   * The lock stops two engines (a loop and a cron `--once`) from overwriting
   * each other. Do not call it while you hold another lock.
   */
  mutateState(mutator: (state: AutoSwitchState) => void): AutoSwitchState {
    return this.stateLock().withLock(() => {
      const state = this.readState();
      state.schemaVersion = STATE_SCHEMA_VERSION;
      mutator(state);
      atomicWriteJson(this.statePath, state);
      return state;
    });
  }

  quarantine(number: string, email: string, reason: string): void {
    const creds = this.switcher.readAccountCredentials(number, email);
    const fingerprint = creds ? refreshFingerprint(creds) : null;
    this.mutateState((state) => {
      if (!isDict(state.quarantine)) state.quarantine = {};
      (state.quarantine as Record<string, unknown>)[number] = {
        email,
        reason,
        at: nowIso(),
        refreshTokenFingerprint: fingerprint,
      };
    });
    this.emit(new QuarantineEvent({ number, email, reason }));
  }

  /**
   * Remove the quarantine entries whose credential changed after the quarantine.
   * A new refresh-token fingerprint (or a slot that holds a different account) means a new login.
   */
  releaseRecoveredQuarantines(state: AutoSwitchState): AutoSwitchState {
    const quarantine = state.quarantine;
    if (!isDict(quarantine) || Object.keys(quarantine).length === 0) return state;
    const toRelease: Array<[string, string, string]> = [];
    for (const [number, raw] of Object.entries(quarantine)) {
      const entry = isDict(raw) ? (raw as Record<string, unknown>) : {};
      const emailNow = this.switcher.accountEmail(number);
      if (!emailNow || emailNow !== entry.email) {
        toRelease.push([number, typeof entry.email === "string" ? entry.email : "", "account-replaced"]);
        continue;
      }
      const creds = this.switcher.readAccountCredentials(number, emailNow);
      const fingerprint = creds ? refreshFingerprint(creds) : null;
      if (fingerprint !== (entry.refreshTokenFingerprint ?? null)) {
        toRelease.push([number, emailNow, "credentials-replaced"]);
      }
    }
    if (toRelease.length === 0) return state;

    const next = this.mutateState((s) => {
      const q = s.quarantine;
      if (isDict(q)) for (const [number] of toRelease) delete (q as Record<string, unknown>)[number];
    });
    for (const [number, email, reason] of toRelease) this.emit(new UnquarantineEvent({ number, email, reason }));
    return next;
  }

  /**
   * Make sure that the stored token of a candidate outlives the 5-minute refresh
   * buffer of Claude Code before the switch.
   *
   * Returns "ok", "invalid_grant" (dead lineage: quarantine), "identity-conflict"
   * (the token authenticates as a different account: quarantine), "transient"
   * (try again next tick), "skip-live-session", or a `SYSTEMIC_STATUSES` kind.
   * Only the backup store of the slot changes. The active credential belongs to Claude Code.
   */
  async freshenTarget(number: string, email: string): Promise<FreshenStatus> {
    if (this.switcher.accountKindFor(number) === "api_key") return "ok";
    if (this.switcher.liveSessionPidsFor(number, email).length > 0) {
      // A live `cswap run` session owns this token. A second copy as the default
      // login would put one rotating refresh token in two config directories.
      return "skip-live-session";
    }
    const creds = this.switcher.readAccountCredentials(number, email);
    if (!creds) return "transient";
    const data = oauth.extractOauthData(creds);
    if (!data) return "invalid_grant";
    const expiresAt = data.expiresAt;
    const nowMs = this.clock() * 1000;
    const nearExpiry = isNumber(expiresAt) && nowMs + FRESHEN_BUFFER_MS >= expiresAt;
    if (!nearExpiry) return "ok";
    // The consume gate serializes every POST of a backup refresh token, so a
    // freshen that races the collector cannot consume one grant two times.
    const outcome = await this.switcher.consumeBackupGrant(number, email, creds);
    if (outcome.error === null && outcome.credentials) {
      if (this.noteTokenIdentity(number, outcome.tokenAccount)) return "identity-conflict";
      return "ok";
    }
    if (outcome.error === "invalid_grant" || outcome.error === "no_refresh_token") return "invalid_grant";
    if (outcome.error !== null && SYSTEMIC_STATUSES.includes(outcome.error)) return outcome.error;
    return "transient";
  }

  /**
   * Use the identity that the token endpoint sends to verify or backfill a slot.
   *
   * Returns true on a conflict: the credential authenticates under a different
   * organization (compared first), or as a different account uuid. A slot with no
   * uuid gets the uuid of the token, but only if the organizations agree.
   * A wrong uuid in the slot record would stay, because a backfill never changes a uuid.
   */
  noteTokenIdentity(number: string, tokenAccount: unknown): boolean {
    if (!isDict(tokenAccount)) return false;
    const rawUuid = (tokenAccount as Record<string, unknown>).uuid;
    if (typeof rawUuid !== "string" || !rawUuid.trim()) return false;
    const taUuid = rawUuid.trim();
    const slotIdentity = this.switcher.accountIdentity(number);
    const taOrg = (tokenAccount as Record<string, unknown>).organizationUuid;
    const slotOrg = slotIdentity.organizationUuid || "";
    if (typeof taOrg === "string" && taOrg && slotOrg && taOrg !== slotOrg) return true;
    if (!slotIdentity.uuid) {
      try {
        this.switcher.backfillAccountUuid(number, taUuid);
      } catch (e) {
        logger.debug("uuid backfill failed for account %s: %r", number, e);
      }
      return false;
    }
    return slotIdentity.uuid !== taUuid;
  }

  /** Evaluate once: poll the usage, and switch if necessary. Never throws. */
  async tick(): Promise<TickOutcome> {
    try {
      return await this.tickInner();
    } catch (e) {
      if (e instanceof ClaudeSwitchError) {
        this.emit(new ErrorEvent({ message: e.message, transient: true }));
      } else {
        const text = e instanceof Error ? `${e.name}: ${e.message}` : `Error: ${String(e)}`;
        this.emit(new ErrorEvent({ message: text, transient: true }));
      }
      return TickOutcome.ERROR;
    }
  }

  async tickInner(): Promise<TickOutcome> {
    this.sleepUntilTs = null;
    this.blockedWaitLong = false;
    this.idleHoldSlow = false;
    const settings = this.settings;
    let state = this.readState();
    // A dry run writes nothing, so only a real tick releases a quarantine.
    if (!this.dryRun) state = this.releaseRecoveredQuarantines(state);
    const quarantined = new Set(isDict(state.quarantine) ? Object.keys(state.quarantine) : []);

    const current = this.switcher.currentAccountNumber();
    if (current === null) {
      this.emit(new PollEvent({ active: null, headroom: {}, threshold: settings.threshold }));
      if (this.switcher.hasLiveLogin()) {
        // A switch would overwrite a login that cswap does not manage, with no backup.
        this.emit(
          new NoSwitchEvent({
            reason: "unmanaged-active-account",
            detail: "run 'cswap --add-account' to include it in rotation",
          }),
        );
      } else {
        this.emit(
          new NoSwitchEvent({ reason: "no-active-account", detail: "log in and run 'cswap --add-account' first" }),
        );
      }
      return TickOutcome.NO_ACTION;
    }

    const currentEmail = this.switcher.accountEmail(current);
    const activeRef: AccountRef = currentEmail
      ? ref(current, currentEmail)
      : { number: Number.parseInt(current, 10), email: "" };

    let [entries, usage, headroom] = await this.collectScheduledUsage(current, quarantined, settings.threshold);
    const fetchErrors: Record<string, string> = {};
    for (const [num, entry] of Object.entries(entries)) {
      if (own(usage, num) == null && entry.lastError) fetchErrors[num] = entry.lastError;
    }
    const windows: Record<string, Record<string, number>> = {};
    for (const [num, value] of Object.entries(usage)) {
      const pcts = windowPcts(isDict(value) ? value : null, this.models);
      if (Object.keys(pcts).length > 0) windows[num] = pcts;
    }
    this.emit(new PollEvent({ active: activeRef, headroom, threshold: settings.threshold, fetchErrors, windows }));

    if (!this.modelCheckDone) this.checkModelNames(quarantined, usage);

    if (this.switcher.accountKindFor(current) === "api_key" && !settings.includeApiKeyAccounts) {
      this.emit(new NoSwitchEvent({ reason: "active-api-key", detail: "API-key accounts have no quota to watch" }));
      return TickOutcome.NO_ACTION;
    }

    let activeHeadroom = own(headroom, current) ?? null;
    let trigger: string;
    if (activeHeadroom !== null) {
      this.unhealthyTicks = 0;
      this.idleHoldSince = null;
      const utilization = 100.0 - activeHeadroom;
      if (utilization < settings.threshold) {
        if (settings.strategy !== "consume-first") {
          this.emit(
            new NoSwitchEvent({
              reason: "below-threshold",
              detail: `${pctLabel(utilization)}% < ${pctLabel(settings.threshold)}%`,
            }),
          );
          return TickOutcome.NO_ACTION;
        }
        // Consume-first: below the threshold, move to the account whose weekly
        // window resets first, to use the most perishable quota first.
        trigger = "consume-first";
      } else {
        trigger = activeHeadroom <= 0 ? "at-limit" : "proactive";
      }
    } else {
      if (own(usage, current) === USAGE_TOKEN_EXPIRED) {
        // The token expired and the locked refresh did not complete in this pass.
        // A later pass retries it. Nothing burns quota, so crawl instead of counting failover ticks.
        const now = this.clock();
        if (this.idleHoldSince === null) this.idleHoldSince = now;
        if (now - this.idleHoldSince <= IDLE_HOLD_MAX_S) {
          this.unhealthyTicks = 0;
          this.idleHoldSlow = true;
          this.emit(
            new NoSwitchEvent({
              reason: "active-idle",
              detail: "token expired while Claude Code is idle; resumes on next use",
            }),
          );
          return TickOutcome.NO_ACTION;
        }
        logger.warning(
          `Active token expired and owned for over ${pyFixed(IDLE_HOLD_MAX_S / 60, 0)} minutes; ` +
            "resuming unhealthy counting (dead refresh token?)",
        );
      } else {
        this.idleHoldSince = null;
      }
      this.unhealthyTicks += 1;
      if (this.unhealthyTicks < settings.unhealthyTicks) {
        this.emit(
          new NoSwitchEvent({
            reason: "active-usage-unknown",
            detail: `${this.unhealthyTicks}/${settings.unhealthyTicks} before failover`,
          }),
        );
        return TickOutcome.NO_ACTION;
      }
      trigger = "failover";
    }

    if ((trigger === "proactive" || trigger === "consume-first") && this.inCooldown(state)) {
      this.emit(new NoSwitchEvent({ reason: "cooldown" }));
      return TickOutcome.NO_ACTION;
    }

    const candidates = this.switcher
      .switchableAccountNumbers()
      .filter((num) => num !== current && !quarantined.has(num));
    const oauthCandidates = candidates.filter((n) => this.switcher.accountKindFor(n) !== "api_key");
    const apiKeyCandidates = settings.includeApiKeyAccounts
      ? candidates.filter((n) => this.switcher.accountKindFor(n) === "api_key")
      : [];
    if (trigger === "consume-first" && oauthCandidates.length === 0 && activeHeadroom !== null) {
      // No OAuth peer to compare with. API-key accounts have no weekly window to consume.
      // Keep the exit code of the "best" strategy: a cron wrapper must not see a false BLOCKED.
      this.emit(
        new NoSwitchEvent({
          reason: "below-threshold",
          detail: `${pctLabel(100.0 - activeHeadroom)}% < ${pctLabel(settings.threshold)}%`,
        }),
      );
      return TickOutcome.NO_ACTION;
    }
    if (oauthCandidates.length === 0 && apiKeyCandidates.length === 0) {
      // Nothing changes until the user adds or recovers an account.
      this.blockedWaitLong = true;
      this.emit(new NoSwitchEvent({ reason: "no-candidates" }));
      return TickOutcome.BLOCKED;
    }

    const consumeFirst = settings.strategy === "consume-first";

    // Rank with the no-return bar. Rank again without it only if the bar leaves
    // nothing AND the barred account recovered after the departure: on two accounts
    // the barred ranking is always empty, so emptiness alone is not the release.
    const rank = (args: RankArgs): RankResult => {
      const recovered = this.leftAccountRecovered(
        state,
        args.usage,
        args.headroom,
        args.activeHeadroom,
        args.settings,
        args.now,
        args.current,
      );
      const noReturn = this.noReturnAccount(
        trigger,
        state,
        args.headroom,
        args.activeHeadroom,
        recovered,
        args.settings,
        args.current,
      );
      const ranked = this.rankCandidates({ ...args, noReturn });
      if (noReturn !== null && ranked[0].length === 0 && recovered) {
        const unbarred = this.rankCandidates({ ...args, noReturn: null });
        if (unbarred[0].length > 0) return unbarred;
      }
      return ranked;
    };

    let decidedNow = this.clock();
    let [ordered, anyKnown, activeResetTs] = rank({
      trigger,
      consumeFirst,
      oauthCandidates,
      usage,
      headroom,
      current,
      activeHeadroom,
      settings,
      now: decidedNow,
    });

    if (trigger === "consume-first" && ordered.length > 0) {
      // Two-phase commit: the provisional pick can use a snapshot that is
      // CANDIDATE_MAX_INTERVAL_S old. A switch is near, so fetch now and decide again on fresh data.
      entries = await this.switcher.usageEntriesByAccount(new Set([current, ...candidates]));
      usage = {};
      for (const [num, entry] of Object.entries(entries)) usage[num] = entry.decisionValue();
      headroom = headroomByAccount(usage, this.models);
      activeHeadroom = own(headroom, current) ?? null;
      decidedNow = this.clock();
      [ordered, anyKnown, activeResetTs] = rank({
        trigger,
        consumeFirst,
        oauthCandidates,
        usage,
        headroom,
        current,
        activeHeadroom,
        settings,
        now: decidedNow,
      });
    }

    if (ordered.length === 0 && apiKeyCandidates.length > 0 && trigger !== "consume-first") {
      // Last resort when the engine must move: metered API-key accounts.
      ordered = apiKeyCandidates;
    }

    if (ordered.length === 0) {
      if (!anyKnown) {
        this.emit(new NoSwitchEvent({ reason: "no-comparison", detail: "no candidate has readable usage" }));
        return TickOutcome.BLOCKED;
      }
      if (trigger === "consume-first") {
        if (activeResetTs === null) {
          this.emit(
            new NoSwitchEvent({
              reason: "reset-unknown",
              detail: "active account's weekly reset time is unknown; consume-first is idle until it is reported",
            }),
          );
          return TickOutcome.NO_ACTION;
        }
        this.emit(
          new NoSwitchEvent({
            reason: "already-consuming-soonest",
            detail: "no sooner-resetting account with room to spare",
          }),
        );
        return TickOutcome.NO_ACTION;
      }
      // "All exhausted" only when it is true: every candidate is known and at its limit.
      // Other blocks can clear on any tick, so they keep the normal cadence.
      const trulyExhausted = oauthCandidates.every((n) => {
        const h = own(headroom, n);
        return h != null && h <= 0;
      });
      if (!trulyExhausted) {
        this.emit(
          new NoSwitchEvent({
            reason: "no-qualifying-candidate",
            detail:
              "no candidate is below the threshold and better than the active account by the " +
              "hysteresis margin, or usage is unreadable this tick",
          }),
        );
        return TickOutcome.BLOCKED;
      }
      this.blockedWaitLong = true;
      const earliest = this.earliestRecovery(usage);
      if (earliest !== null) this.sleepUntilTs = earliest.getTime() / 1000 + RESET_SLACK_S;
      this.emit(
        new AllExhaustedEvent({
          earliestResetAt: earliest !== null ? isoformat(earliest).replace("+00:00", "Z") : null,
        }),
      );
      return TickOutcome.BLOCKED;
    }

    // The departure snapshot comes from the same usage that the ranking used
    // (for consume-first, the phase-2 fetch).
    const leftSnapshot: LeftSnapshot = [activeHeadroom, bindingRecoveryTs(own(usage, current), this.models, decidedNow)];
    let transientFailure = false;
    let systemic = "";
    for (const num of ordered) {
      const email = this.switcher.accountEmail(num);
      if (trigger === "consume-first") {
        // The phase-2 fetch is best effort. Consume-first is not an escape:
        // never act on stale data and never take a lower-ranked target.
        const entry = own(entries, num);
        if (entry === undefined || !entry.fresh(this.clock())) {
          this.emit(
            new NoSwitchEvent({
              reason: "stale-usage",
              detail:
                `account ${num} usage could not be refreshed this tick ` +
                "(backoff or a concurrent poller); retrying",
            }),
          );
          return TickOutcome.NO_ACTION;
        }
      }
      // A dry run stops at the decision: a token refresh and a quarantine are changes.
      if (this.dryRun) return this.perform(num, email, trigger, leftSnapshot);
      const status = await this.freshenTarget(num, email);
      if (status === "identity-conflict") {
        this.quarantine(num, email, "identity-conflict");
        continue;
      }
      if (status === "invalid_grant") {
        this.quarantine(num, email, "invalid_grant");
        continue;
      }
      if (status === "transient") {
        transientFailure = true;
        continue;
      }
      if (SYSTEMIC_STATUSES.includes(status)) {
        // Report the most actionable cause, not the cause of the last candidate.
        if (!systemic || SYSTEMIC_STATUSES.indexOf(status) < SYSTEMIC_STATUSES.indexOf(systemic)) {
          systemic = status;
        }
        continue;
      }
      if (status === "skip-live-session") continue;
      return this.perform(num, email, trigger, leftSnapshot);
    }

    if (systemic || transientFailure) {
      this.emit(
        new ErrorEvent({
          message: systemic
            ? "could not freshen: " + SYSTEMIC_MESSAGES[systemic]
            : "could not freshen any candidate (network?)",
          transient: true,
        }),
      );
      return TickOutcome.ERROR;
    }
    this.emit(new NoSwitchEvent({ reason: "no-viable-target" }));
    return TickOutcome.BLOCKED;
  }

  /**
   * The account that this engine left last, while it is still barred. Never undo the previous move.
   *
   * - Only for `proactive` and `consume-first`. At-limit and failover skip the anti-flap gates.
   * - Only while the engine stands where its last switch put it (`lastSwitchTo == current`).
   *   A manual switch already undid the move. A record with no `lastSwitchTo` keeps the bar.
   * - Released if the left account `recovered` and now beats the active account by
   *   `HORIZON_HEADROOM_RATIO`. Without `recovered`, the ratio comes true only because the active burns.
   *
   * The release for "the bar leaves nothing" is in the `rank` closure of `tickInner`, not here.
   */
  noReturnAccount(
    trigger: string,
    state: AutoSwitchState,
    headroom: Readonly<Record<string, number | null>>,
    activeHeadroom: number | null,
    recovered: boolean,
    settings: AutoSwitchSettings | null,
    current: string | null = null,
  ): string | null {
    const cameFrom = state.lastSwitchFrom;
    if ((trigger !== "proactive" && trigger !== "consume-first") || cameFrom == null) return null;
    // String on the two sides: `lastSwitchTo` is a string and `lastSwitchFrom` is a number.
    const landedOn = state.lastSwitchTo;
    if (landedOn != null && current !== null) {
      if (String(landedOn) !== String(current)) return null;
    }
    const barred = String(cameFrom);
    if (!recovered) return barred;
    const leftHeadroom = own(headroom, barred);
    if (leftHeadroom != null) {
      if (activeHeadroom !== null) {
        if (leftHeadroom >= activeHeadroom * HORIZON_HEADROOM_RATIO) return null;
      } else if (settings !== null && leftHeadroom > 100.0 - settings.threshold) {
        // An unreadable active account must not count as "the peer does not beat it".
        return null;
      }
    }
    return barred;
  }

  /**
   * True if the account that the engine left is better now than at the departure.
   *
   * `perform` records the departure (`leftHeadroom`, `leftRecoveryAt`, `leftTrigger`).
   * A record with no `leftHeadroom` releases: with no evidence, a permanent lockout is the worse failure.
   *
   * After a failover the departure severity is not known, so two legs read only the present state:
   * - landing: the peer is a healthy landing now (`h > 100 - threshold`).
   * - recovery: the binding reset of the peer is `RECOVERY_HYSTERESIS_S` sooner than that of
   *   the active account. The active reset must be known, or the peer must be inside `RECOVERY_HORIZON_S`.
   *
   * After an ordinary departure, three legs, in this order:
   * - dominance: `h > active × HORIZON_HEADROOM_RATIO + SPENT_HEADROOM_PCT`
   *   (with an unreadable active account, the landing test).
   * - headroom: `h >= leftHeadroom + SPENT_HEADROOM_PCT`.
   * - recovery: the binding reset is `RECOVERY_HYSTERESIS_S` sooner than at the departure.
   * Burn of the active account cannot make these legs true.
   */
  leftAccountRecovered(
    state: AutoSwitchState,
    usage: Readonly<Record<string, UsageValue>>,
    headroom: Readonly<Record<string, number | null>>,
    activeHeadroom: number | null,
    settings: AutoSwitchSettings,
    now: number,
    current: string | null = null,
  ): boolean {
    const cameFrom = state.lastSwitchFrom;
    if (cameFrom == null) return true;
    const barred = String(cameFrom);
    if (!("leftHeadroom" in state)) return true;
    const h = own(headroom, barred) ?? null;
    const leftHeadroom = state.leftHeadroom;
    const leftRecovery = state.leftRecoveryAt;
    // A consume-first departure can also write (null, null). `leftTrigger` records the
    // real trigger. An older record has no `leftTrigger`, so it uses the two-null inference.
    const leftTrigger = state.leftTrigger;
    const isFailoverSnapshot =
      leftTrigger != null ? leftTrigger === "failover" : leftHeadroom == null && leftRecovery == null;
    const usageOf = (num: string | null): UsageValue | undefined => (num === null ? undefined : own(usage, num));
    if (isFailoverSnapshot) {
      if (h !== null && h > 100.0 - settings.threshold) return true;
      const peerRecoveryTs = bindingRecoveryTs(usageOf(barred), this.models, now);
      const activeRecoveryTs = bindingRecoveryTs(usageOf(current), this.models, now);
      // `Infinity` means "unknown" as well as "never". An unknown active reset holds,
      // except if the peer comes back inside the horizon.
      return (
        (Number.isFinite(activeRecoveryTs) || peerRecoveryTs - now <= RECOVERY_HORIZON_S) &&
        peerRecoveryTs < activeRecoveryTs - RECOVERY_HYSTERESIS_S
      );
    }
    if (h !== null) {
      if (activeHeadroom !== null) {
        if (h > activeHeadroom * HORIZON_HEADROOM_RATIO + SPENT_HEADROOM_PCT) return true;
      } else if (h > 100.0 - settings.threshold) {
        return true;
      }
    }
    if (isNumber(leftHeadroom) && h !== null && h >= Math.min(leftHeadroom + SPENT_HEADROOM_PCT, 100.0)) {
      return true;
    }
    // Null on disk means "unknown or past" (`Infinity`). A move to a real reset is an improvement.
    const was = isNumber(leftRecovery) ? leftRecovery : Infinity;
    return bindingRecoveryTs(usageOf(barred), this.models, now) < was - RECOVERY_HYSTERESIS_S;
  }

  /**
   * Filter and rank the OAuth candidates for the trigger of this tick.
   *
   * Returns `[ordered, anyKnown, activeResetTs]`. It has no side effects, so the
   * consume-first two-phase commit can call it two times in one tick.
   */
  rankCandidates(args: RankArgs & { noReturn: string | null }): RankResult {
    const { trigger, consumeFirst, oauthCandidates, noReturn, usage, headroom, current, activeHeadroom, settings, now } =
      args;
    const activeResetTs = consumeFirst ? sevenDayResetTs(own(usage, current), now) : null;
    // When nothing is below the threshold, the goal changes from "most headroom" to "soonest back".
    const allAbove = everyAccountAboveThreshold(oauthCandidates, headroom, activeHeadroom, settings.threshold);
    // The most headroom that a readable candidate offers. Unknown rows do not count as zero.
    // The no-return bar does not apply here: this asks if the fleet has quota.
    let bestCandidateHeadroom = 0.0;
    let anyMeasured = false;
    for (const n of oauthCandidates) {
      const h = own(headroom, n);
      if (h == null) continue;
      bestCandidateHeadroom = anyMeasured ? Math.max(bestCandidateHeadroom, h) : h;
      anyMeasured = true;
    }
    const activeRecoveryTs = allAbove ? bindingRecoveryTs(own(usage, current), this.models, now) : 0.0;
    const active = activeHeadroom ?? 0.0;

    let qualifying: Array<[number[], string]> = [];
    const fallback: Array<[number[], string]> = [];
    let anyKnown = false;
    for (const num of oauthCandidates) {
      const h = own(headroom, num);
      if (h == null) continue;
      anyKnown = true;
      if (h <= 0) continue;
      if (num === noReturn) continue;
      const resetTs = consumeFirst ? sevenDayResetTs(own(usage, num), now) : null;
      const recoveryTs = allAbove ? bindingRecoveryTs(own(usage, num), this.models, now) : 0.0;
      let byRecovery = false;
      if (trigger === "proactive" || trigger === "consume-first") {
        // The landing must be healthy, or the next tick triggers again.
        if (100.0 - h >= settings.threshold && !allAbove) continue;
        if (allAbove) {
          byRecovery = recoveryIsUseful(recoveryTs, activeRecoveryTs, active, bestCandidateHeadroom, now);
          if (byRecovery) {
            if (recoveryTs >= activeRecoveryTs - RECOVERY_HYSTERESIS_S) continue;
          } else if (h < active * HORIZON_HEADROOM_RATIO) {
            // A spent active account can still move to a peer with no less headroom
            // that comes back sooner. This fallback applies only if nothing else qualifies.
            if (active <= SPENT_HEADROOM_PCT && h >= active && recoveryTs < activeRecoveryTs - RECOVERY_HYSTERESIS_S) {
              fallback.push([[0, recoveryTs, -h], num]);
            }
            continue;
          }
        } else if (consumeFirst) {
          // Below the threshold, only an account whose weekly window resets sooner.
          if (
            trigger === "consume-first" &&
            (resetTs === null || activeResetTs === null || resetTs >= activeResetTs)
          ) {
            continue;
          }
        } else if (activeHeadroom !== null) {
          if (h - activeHeadroom < settings.hysteresisPct) continue;
        }
      }
      let key: number[];
      if (allAbove && (trigger === "proactive" || trigger === "consume-first")) {
        // Tiered, so that the two axes stay comparable. The reset breaks ties on the headroom axis.
        key = byRecovery ? [0, recoveryTs, -h] : [1, -h, recoveryTs];
      } else if (consumeFirst) {
        key = [resetTs ?? Infinity, -h];
      } else {
        key = [-h];
      }
      qualifying.push([key, num]);
    }
    if (qualifying.length === 0) qualifying = fallback;
    qualifying.sort((a, b) => compareKeys(a[0], b[0]));
    return [qualifying.map(([, num]) => num), anyKnown, activeResetTs];
  }

  /**
   * Two-phase usage collection with a constant baseline.
   *
   * Phase A fetches the active account (when its persisted poll plan says it is due)
   * and ONE due candidate (the stalest). The store serves all other accounts.
   * Phase B fetches all candidates before a decision when a switch can be near:
   * the active utilization is within `ESCALATION_MARGIN_PCT` of the threshold, or
   * the active usage is unknown (but not an expired token that Claude Code owns).
   * During an idle hold, no candidate is polled.
   *
   * Returns `[entries, usage, headroom]`. `usage` holds the decision values.
   */
  async collectScheduledUsage(
    current: string,
    quarantined: ReadonlySet<string> = new Set(),
    threshold: number | null = null,
  ): Promise<[Record<string, UsageEntry>, Record<string, UsageValue>, Record<string, number | null>]> {
    const now = this.clock();
    // A quarantined account cannot be a target, so it gets no poll slot.
    const candidates = this.switcher
      .switchableAccountNumbers()
      .filter((n) => n !== current && !quarantined.has(n));

    const pre = await this.switcher.usageEntriesByAccount(new Set());
    const plan = new Set<string>();
    const activePre = own(pre, current);
    // A candidate-style plan on the active slot (a role change that the switcher did not
    // see, for example a manual login) is overridden after the active age cap.
    const staleCandidatePlan =
      activePre !== undefined &&
      activePre.ageS !== null &&
      activePre.ageS >= pollPolicy.ACTIVE_MAX_INTERVAL_S &&
      (activePre.pollIntervalS || 0.0) > pollPolicy.ACTIVE_MAX_INTERVAL_S &&
      (bindingPct(activePre.lastGood, this.models) || 0.0) < 100.0;
    const oversleptPlan = activePre !== undefined && planOversleepsInterval(activePre, now);
    if (
      activePre === undefined ||
      activePre.ageS === null ||
      staleCandidatePlan ||
      oversleptPlan ||
      (activePre.nextPollAt !== null && now >= activePre.nextPollAt) ||
      (activePre.nextPollAt === null && activePre.ageS >= pollPolicy.MIN_INTERVAL_S)
    ) {
      plan.add(current);
    }
    if (this.idleHoldSince === null) {
      const pick = dueCandidate(candidates, pre, now);
      if (pick !== null) plan.add(pick);
    }
    let entries = await this.switcher.usageEntriesByAccount(plan, { scheduled: !staleCandidatePlan });
    let usage = decisionValues(entries);

    const activeValue = own(usage, current) ?? null;
    const activeHeadroom = oauth.accountHeadroom(isDict(activeValue) ? activeValue : null, this.models);
    // The threshold of the tick snapshot, so one tick fetches and decides with one value.
    const effectiveThreshold = threshold ?? this.settings.threshold;
    const escalate =
      candidates.length > 0 &&
      ((activeHeadroom === null && activeValue !== USAGE_TOKEN_EXPIRED) ||
        (activeHeadroom !== null && 100.0 - activeHeadroom >= effectiveThreshold - ESCALATION_MARGIN_PCT));
    if (escalate) {
      const escalationFetch = new Set([current, ...candidates]);
      // An exhausted row that the decision trusts cannot be a target. Keep its
      // wider post-429 plan instead of a fetch at the exhausted wake cadence.
      for (const num of [...escalationFetch]) {
        const entry = own(entries, num);
        const value = own(usage, num);
        const plannedHeadroom = oauth.accountHeadroom(isDict(value) ? value : null, this.models);
        if (
          entry !== undefined &&
          entry.nextPollAt !== null &&
          now < entry.nextPollAt &&
          (entry.pollIntervalS || 0.0) > pollPolicy.EXHAUSTED_INTERVAL_S &&
          plannedHeadroom !== null &&
          plannedHeadroom <= 0
        ) {
          escalationFetch.delete(num);
        }
      }
      entries = await this.switcher.usageEntriesByAccount(escalationFetch);
      usage = decisionValues(entries);
    }

    return [entries, usage, headroomByAccount(usage, this.models)];
  }

  async perform(number: string, email: string, trigger: string, left: LeftSnapshot): Promise<TickOutcome> {
    if (this.dryRun) {
      const current = this.switcher.currentAccountNumber();
      const currentEmail = current ? this.switcher.accountEmail(current) : "";
      this.emit(
        new SwitchEvent({
          trigger,
          fromRef: current ? ref(current, currentEmail) : null,
          toRef: ref(number, email),
          dryRun: true,
        }),
      );
      return TickOutcome.SWITCHED;
    }

    // Hold the state lock across recheck, switch and record, so two engines make one
    // serialized decision. The switch path never takes the state lock, so no deadlock.
    const lock = this.stateLock();
    await whenStateLockIdle(lock.lockPath);
    lock.enter();
    stateLocksHeld.add(lock.lockPath);
    let result: Awaited<ReturnType<EngineSwitcher["switchTo"]>>;
    try {
      const state = this.readState();
      if ((trigger === "proactive" || trigger === "consume-first") && this.inCooldown(state)) {
        this.emit(new NoSwitchEvent({ reason: "cooldown" }));
        return TickOutcome.NO_ACTION;
      }

      result = await this.switcher.switchTo(number, true);
      if (!result || !result.switched) {
        this.emit(new NoSwitchEvent({ reason: "already-active", detail: result?.reason ?? "" }));
        return TickOutcome.NO_ACTION;
      }

      state.schemaVersion = STATE_SCHEMA_VERSION;
      state.lastSwitchAt = this.clock();
      state.lastSwitchTo = number;
      // Where the engine came from, and how that account looked, so the next tick can
      // refuse to undo the move and release that refusal. `Infinity` is stored as null.
      state.lastSwitchFrom = result.from?.number ?? null;
      const [leftHeadroom, recovery] = left;
      state.leftHeadroom = leftHeadroom;
      state.leftRecoveryAt = recovery === Infinity ? null : recovery;
      state.leftTrigger = trigger;
      atomicWriteJson(this.statePath, state);
    } finally {
      stateLocksHeld.delete(lock.lockPath);
      lock.exit();
    }

    this.emit(
      new SwitchEvent({ trigger, fromRef: result.from, toRef: result.to, warnings: result.warnings ?? [] }),
    );
    return TickOutcome.SWITCHED;
  }

  inCooldown(state: AutoSwitchState): boolean {
    const last = state.lastSwitchAt;
    if (!isNumber(last)) return false;
    return this.clock() - last < this.settings.cooldownSeconds;
  }

  /**
   * One-time check of `autoswitch.model` for a name that no account reports.
   * It decides only when every relevant OAuth account has readable usage in this tick.
   */
  checkModelNames(quarantined: ReadonlySet<string>, usage: Readonly<Record<string, UsageValue>>): void {
    const wanted = new Map<string, string>();
    for (const m of this.models) if (m.toLowerCase() !== "all") wanted.set(m.toLowerCase(), m);
    if (wanted.size === 0) {
      this.modelCheckDone = true;
      return;
    }
    const relevant = this.switcher
      .switchableAccountNumbers()
      .filter((n) => !quarantined.has(n) && this.switcher.accountKindFor(n) !== "api_key");
    const values = relevant.map((n) => own(usage, n));
    const readable = values.filter(isDict);
    if (readable.length === 0 || readable.length !== values.length) return;
    const seen = new Set<string>();
    for (const v of readable) {
      const scoped: unknown = v.scoped;
      if (!Array.isArray(scoped)) continue;
      for (const s of scoped as unknown[]) {
        if (isDict(s) && typeof (s as Record<string, unknown>).name === "string") {
          seen.add(((s as Record<string, unknown>).name as string).toLowerCase());
        }
      }
    }
    this.modelCheckDone = true;
    const missing = [...wanted].filter(([low]) => !seen.has(low)).map(([, name]) => name);
    if (missing.length > 0) {
      this.emit(
        new ConfigWarningEvent({
          message:
            `autoswitch.model: ${missing.join(", ")} matches no account's usage windows — ` +
            "only the 5h/7d limits are being watched for it (typo?)",
        }),
      );
    }
  }

  /**
   * The first time (UTC) that an account becomes usable again, or null if that time is not certain.
   *
   * For each account, the latest reset of its windows at 100% or more. Then the
   * minimum across the accounts, the active account included. If a blocked
   * account has no usable reset time, the result is null, so the engine does not oversleep.
   */
  earliestRecovery(usage: Readonly<Record<string, UsageValue>>): Date | null {
    let earliest: number | null = null;
    const now = this.clock();
    for (const value of Object.values(usage)) {
      if (!isDict(value)) continue;
      const blocked = oauth.relevantWindows(value, this.models).filter(([, pct]) => pct >= 100.0);
      if (blocked.length === 0) continue;
      const usableAt = limitingResetTs(value, this.models);
      if (usableAt === null || usableAt <= now) return null;
      if (earliest === null || usableAt < earliest) earliest = usableAt;
    }
    if (earliest === null) return null;
    return new Date(earliest * 1000);
  }

  emit(event: AutoSwitchEvent): void {
    this.onEvent(event);
  }

  /**
   * Ask `runLoop` to stop. It also stops a sleep. The stop stays set, so a call
   * before the loop starts makes the loop return at once (an engine is single-use).
   */
  stop(): void {
    this.stopEvent.set();
    this.wakeEvent.set();
  }

  /** Stop the current inter-tick sleep and tick now. */
  wake(): void {
    this.wakeEvent.set();
  }

  /**
   * Session override from the TUI: change the threshold of the trigger and of the poll cadence.
   * The model axes stay as they were at construction.
   */
  applyThreshold(threshold: number): void {
    this.settings = Object.freeze({ ...this.settings, threshold });
    this.switcher.setPollPolicyInputs(threshold, this.models);
  }

  async nextDelay(outcome: TickOutcome): Promise<number> {
    const interval = this.settings.intervalSeconds;
    if (outcome === TickOutcome.BLOCKED) {
      if (this.sleepUntilTs !== null) {
        const delay = this.sleepUntilTs - this.clock();
        return Math.min(Math.max(delay, interval), MAX_SLEEP_S);
      }
      if (this.blockedWaitLong) return Math.max(interval, NO_RESET_FALLBACK_S);
      // A block that can clear on any tick keeps the normal cadence, so the at-limit escape is not late.
    } else if (outcome === TickOutcome.NO_ACTION && this.idleHoldSlow) {
      // Claude Code is idle on an expired token: nothing changes until the user comes back.
      return Math.max(interval, NO_RESET_FALLBACK_S);
    }
    // ±10% jitter, so that two machines do not send their requests at the same time.
    return this.respectPollPlan(interval * (0.9 + 0.2 * internals.random()));
  }

  /**
   * Make a normal-cadence sleep shorter if the store plans the next poll of the active account sooner.
   *
   * It never makes the sleep longer, and never shorter than `URGENT_INTERVAL_S` (the 429
   * budget is in the plan). If the store fails, the delay stays as it is.
   */
  async respectPollPlan(delay: number): Promise<number> {
    try {
      const current = this.switcher.currentAccountNumber();
      if (current === null) return delay;
      const entry = own(await this.switcher.usageEntriesByAccount(new Set()), current);
      if (entry === undefined || entry.nextPollAt === null) return delay;
      const dueIn = entry.nextPollAt - this.clock();
      // Clamp the deadline, not the result: a clamp on the result makes a short delay longer.
      return Math.min(delay, Math.max(dueIn, pollPolicy.URGENT_INTERVAL_S));
    } catch {
      return delay;
    }
  }

  /**
   * Tick until `stop()`. A failed tick does not stop the loop. Returns 0.
   * If `signal` aborts (for example on SIGTERM or SIGINT), the loop stops after the current tick.
   */
  async runLoop({ signal }: { signal?: AbortSignal } = {}): Promise<number> {
    const onAbort = () => this.stop();
    if (signal?.aborted) this.stop();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        // Clear at the top, not after the wait: a wake() during the tick then cuts the next wait short.
        this.wakeEvent.clear();
        if (this.stopEvent.isSet()) return 0;
        let outcome: TickOutcome;
        try {
          outcome = await this.tick();
        } catch (e) {
          const text = e instanceof Error ? `${e.name}: ${e.message}` : `Error: ${String(e)}`;
          this.emit(new ErrorEvent({ message: text, transient: true }));
          outcome = TickOutcome.ERROR;
        }
        const delay = await this.nextDelay(outcome);
        if (delay > this.settings.intervalSeconds * 1.5) {
          const until = new Date(internals.now().getTime() + delay * 1000);
          this.emit(new SleepEvent({ seconds: delay, until: isoUtcSeconds(until) }));
        }
        await this.wakeEvent.wait(delay);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * State locks that `perform` of this process holds across an await. A second engine of
 * this process must wait with the event loop free: a synchronous wait blocks the holder.
 */
const stateLocksHeld = new Set<string>();

async function whenStateLockIdle(lockPath: string, timeoutS = 10): Promise<void> {
  const deadline = Date.now() + timeoutS * 1000;
  while (stateLocksHeld.has(lockPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function decisionValues(entries: Readonly<Record<string, UsageEntry>>): Record<string, UsageValue> {
  const out: Record<string, UsageValue> = {};
  for (const [num, entry] of Object.entries(entries)) out[num] = entry.decisionValue();
  return out;
}
