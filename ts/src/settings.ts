/**
 * Tool settings in `<backup_root>/settings.json`.
 *
 * One versioned JSON file for the user preferences, with the 0600/0700 modes of the backup directory.
 * Version 1 has the `autoswitch` and `ui` sections. Unknown keys stay in the file after a write.
 * A missing or corrupt file gives the defaults and a warning in the log, never a crash.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./exceptions.js";
import { replaceWithRetry } from "./fsutil.js";
import { getLogger } from "./logging_config.js";
import { jsonDumps } from "./support/py.js";

export const SETTINGS_SCHEMA_VERSION = 1;
export const SETTINGS_FILENAME = "settings.json";

const logger = getLogger("claude-swap");

/**
 * Policy values for the auto-switch engine (`cswap auto`).
 *
 * At or above `threshold` (the max of the 5h/7d percentages), the engine looks for a better account.
 * A candidate must be below the threshold and better than the active account by at least `hysteresisPct`.
 */
export interface AutoSwitchSettings {
  readonly threshold: number;
  readonly intervalSeconds: number;
  readonly cooldownSeconds: number;
  readonly hysteresisPct: number;
  /** `best` (most headroom) or `consume-first` (soonest weekly reset). */
  readonly strategy: string;
  readonly includeApiKeyAccounts: boolean;
  readonly unhealthyTicks: number;
  /**
   * Model display names separated by commas (for example "Fable,Opus"), or `all`.
   * The weekly limit of each named model is also a binding window. Null means only the 5h/7d windows.
   */
  readonly model: string | null;
}

/** An `AutoSwitchSettings` with the defaults for the fields that `init` does not give. */
export function autoSwitchSettings(init: Partial<AutoSwitchSettings> = {}): AutoSwitchSettings {
  return Object.freeze({
    threshold: 90.0,
    intervalSeconds: 60.0,
    cooldownSeconds: 300.0,
    hysteresisPct: 10.0,
    strategy: "best",
    includeApiKeyAccounts: false,
    unhealthyTicks: 3,
    model: null,
    ...init,
  });
}

/** Appearance preferences (`ui` section). `auto` follows the detected terminal background. */
export interface UiSettings {
  readonly theme: string;
}

export function uiSettings(init: Partial<UiSettings> = {}): UiSettings {
  return Object.freeze({ theme: "auto", ...init });
}

const SECTION_DEFAULT_SOURCES: Record<string, () => object> = {
  autoswitch: () => autoSwitchSettings(),
  ui: () => uiSettings(),
};

export type SettingKind = "float" | "int" | "bool" | "choice" | "string";

/**
 * Metadata for one settings.json key. The clamp on load and the strict validation
 * of `cswap config set` both read the bounds and choices from here.
 */
export class SettingSpec {
  constructor(
    /** Top-level JSON section (`autoswitch`, `ui`). */
    readonly section: string,
    /** camelCase key inside the section. */
    readonly jsonKey: string,
    /** Field name in the settings object of the section. */
    readonly field: string,
    readonly kind: SettingKind,
    readonly lo: number | null = null,
    readonly hi: number | null = null,
    readonly choices: readonly string[] = [],
    readonly help: string = "",
  ) {}

  get dotted(): string {
    return `${this.section}.${this.jsonKey}`;
  }

  get default(): unknown {
    return (SECTION_DEFAULT_SOURCES[this.section]!() as Record<string, unknown>)[this.field];
  }
}

function spec(
  section: string,
  jsonKey: string,
  field: string,
  kind: SettingKind,
  { lo = null, hi = null, choices = [], help = "" }: { lo?: number | null; hi?: number | null; choices?: string[]; help?: string },
): SettingSpec {
  return new SettingSpec(section, jsonKey, field, kind, lo, hi, choices, help);
}

/** The settings registry, by dotted key, in display order. */
export const SETTING_SPECS: Readonly<Record<string, SettingSpec>> = Object.freeze(
  Object.fromEntries(
    [
      spec("autoswitch", "threshold", "threshold", "float", {
        lo: 50.0,
        hi: 99.9,
        help: "Switch when the binding 5h/7d window reaches this pct",
      }),
      spec("autoswitch", "intervalSeconds", "intervalSeconds", "float", {
        lo: 15.0,
        hi: 3600.0,
        help: "Poll interval for the cswap auto loop, in seconds",
      }),
      spec("autoswitch", "cooldownSeconds", "cooldownSeconds", "float", {
        lo: 0.0,
        hi: 86400.0,
        help: "Minimum seconds between proactive switches",
      }),
      spec("autoswitch", "hysteresisPct", "hysteresisPct", "float", {
        lo: 0.0,
        hi: 50.0,
        help: "A target must beat the active account by this many pct",
      }),
      spec("autoswitch", "strategy", "strategy", "choice", {
        choices: ["best", "consume-first"],
        help: "How auto-switch picks the target account",
      }),
      spec("autoswitch", "includeApiKeyAccounts", "includeApiKeyAccounts", "bool", {
        help: "Allow rotating onto managed API-key accounts (bill per token)",
      }),
      spec("autoswitch", "unhealthyTicks", "unhealthyTicks", "int", {
        lo: 1,
        hi: 100,
        help: "Consecutive failed polls before an account is unhealthy",
      }),
      spec("autoswitch", "model", "model", "string", {
        help: "Also switch on these models' weekly limits (e.g. Fable, Fable,Opus, or all)",
      }),
      spec("ui", "theme", "theme", "choice", {
        choices: ["dark", "light", "auto"],
        help: "Color theme; auto follows the terminal background",
      }),
    ].map((s) => [s.dotted, s] as const),
  ),
);

const AUTOSWITCH_KEYS: ReadonlyArray<readonly [field: string, jsonKey: string]> = Object.values(SETTING_SPECS)
  .filter((s) => s.section === "autoswitch")
  .map((s) => [s.field, s.jsonKey] as const);

type JsonObject = Record<string, unknown>;

export function settingsPath(backupRoot: string): string {
  return path.join(backupRoot, SETTINGS_FILENAME);
}

/**
 * Split a list of model names separated by commas. The names are trimmed, and a
 * case-insensitive duplicate is removed (the first spelling stays).
 */
export function parseModelNames(value: string | null | undefined): string[] {
  if (!value) return [];
  const seen = new Map<string, string>();
  for (const part of value.split(",")) {
    const name = part.trim();
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()];
}

/** Python truthiness, for `bool(value)` on a value from JSON. */
function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Clamp the values into the `SETTING_SPECS` ranges. A value of a bad type becomes the default. */
function clamped(settings: AutoSwitchSettings): AutoSwitchSettings {
  const num = (value: unknown, fallback: number, lo: number, hi: number): number =>
    typeof value !== "number" ? fallback : Math.min(Math.max(value, lo), hi);

  const source = settings as unknown as JsonObject;
  const init: JsonObject = {};
  for (const s of Object.values(SETTING_SPECS)) {
    if (s.section !== "autoswitch") continue;
    let value = source[s.field];
    if (s.kind === "float" || s.kind === "int") {
      const c = num(value, s.default as number, s.lo!, s.hi!);
      init[s.field] = s.kind === "int" ? Math.trunc(c) : c;
    } else if (s.kind === "bool") {
      init[s.field] = pyTruthy(value);
    } else if (s.kind === "string") {
      // A null or bad value gives the default (null), which turns off the model filter.
      init[s.field] = typeof value === "string" && value ? value : s.default;
    } else {
      if (!s.choices.includes(value as string)) {
        logger.warning("settings.json: unsupported %s %r; using %r", s.dotted, value, s.default);
        value = s.default;
      }
      init[s.field] = value;
    }
  }
  return autoSwitchSettings(init as Partial<AutoSwitchSettings>);
}

function isNoEntry(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function readRaw(file: string): JsonObject {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (isNoEntry(e)) return {};
    logger.warning("Could not read %s (%s); using defaults", file, e);
    return {};
  }
  if (!isObject(raw)) {
    logger.warning("%s is not a JSON object; using defaults", file);
    return {};
  }
  return raw;
}

/** Load the autoswitch section. A missing or corrupt file or field gives the default. */
export function loadSettings(backupRoot: string): AutoSwitchSettings {
  const raw = readRaw(settingsPath(backupRoot));
  const section = raw.autoswitch;
  if (!isObject(section)) return autoSwitchSettings();
  const init: JsonObject = {};
  for (const [field, jsonKey] of AUTOSWITCH_KEYS) {
    if (jsonKey in section) init[field] = section[jsonKey];
  }
  return clamped(autoSwitchSettings(init as Partial<AutoSwitchSettings>));
}

/** Load the ui section. A missing or corrupt file or an unknown theme gives the default. */
export function loadUiSettings(backupRoot: string): UiSettings {
  const raw = readRaw(settingsPath(backupRoot));
  const section = raw.ui;
  const fallback = uiSettings();
  if (!isObject(section)) return fallback;
  const theme = "theme" in section ? section.theme : fallback.theme;
  if (!SETTING_SPECS["ui.theme"]!.choices.includes(theme as string)) {
    logger.warning("settings.json: unsupported ui.theme %r; using %r", theme, fallback.theme);
    return fallback;
  }
  return uiSettings({ theme: theme as string });
}

function stampSchemaVersion(raw: JsonObject): void {
  raw.schemaVersion = "schemaVersion" in raw ? raw.schemaVersion : SETTINGS_SCHEMA_VERSION;
}

/** Write the autoswitch section. Unknown keys and sections stay in the file. */
export function saveSettings(backupRoot: string, settings: AutoSwitchSettings): void {
  const file = settingsPath(backupRoot);
  const raw = readRaw(file);
  stampSchemaVersion(raw);
  const section = isObject(raw.autoswitch) ? raw.autoswitch : {};
  for (const [field, jsonKey] of AUTOSWITCH_KEYS) {
    section[jsonKey] = (settings as unknown as JsonObject)[field];
  }
  raw.autoswitch = section;
  atomicWriteJson(file, raw);
}

/** Find a spec by dotted key. An unknown key throws `ConfigError` with the list of valid keys. */
export function settingSpec(dottedKey: string): SettingSpec {
  const found = Object.hasOwn(SETTING_SPECS, dottedKey) ? SETTING_SPECS[dottedKey] : undefined;
  if (found === undefined) {
    throw new ConfigError(`unknown setting '${dottedKey}'\nValid keys: ${Object.keys(SETTING_SPECS).join(", ")}`);
  }
  return found;
}

const BOOL_WORDS: ReadonlyMap<string, boolean> = new Map([
  ["true", true],
  ["1", true],
  ["yes", true],
  ["false", false],
  ["0", false],
  ["no", false],
]);

const PY_INT = /^[+-]?\d(?:_?\d)*$/;
const PY_FLOAT = /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;
const PY_FLOAT_SPECIAL = /^([+-]?)(inf|infinity|nan)$/i;

/** Python `int(text)` and `float(text)` for decimal text. Returns null where Python raises `ValueError`. */
function parsePyNumber(text: string, kind: "int" | "float"): number | null {
  const s = text.trim();
  if (kind === "int") return PY_INT.test(s) ? Number(s.replaceAll("_", "")) : null;
  const special = PY_FLOAT_SPECIAL.exec(s);
  if (special) {
    if (special[2]!.toLowerCase() === "nan") return Number.NaN;
    return special[1] === "-" ? -Infinity : Infinity;
  }
  return PY_FLOAT.test(s) ? Number(s.replaceAll("_", "")) : null;
}

/**
 * Parse a string from the CLI for `cswap config set`, strictly.
 * A value out of range or of a bad type throws `ConfigError`, so that the user sees the problem at once.
 */
export function parseSettingValue(spec: SettingSpec, rawValue: string): string | number | boolean {
  if (spec.kind === "bool") {
    const parsed = BOOL_WORDS.get(rawValue.trim().toLowerCase());
    if (parsed === undefined) {
      throw new ConfigError(`${spec.dotted} expects true or false (or 1/0, yes/no), got '${rawValue}'`);
    }
    return parsed;
  }
  if (spec.kind === "choice") {
    if (!spec.choices.includes(rawValue)) {
      throw new ConfigError(`${spec.dotted} must be one of: ${spec.choices.join(", ")}`);
    }
    return rawValue;
  }
  if (spec.kind === "string") {
    const value = rawValue.trim();
    if (!value) {
      throw new ConfigError(
        `${spec.dotted} expects a non-empty value; use 'cswap config unset ${spec.dotted}' to clear it`,
      );
    }
    return value;
  }
  const value = parsePyNumber(rawValue, spec.kind);
  if (value === null) {
    const noun = spec.kind === "int" ? "an integer" : "a number";
    throw new ConfigError(`${spec.dotted} expects ${noun}, got '${rawValue}'`);
  }
  if (!(spec.lo! <= value && value <= spec.hi!)) {
    throw new ConfigError(
      `${spec.dotted} must be between ${formatSettingValue(spec.lo)} and ${formatSettingValue(spec.hi)}`,
    );
  }
  return value;
}

/** Show a settings value as settings.json writes it. */
export function formatSettingValue(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (value === Infinity) return "inf";
    if (value === -Infinity) return "-inf";
  }
  return String(value);
}

/**
 * Read for the config write path. A corrupt file throws `ConfigError` and never gives `{}`,
 * because a write from `{}` replaces a file that the user can maybe repair.
 */
function readRawForWrite(file: string): JsonObject {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (isNoEntry(e)) return {};
    throw new ConfigError(`could not read ${file}: ${(e as Error).message}`, { cause: e });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(
      `${file} is not valid JSON (${(e as Error).message}); fix or delete it before changing settings`,
      { cause: e },
    );
  }
  if (!isObject(raw)) {
    throw new ConfigError(`${file} is not a JSON object; fix or delete it before changing settings`);
  }
  return raw;
}

/**
 * Validate and write one key for `cswap config set`. Returns the value.
 *
 * Only this key (and `schemaVersion`) goes in the file. `saveSettings` writes all the keys,
 * which keeps today's defaults in the file after a later version changes them.
 */
export function setSetting(backupRoot: string, dottedKey: string, rawValue: string): string | number | boolean {
  const s = settingSpec(dottedKey);
  const value = parseSettingValue(s, rawValue);
  const file = settingsPath(backupRoot);
  const raw = readRawForWrite(file);
  stampSchemaVersion(raw);
  const section = isObject(raw[s.section]) ? (raw[s.section] as JsonObject) : {};
  section[s.jsonKey] = value;
  raw[s.section] = section;
  atomicWriteJson(file, raw);
  return value;
}

/** Remove one key from settings.json. Returns false (and does not write) if the key is not set. */
export function unsetSetting(backupRoot: string, dottedKey: string): boolean {
  const s = settingSpec(dottedKey);
  const file = settingsPath(backupRoot);
  const raw = readRawForWrite(file);
  const section = raw[s.section];
  if (!isObject(section) || !(s.jsonKey in section)) return false;
  stampSchemaVersion(raw);
  delete section[s.jsonKey];
  if (Object.keys(section).length === 0) delete raw[s.section];
  atomicWriteJson(file, raw);
  return true;
}

/**
 * `[spec, effective value, explicitly set]` for each key, in registry order.
 * "Set" means that the key is in the file, also if its value is equal to the default.
 */
export function effectiveSettings(backupRoot: string): Array<[SettingSpec, unknown, boolean]> {
  const raw = readRaw(settingsPath(backupRoot));
  const loaded: Record<string, object> = {
    autoswitch: loadSettings(backupRoot),
    ui: loadUiSettings(backupRoot),
  };
  return Object.values(SETTING_SPECS).map((s) => {
    const section = raw[s.section];
    const isSet = isObject(section) && s.jsonKey in section;
    return [s, (loaded[s.section] as Record<string, unknown>)[s.field], isSet];
  });
}

/** The CLI overrides of `cswap auto`. A null or missing value keeps the setting. */
export interface CliOverrides {
  threshold?: number | null;
  interval?: number | null;
  cooldown?: number | null;
  includeApiKeyAccounts?: boolean | null;
  model?: string | null;
  strategy?: string | null;
}

/** Put the CLI overrides that are not null on top of the settings. Returns `settings` itself if there are none. */
export function mergedWithCli(settings: AutoSwitchSettings, args: CliOverrides): AutoSwitchSettings {
  const overrides: Partial<Record<keyof AutoSwitchSettings, unknown>> = {};
  const pairs: Array<[keyof CliOverrides, keyof AutoSwitchSettings]> = [
    ["threshold", "threshold"],
    ["interval", "intervalSeconds"],
    ["cooldown", "cooldownSeconds"],
    ["includeApiKeyAccounts", "includeApiKeyAccounts"],
    ["model", "model"],
    ["strategy", "strategy"],
  ];
  for (const [attr, field] of pairs) {
    const value = args[attr];
    if (value != null) overrides[field] = value;
  }
  if (Object.keys(overrides).length === 0) return settings;
  return clamped(autoSwitchSettings({ ...settings, ...(overrides as Partial<AutoSwitchSettings>) }));
}

/** Seams that the tests replace. */
export const internals = {
  /** `tempfile.mkstemp(dir=dir, suffix=suffix)`: create a new file with mode 0600 and return `[fd, path]`. */
  mkstemp(dir: string, suffix = ""): [number, string] {
    for (;;) {
      const candidate = path.join(dir, `tmp${randomBytes(6).toString("base64url")}${suffix}`);
      try {
        return [fs.openSync(candidate, "wx", 0o600), candidate];
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
  },
};

/**
 * `os.path.realpath`: resolve all symbolic links. Unlike `fs.realpathSync`,
 * a dangling link resolves to the path that it points to.
 */
function realpathLoose(p: string, depth = 0): string {
  const absolute = path.resolve(p);
  try {
    return fs.realpathSync(absolute);
  } catch (e) {
    if (!isNoEntry(e) || depth > 40) return absolute;
  }
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) {
    return realpathLoose(path.resolve(path.dirname(absolute), fs.readlinkSync(absolute)), depth + 1);
  }
  const parent = path.dirname(absolute);
  if (parent === absolute) return absolute;
  return path.join(realpathLoose(parent, depth + 1), path.basename(absolute));
}

/**
 * Write JSON atomically, with the 0600/0700 modes of the backup directory.
 *
 * WARNING: The write goes THROUGH a symbolic link, never over it. A rename onto
 * the link replaces the link, and its target then stops getting updates.
 * - A dangling link writes where it points.
 * - The temporary file goes beside the resolved target, so the rename stays on one filesystem.
 * - The 0700 mode goes on the directory of `file`, not on the directory of the target,
 *   because that directory can belong to a different owner.
 */
export function atomicWriteJson(file: string, data: JsonObject): void {
  const isLink = fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
  const target = isLink ? realpathLoose(file) : file;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (process.platform !== "win32") fs.chmodSync(path.dirname(file), 0o700);
  const [fd, tmpPath] = internals.mkstemp(path.dirname(target), ".tmp");
  let openFd = fd;
  try {
    fs.writeSync(openFd, Buffer.from(jsonDumps(data, 2), "utf8"));
    fs.closeSync(openFd);
    openFd = -1;
    replaceWithRetry(tmpPath, target);
    if (process.platform !== "win32") fs.chmodSync(target, 0o600);
  } catch (e) {
    if (openFd >= 0) fs.closeSync(openFd);
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // The rename can already have moved the file.
    }
    throw e;
  }
}
