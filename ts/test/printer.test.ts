import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as printer from "../src/printer.js";
import { deterministicColour } from "./helpers/colour.js";

function capsys(): { readouterr: () => { out: string; err: string } } {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  });
  return {
    readouterr: () => {
      const result = { out, err };
      out = "";
      err = "";
      return result;
    },
  };
}

function exportForClass(vars: Record<string, string>): void {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [name, value] of Object.entries(vars)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
  });
  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

describe("TestColorDetection", () => {
  it("test_no_color_env_disables", () => {
    vi.stubEnv("NO_COLOR", "1");
    expect(printer.detectColorSupport()).toBe(false);
  });

  it("test_no_color_empty_value_disables", () => {
    vi.stubEnv("NO_COLOR", "");
    expect(printer.detectColorSupport()).toBe(false);
  });

  it("test_force_color_enables", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    expect(printer.detectColorSupport()).toBe(true);
  });

  it("test_non_tty_disables", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", undefined);
    vi.spyOn(printer.internals, "stdoutIsatty").mockReturnValue(false);
    expect(printer.detectColorSupport()).toBe(false);
  });

  it("test_dumb_term_disables", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", undefined);
    vi.stubEnv("TERM", "dumb");
    vi.spyOn(printer.internals, "stdoutIsatty").mockReturnValue(true);
    if (process.platform !== "win32") {
      expect(printer.detectColorSupport()).toBe(false);
    }
  });

  it("test_colors_enabled_caches", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    expect(printer.colorsEnabled()).toBe(true);
    vi.stubEnv("FORCE_COLOR", undefined);
    expect(printer.colorsEnabled()).toBe(true);
  });
});

describe("TestStyling", () => {
  it("test_style_with_colors_disabled", () => {
    vi.stubEnv("NO_COLOR", "1");
    expect(printer.accent("hello")).toBe("hello");
    expect(printer.muted("hello")).toBe("hello");
    expect(printer.dimmed("hello")).toBe("hello");
    expect(printer.bolded("hello")).toBe("hello");
    expect(printer.boldAccent("hello")).toBe("hello");
  });

  it("test_style_with_colors_enabled", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    const result = printer.accent("hello");
    expect(result).toContain("hello");
    expect(result).toContain("\x1b[38;5;173m");
    expect(result).toContain("\x1b[0m");
  });

  it("test_muted_with_colors_enabled", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    const result = printer.muted("org name");
    expect(result).toContain("\x1b[38;5;250m");
    expect(result).toContain("org name");
  });

  it("test_dimmed_with_colors_enabled", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    const result = printer.dimmed("secondary");
    expect(result).toContain("\x1b[2m");
    expect(result).toContain("secondary");
  });

  it("test_bolded_with_colors_enabled", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    const result = printer.bolded("header");
    expect(result).toContain("\x1b[1m");
    expect(result).toContain("header");
  });

  it("test_bold_accent_with_colors_enabled", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    const result = printer.boldAccent("(active)");
    expect(result).toContain("\x1b[1m");
    expect(result).toContain("\x1b[38;5;173m");
    expect(result).toContain("(active)");
  });
});

describe("TestThemePalette", () => {
  it("test_light_theme_changes_accent", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    printer.internals.colorsEnabled = null;
    printer.setTheme("light");
    expect(printer.accent("x")).toContain("38;2;149;76;42");
    printer.setTheme("dark");
    expect(printer.accent("x")).toContain("38;5;173");
  });

  it("test_light_theme_error_uses_light_red", () => {
    const cap = capsys();
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    printer.internals.colorsEnabled = null;
    printer.setTheme("light");
    printer.error("boom");
    expect(cap.readouterr().err).toContain("38;2;173;49;40");
  });

  it("test_unknown_theme_falls_back_to_dark", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    printer.internals.colorsEnabled = null;
    printer.setTheme("bogus");
    expect(printer.accent("x")).toContain("38;5;173");
  });
});

describe("TestLinePrinters", () => {
  it("test_error_prints_to_stderr", () => {
    const cap = capsys();
    vi.stubEnv("NO_COLOR", "1");
    printer.error("something failed");
    const captured = cap.readouterr();
    expect(captured.out).toBe("");
    expect(captured.err).toContain("something failed");
  });

  it("test_error_with_color", () => {
    const cap = capsys();
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    printer.error("something failed");
    expect(cap.readouterr().err).toContain("\x1b[31m");
  });

  it("test_warning_prints_to_stdout", () => {
    const cap = capsys();
    vi.stubEnv("NO_COLOR", "1");
    printer.warning("be careful");
    expect(cap.readouterr().out).toContain("be careful");
  });

  it("test_warning_with_color", () => {
    const cap = capsys();
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    printer.warning("be careful");
    expect(cap.readouterr().out).toContain("\x1b[33m");
  });
});

it("test_force_color_overrides_and_restores", () => {
  const saved = printer.internals.colorsEnabled;
  try {
    printer.internals.colorsEnabled = false;
    printer.forceColor(() => {
      expect(printer.colorsEnabled()).toBe(true);
      expect(printer.accent("X")).toBe("\x1b[38;5;173mX\x1b[0m");
    });
    expect(printer.internals.colorsEnabled).toBe(false);
  } finally {
    printer.internals.colorsEnabled = saved;
  }
});

describe("TestForceUtf8Output", () => {
  it.skip("test_reconfigures_legacy_stream_to_utf8", () => {
    // Python only: a cp1252 TextIOWrapper has no Node equivalent. Node streams always encode strings as UTF-8.
  });

  it("test_no_op_on_streams_without_reconfigure", () => {
    expect(() => printer.forceUtf8Output()).not.toThrow();
  });
});

describe("TestColourEnvDoesNotLeakIntoTests", () => {
  // The variables must exist before the global beforeEach hook runs. Only a describe-level beforeAll hook gives that order.
  exportForClass({ FORCE_COLOR: "3", NO_COLOR: "1" });

  it("test_styled_output_is_plain", () => {
    vi.spyOn(printer.internals, "stdoutIsatty").mockReturnValue(false);
    expect(printer.accent("Skipping")).toBe("Skipping");
    expect(printer.muted("usage")).not.toContain("\x1b[");
  });

  it("test_detection_reaches_isatty_rather_than_an_override", () => {
    vi.stubEnv("TERM", "xterm-256color");
    vi.spyOn(printer.internals, "stdoutIsatty").mockReturnValue(true);
    expect(printer.colorsEnabled()).toBe(true);
  });
});

describe("TestEntryAssertionsCatchAPoisonedGlobal", () => {
  it("test_kills_colors_enabled_assertion", () => {
    printer.internals.colorsEnabled = true;
    expect(() => deterministicColour()).toThrow(/latched the colour cache/);
  });

  it("test_kills_theme_assertion", () => {
    printer.internals.theme = "light";
    expect(() => deterministicColour()).toThrow(/latched the theme/);
  });
});
