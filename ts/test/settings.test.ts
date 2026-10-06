import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../src/exceptions.js";
import {
  atomicWriteJson,
  autoSwitchSettings,
  type CliOverrides,
  effectiveSettings,
  internals,
  loadSettings,
  loadUiSettings,
  mergedWithCli,
  saveSettings,
  SETTING_SPECS,
  setSetting,
  settingsPath,
  uiSettings,
  unsetSetting,
} from "../src/settings.js";
import { testHome } from "./helpers/home.js";

const posixOnly = process.platform === "win32" ? it.skip : it;

let tmpPath: string;

beforeEach(() => {
  tmpPath = fs.realpathSync(fs.mkdtempSync(path.join(testHome(), "tmp-")));
});

function args(overrides: CliOverrides = {}): CliOverrides {
  return {
    threshold: null,
    interval: null,
    cooldown: null,
    includeApiKeyAccounts: null,
    strategy: null,
    ...overrides,
  };
}

function writeSettings(text: string): void {
  fs.writeFileSync(settingsPath(tmpPath), text);
}

function readSettings(): Record<string, any> {
  return JSON.parse(fs.readFileSync(settingsPath(tmpPath), "utf8"));
}

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

describe("TestLoadSettings", () => {
  it("test_missing_file_gives_defaults", () => {
    expect(loadSettings(tmpPath)).toEqual(autoSwitchSettings());
  });

  it("test_corrupt_file_gives_defaults", () => {
    writeSettings("{not json");
    expect(loadSettings(tmpPath)).toEqual(autoSwitchSettings());
  });

  it("test_non_object_gives_defaults", () => {
    writeSettings("[1, 2]");
    expect(loadSettings(tmpPath)).toEqual(autoSwitchSettings());
  });

  it("test_partial_section_fills_defaults", () => {
    writeSettings(JSON.stringify({ schemaVersion: 1, autoswitch: { threshold: 80 } }));
    const loaded = loadSettings(tmpPath);
    expect(loaded.threshold).toBe(80.0);
    expect(loaded.intervalSeconds).toBe(autoSwitchSettings().intervalSeconds);
  });

  it("test_values_are_clamped", () => {
    writeSettings(
      JSON.stringify({
        autoswitch: { threshold: 200, intervalSeconds: 1, hysteresisPct: -5, unhealthyTicks: 0 },
      }),
    );
    const loaded = loadSettings(tmpPath);
    expect(loaded.threshold).toBe(99.9);
    expect(loaded.intervalSeconds).toBe(15.0);
    expect(loaded.hysteresisPct).toBe(0.0);
    expect(loaded.unhealthyTicks).toBe(1);
  });

  it("test_bad_types_fall_back_to_defaults", () => {
    writeSettings(JSON.stringify({ autoswitch: { threshold: "high", includeApiKeyAccounts: 1 } }));
    const loaded = loadSettings(tmpPath);
    expect(loaded.threshold).toBe(autoSwitchSettings().threshold);
    expect(loaded.includeApiKeyAccounts).toBe(true);
  });

  it("test_unsupported_strategy_falls_back_to_best", () => {
    writeSettings(JSON.stringify({ autoswitch: { strategy: "chaos" } }));
    expect(loadSettings(tmpPath).strategy).toBe("best");
  });

  it("test_consume_first_is_a_valid_strategy", () => {
    writeSettings(JSON.stringify({ autoswitch: { strategy: "consume-first" } }));
    expect(loadSettings(tmpPath).strategy).toBe("consume-first");
  });

  it("test_set_strategy_consume_first", () => {
    setSetting(tmpPath, "autoswitch.strategy", "consume-first");
    expect(loadSettings(tmpPath).strategy).toBe("consume-first");
  });
});

describe("TestSaveSettings", () => {
  it("test_roundtrip", () => {
    const custom = autoSwitchSettings({ threshold: 85.0, cooldownSeconds: 60.0 });
    saveSettings(tmpPath, custom);
    expect(loadSettings(tmpPath)).toEqual(custom);
  });

  it("test_unknown_keys_survive", () => {
    writeSettings(
      JSON.stringify({
        schemaVersion: 1,
        futureSection: { x: 1 },
        autoswitch: { threshold: 80, futureKnob: true },
      }),
    );
    saveSettings(tmpPath, autoSwitchSettings({ threshold: 70.0 }));
    const raw = readSettings();
    expect(raw.futureSection).toEqual({ x: 1 });
    expect(raw.autoswitch.futureKnob).toBe(true);
    expect(raw.autoswitch.threshold).toBe(70.0);
  });

  posixOnly("test_file_mode_is_0600", () => {
    saveSettings(tmpPath, autoSwitchSettings());
    expect(mode(settingsPath(tmpPath))).toBe(0o600);
  });
});

describe("TestUiSettings", () => {
  it("test_missing_file_defaults_to_auto", () => {
    expect(loadUiSettings(tmpPath)).toEqual(uiSettings({ theme: "auto" }));
  });

  it("test_reads_auto", () => {
    writeSettings(JSON.stringify({ ui: { theme: "auto" } }));
    expect(loadUiSettings(tmpPath).theme).toBe("auto");
  });

  it("test_reads_light", () => {
    writeSettings(JSON.stringify({ ui: { theme: "light" } }));
    expect(loadUiSettings(tmpPath).theme).toBe("light");
  });

  it("test_unknown_theme_clamps_to_default", () => {
    writeSettings(JSON.stringify({ ui: { theme: "purple" } }));
    expect(loadUiSettings(tmpPath).theme).toBe("auto");
  });

  it("test_set_and_unset_ui_theme", () => {
    expect(setSetting(tmpPath, "ui.theme", "light")).toBe("light");
    expect(readSettings()).toEqual({ schemaVersion: 1, ui: { theme: "light" } });
    expect(unsetSetting(tmpPath, "ui.theme")).toBe(true);
    expect(readSettings()).not.toHaveProperty("ui");
  });

  it("test_set_rejects_bad_choice", () => {
    expect(() => setSetting(tmpPath, "ui.theme", "purple")).toThrow(ConfigError);
    expect(() => setSetting(tmpPath, "ui.theme", "purple")).toThrow(/dark, light/);
  });
});

describe("TestSettingSpecs", () => {
  it("test_registry_covers_every_dataclass_field", () => {
    const bySection: Record<string, Set<string>> = {};
    for (const spec of Object.values(SETTING_SPECS)) {
      (bySection[spec.section] ??= new Set()).add(spec.field);
    }
    expect(bySection.autoswitch).toEqual(new Set(Object.keys(autoSwitchSettings())));
    expect(bySection.ui).toEqual(new Set(Object.keys(uiSettings())));
  });

  it("test_defaults_match_dataclass", () => {
    const sources: Record<string, Record<string, unknown>> = {
      autoswitch: { ...autoSwitchSettings() },
      ui: { ...uiSettings() },
    };
    for (const spec of Object.values(SETTING_SPECS)) {
      expect(spec.default).toEqual(sources[spec.section]![spec.field]);
    }
  });
});

describe("TestSetUnsetSetting", () => {
  it("test_set_writes_minimal_file", () => {
    const value = setSetting(tmpPath, "autoswitch.threshold", "80");
    expect(value).toBe(80.0);
    expect(readSettings()).toEqual({ schemaVersion: 1, autoswitch: { threshold: 80.0 } });
  });

  it("test_set_int_kind_coerces_and_rejects_floats", () => {
    expect(setSetting(tmpPath, "autoswitch.unhealthyTicks", "5")).toBe(5);
    expect(() => setSetting(tmpPath, "autoswitch.unhealthyTicks", "3.5")).toThrow(/integer/);
  });

  it("test_set_rejects_out_of_range_without_writing", () => {
    expect(() => setSetting(tmpPath, "autoswitch.threshold", "200")).toThrow(/between 50 and 99\.9/);
    expect(fs.existsSync(settingsPath(tmpPath))).toBe(false);
  });

  it("test_set_rejects_unknown_key", () => {
    expect(() => setSetting(tmpPath, "autoswitch.bogus", "1")).toThrow(ConfigError);
    expect(() => setSetting(tmpPath, "autoswitch.bogus", "1")).toThrow(/unknown setting/);
  });

  it("test_set_string_kind_round_trips", () => {
    expect(setSetting(tmpPath, "autoswitch.model", "Fable")).toBe("Fable");
    expect(readSettings().autoswitch.model).toBe("Fable");
    expect(loadSettings(tmpPath).model).toBe("Fable");
  });

  it("test_set_string_kind_rejects_empty", () => {
    expect(() => setSetting(tmpPath, "autoswitch.model", "   ")).toThrow(/unset/);
    expect(fs.existsSync(settingsPath(tmpPath))).toBe(false);
  });

  it("test_garbage_model_value_falls_back_to_none", () => {
    writeSettings(JSON.stringify({ autoswitch: { model: 123 } }));
    expect(loadSettings(tmpPath).model).toBeNull();
  });

  it("test_set_rejects_bool_words_strictly", () => {
    expect(setSetting(tmpPath, "autoswitch.includeApiKeyAccounts", "FALSE")).toBe(false);
    expect(() => setSetting(tmpPath, "autoswitch.includeApiKeyAccounts", "falsy")).toThrow(/true or false/);
  });

  it("test_set_on_corrupt_file_raises_and_preserves_it", () => {
    writeSettings("{not json");
    expect(() => setSetting(tmpPath, "autoswitch.threshold", "80")).toThrow(/not valid JSON/);
    expect(fs.readFileSync(settingsPath(tmpPath), "utf8")).toBe("{not json");
  });

  it("test_unset_removes_key_and_empty_section", () => {
    setSetting(tmpPath, "autoswitch.threshold", "80");
    expect(unsetSetting(tmpPath, "autoswitch.threshold")).toBe(true);
    expect(readSettings()).not.toHaveProperty("autoswitch");
  });

  it("test_unset_stamps_schema_version_on_unversioned_file", () => {
    writeSettings(JSON.stringify({ autoswitch: { threshold: 80 } }));
    expect(unsetSetting(tmpPath, "autoswitch.threshold")).toBe(true);
    expect(readSettings().schemaVersion).toBe(1);
  });

  it("test_unset_absent_key_is_noop", () => {
    expect(unsetSetting(tmpPath, "autoswitch.threshold")).toBe(false);
    expect(fs.existsSync(settingsPath(tmpPath))).toBe(false);
  });
});

describe("TestEffectiveSettings", () => {
  it("test_missing_file_reports_all_defaults", () => {
    const rows = effectiveSettings(tmpPath);
    expect(rows.length).toBe(Object.keys(SETTING_SPECS).length);
    expect(rows.every(([, , isSet]) => !isSet)).toBe(true);
  });

  it("test_presence_not_value_equality_marks_set", () => {
    setSetting(tmpPath, "autoswitch.threshold", "90");
    const byKey = Object.fromEntries(effectiveSettings(tmpPath).map(([spec, , isSet]) => [spec.dotted, isSet]));
    expect(byKey["autoswitch.threshold"]).toBe(true);
    expect(byKey["autoswitch.intervalSeconds"]).toBe(false);
  });
});

describe("TestMergedWithCli", () => {
  it("test_no_flags_returns_settings_unchanged", () => {
    const base = autoSwitchSettings({ threshold: 80.0 });
    expect(mergedWithCli(base, args())).toBe(base);
  });

  it("test_cli_beats_settings", () => {
    const base = autoSwitchSettings({ threshold: 80.0, cooldownSeconds: 10.0 });
    const merged = mergedWithCli(base, args({ threshold: 60.0, interval: 30.0 }));
    expect(merged.threshold).toBe(60.0);
    expect(merged.intervalSeconds).toBe(30.0);
    expect(merged.cooldownSeconds).toBe(10.0);
  });

  it("test_cli_values_are_clamped", () => {
    const merged = mergedWithCli(autoSwitchSettings(), args({ interval: 1.0 }));
    expect(merged.intervalSeconds).toBe(15.0);
  });

  it("test_boolean_override", () => {
    const merged = mergedWithCli(autoSwitchSettings(), args({ includeApiKeyAccounts: true }));
    expect(merged.includeApiKeyAccounts).toBe(true);
  });

  it("test_model_override", () => {
    const merged = mergedWithCli(autoSwitchSettings(), args({ model: "Fable" }));
    expect(merged.model).toBe("Fable");
  });

  it("test_strategy_override", () => {
    const merged = mergedWithCli(autoSwitchSettings(), args({ strategy: "consume-first" }));
    expect(merged.strategy).toBe("consume-first");
  });
});

describe("TestAtomicWriteThroughSymlink", () => {
  it("test_write_preserves_the_link_and_updates_the_target", () => {
    const repo = path.join(tmpPath, "repo");
    fs.mkdirSync(repo);
    const live = path.join(tmpPath, "live");
    fs.mkdirSync(live);
    const tracked = path.join(repo, "settings.json");
    fs.writeFileSync(tracked, JSON.stringify({ tracked: true }));
    const link = path.join(live, "settings.json");
    fs.symlinkSync(tracked, link);

    atomicWriteJson(link, { written: "through" });

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(tracked, "utf8"))).toEqual({ written: "through" });
  });

  it("test_dangling_link_writes_where_it_points", () => {
    const target = path.join(tmpPath, "gone", "settings.json");
    const link = path.join(tmpPath, "settings.json");
    fs.symlinkSync(target, link);

    atomicWriteJson(link, { dangling: "ok" });

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ dangling: "ok" });
  });

  it("test_plain_file_write_unchanged", () => {
    const p = path.join(tmpPath, "settings.json");
    atomicWriteJson(p, { plain: 1 });
    expect(fs.lstatSync(p).isSymbolicLink()).toBe(false);
    expect(JSON.parse(fs.readFileSync(p, "utf8"))).toEqual({ plain: 1 });
  });

  it("test_temp_file_is_created_beside_the_target", () => {
    const repo = path.join(tmpPath, "repo");
    fs.mkdirSync(repo);
    const live = path.join(tmpPath, "live");
    fs.mkdirSync(live);
    const tracked = path.join(repo, "settings.json");
    fs.writeFileSync(tracked, "{}");
    const link = path.join(live, "settings.json");
    fs.symlinkSync(tracked, link);
    const spy = vi.spyOn(internals, "mkstemp");

    atomicWriteJson(link, { x: 1 });

    expect(spy.mock.calls.map((call) => call[0])).toEqual([repo]);
  });

  posixOnly("test_hardening_stays_on_the_directory_cswap_owns", () => {
    const repo = path.join(tmpPath, "repo");
    fs.mkdirSync(repo);
    fs.chmodSync(repo, 0o755);
    const live = path.join(tmpPath, "live");
    fs.mkdirSync(live);
    const tracked = path.join(repo, "settings.json");
    fs.writeFileSync(tracked, "{}");
    const link = path.join(live, "settings.json");
    fs.symlinkSync(tracked, link);

    atomicWriteJson(link, { x: 1 });

    expect(mode(repo)).toBe(0o755);
    expect(mode(live)).toBe(0o700);
    expect(mode(tracked)).toBe(0o600);
  });
});
