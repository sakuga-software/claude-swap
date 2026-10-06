import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cli from "../src/cli.js";
import { TickOutcome } from "../src/autoswitch.js";
import type { AutoSwitchSettings } from "../src/settings.js";
import { captureOutput } from "./helpers/capture.js";

const { internals, SystemExit } = cli;

const saved = { ...internals };

beforeEach(() => {
  internals.progName = () => "cswap";
  internals.useNativeTls = () => {};
  internals.geteuid = () => 1000;
  internals.checkForUpdate = async () => null;
});

afterEach(() => {
  Object.assign(internals, saved);
});

/**
 * Run `cswap config <argv>`. Returns `[exitCode, stdout, stderr]`.
 * A success returns from `main()`; an error throws `SystemExit`.
 */
async function run(argv: string[]): Promise<[number, string, string]> {
  const capsys = captureOutput();
  let code = 0;
  try {
    await cli.main(["config", ...argv]);
  } catch (e) {
    if (!(e instanceof SystemExit)) throw e;
    code = e.code;
  }
  const { out, err } = capsys.readouterr();
  vi.mocked(process.stdout.write).mockRestore();
  vi.mocked(process.stderr.write).mockRestore();
  return [code, out, err];
}

async function settingsFile(): Promise<string> {
  const [code, out] = await run(["path"]);
  expect(code).toBe(0);
  return out.trim();
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("TestConfigList", () => {
  it("test_lists_all_keys_as_defaults", async () => {
    const [code, out] = await run([]);
    expect(code).toBe(0);
    for (const key of [
      "autoswitch.threshold",
      "autoswitch.intervalSeconds",
      "autoswitch.cooldownSeconds",
      "autoswitch.hysteresisPct",
      "autoswitch.strategy",
      "autoswitch.includeApiKeyAccounts",
      "autoswitch.unhealthyTicks",
      "autoswitch.model",
      "ui.theme",
    ]) {
      expect(out).toContain(key);
    }
    expect(out.split("(default)").length - 1).toBe(9);
  });

  it("test_set_key_not_marked_default", async () => {
    await run(["set", "autoswitch.cooldownSeconds", "600"]);
    const [code, out] = await run([]);
    expect(code).toBe(0);
    const cooldownLine = out.split("\n").find((ln) => ln.includes("cooldownSeconds"))!;
    expect(cooldownLine).toContain("600");
    expect(cooldownLine).not.toContain("(default)");
  });

  it("test_set_equal_to_default_still_counts_as_set", async () => {
    await run(["set", "autoswitch.threshold", "90"]);
    const [, out] = await run([]);
    const thresholdLine = out.split("\n").find((ln) => ln.includes("threshold"))!;
    expect(thresholdLine).not.toContain("(default)");
  });

  it("test_json_list", async () => {
    const [code, out] = await run(["--json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.path.endsWith("settings.json")).toBe(true);
    const byKey = Object.fromEntries(payload.settings.map((entry: { key: string }) => [entry.key, entry]));
    expect(Object.keys(byKey)).toHaveLength(9);
    expect(byKey["autoswitch.threshold"].value).toBe(90.0);
    expect(byKey["autoswitch.threshold"].isSet).toBe(false);
    expect(byKey["autoswitch.includeApiKeyAccounts"].value).toBe(false);
  });
});

describe("TestConfigSetGet", () => {
  it("test_set_then_get", async () => {
    let [code, out] = await run(["set", "autoswitch.threshold", "80"]);
    expect(code).toBe(0);
    expect(out).toContain("autoswitch.threshold = 80");
    [code, out] = await run(["get", "autoswitch.threshold"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("80");
  });

  it("test_set_writes_only_that_key", async () => {
    await run(["set", "autoswitch.threshold", "80"]);
    const raw = readJson(await settingsFile());
    expect(new Set(Object.keys(raw))).toEqual(new Set(["schemaVersion", "autoswitch"]));
    expect(Object.keys(raw.autoswitch)).toEqual(["threshold"]);
    expect(raw.autoswitch.threshold).toBe(80.0);
  });

  it("test_set_bool_words", async () => {
    const [code, out] = await run(["set", "autoswitch.includeApiKeyAccounts", "no"]);
    expect(code).toBe(0);
    expect(out).toContain("= false");
    expect(readJson(await settingsFile()).autoswitch.includeApiKeyAccounts).toBe(false);
  });

  it("test_set_preserves_unknown_keys", async () => {
    const file = await settingsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, futureSection: { x: 1 }, autoswitch: { threshold: 80, futureKnob: true } }),
    );
    const [code] = await run(["set", "autoswitch.threshold", "70"]);
    expect(code).toBe(0);
    const raw = readJson(file);
    expect(raw.futureSection).toEqual({ x: 1 });
    expect(raw.autoswitch.futureKnob).toBe(true);
    expect(raw.autoswitch.threshold).toBe(70.0);
  });

  it("test_get_json_trailing_and_leading_flag", async () => {
    await run(["set", "autoswitch.threshold", "80"]);
    for (const argv of [
      ["get", "autoswitch.threshold", "--json"],
      ["--json", "get", "autoswitch.threshold"],
    ]) {
      const [code, out] = await run(argv);
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual({ schemaVersion: 1, key: "autoswitch.threshold", value: 80.0, isSet: true });
    }
  });
});

describe("TestConfigValidation", () => {
  it("test_out_of_range_exits_1", async () => {
    const [code, , err] = await run(["set", "autoswitch.threshold", "30"]);
    expect(code).toBe(1);
    expect(err).toContain("between 50 and 99.9");
  });

  it("test_unknown_key_exits_1_and_lists_valid_keys", async () => {
    const [code, , err] = await run(["set", "autoswitch.bogus", "1"]);
    expect(code).toBe(1);
    expect(err).toContain("unknown setting");
    expect(err).toContain("autoswitch.threshold");
  });

  it("test_bad_bool_exits_1", async () => {
    const [code, , err] = await run(["set", "autoswitch.includeApiKeyAccounts", "falsy"]);
    expect(code).toBe(1);
    expect(err).toContain("true or false");
  });

  it("test_bad_number_exits_1", async () => {
    const [code, , err] = await run(["set", "autoswitch.threshold", "high"]);
    expect(code).toBe(1);
    expect(err).toContain("expects a number");
  });

  it("test_int_key_rejects_float", async () => {
    const [code, , err] = await run(["set", "autoswitch.unhealthyTicks", "3.5"]);
    expect(code).toBe(1);
    expect(err).toContain("expects an integer");
  });

  it("test_bad_strategy_exits_1", async () => {
    const [code, , err] = await run(["set", "autoswitch.strategy", "chaos"]);
    expect(code).toBe(1);
    expect(err).toContain("must be one of: best");
  });

  it("test_unknown_key_json_error_envelope", async () => {
    const [code, out] = await run(["--json", "get", "autoswitch.bogus"]);
    expect(code).toBe(1);
    const payload = JSON.parse(out);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.error.message).toContain("unknown setting");
  });

  it("test_corrupt_file_set_exits_1_and_leaves_file_untouched", async () => {
    const file = await settingsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    const [code, , err] = await run(["set", "autoswitch.threshold", "80"]);
    expect(code).toBe(1);
    expect(err).toContain("not valid JSON");
    expect(fs.readFileSync(file, "utf8")).toBe("{not json");
  });

  it("test_missing_value_usage_error_exits_2", async () => {
    const [code] = await run(["set", "autoswitch.threshold"]);
    expect(code).toBe(2);
  });

  it("test_unknown_action_exits_2", async () => {
    const [code] = await run(["frobnicate"]);
    expect(code).toBe(2);
  });

  it("test_json_with_set_rejected", async () => {
    const [code] = await run(["--json", "set", "autoswitch.threshold", "80"]);
    expect(code).toBe(2);
  });
});

describe("TestConfigUnset", () => {
  it("test_unset_restores_default", async () => {
    await run(["set", "autoswitch.threshold", "80"]);
    let [code, out] = await run(["unset", "autoswitch.threshold"]);
    expect(code).toBe(0);
    expect(out).toContain("default: 90");
    [code, out] = await run(["get", "autoswitch.threshold"]);
    expect(out.trim()).toBe("90");
    // The empty autoswitch section goes away.
    expect(readJson(await settingsFile())).not.toHaveProperty("autoswitch");
  });

  it("test_unset_when_not_set_is_a_noop", async () => {
    const [code, , err] = await run(["unset", "autoswitch.threshold"]);
    expect(code).toBe(0);
    expect(err).toContain("not set");
  });
});

describe("TestConfigMisc", () => {
  it("test_path_prints_settings_location", async () => {
    const [code, out] = await run(["path"]);
    expect(code).toBe(0);
    expect(out.trim().endsWith("settings.json")).toBe(true);
  });

  it("test_config_help", async () => {
    const [code, out] = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("autoswitch.threshold");
    expect(out).toContain("unset");
  });

  it("test_main_help_mentions_config", async () => {
    const capsys = captureOutput();
    let code: number | null = null;
    try {
      await cli.main(["--help"]);
    } catch (e) {
      if (!(e instanceof SystemExit)) throw e;
      code = e.code;
    }
    expect(code).toBe(0);
    expect(capsys.readouterr().out).toContain("config");
  });

  it("test_auto_picks_up_configured_threshold", async () => {
    await run(["set", "autoswitch.threshold", "77"]);
    const captured: { settings?: AutoSwitchSettings } = {};
    class FakeEngine {
      constructor(_switcher: unknown, settings: AutoSwitchSettings) {
        captured.settings = settings;
      }

      async tick(): Promise<number> {
        return TickOutcome.NO_ACTION;
      }
    }
    internals.AutoSwitchEngine = FakeEngine as unknown as typeof internals.AutoSwitchEngine;
    await expect(cli.main(["auto", "--once"])).rejects.toThrow(SystemExit);
    expect(captured.settings!.threshold).toBe(77.0);
  });
});
