import { expect, it } from "vitest";
import * as theme from "../src/tui/theme.js";
import { CSWAP_DARK, CSWAP_LIGHT, Palette } from "../src/tui/theme.js";

it("test_dark_palette_matches_constants", () => {
  const p = Palette.DARK;
  expect([p.accent, p.foreground, p.muted, p.sevOk, p.sevWarn, p.sevCrit, p.track]).toEqual([
    theme.ACCENT,
    theme.FOREGROUND,
    theme.MUTED,
    theme.SEV_OK,
    theme.SEV_WARN,
    theme.SEV_CRIT,
    theme.TRACK,
  ]);
});

it("test_from_theme_reads_theme_object_including_track", () => {
  const p = Palette.fromTheme(CSWAP_LIGHT);
  expect(p.accent).toBe(theme.ACCENT_LIGHT);
  expect(p.sevCrit).toBe(theme.SEV_CRIT_LIGHT);
  expect(p.track).toBe(theme.TRACK_LIGHT);
});

it("test_severity_ramp_and_none", () => {
  const p = Palette.DARK;
  expect(p.severity(null)).toBe(p.muted);
  expect(p.severity(95.0)).toBe(p.sevCrit);
  expect(p.severity(75.0)).toBe(p.sevWarn);
  expect(p.severity(10.0)).toBe(p.sevOk);
});

it("test_both_themes_expose_track_variable", () => {
  expect(CSWAP_DARK.variables.track).toBe(theme.TRACK);
  expect(CSWAP_LIGHT.variables.track).toBe(theme.TRACK_LIGHT);
  expect(CSWAP_LIGHT.dark).toBe(false);
});

function contrast(hexA: string, hexB: string): number {
  const lum = (h: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
    const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const [la, lb] = [lum(hexA), lum(hexB)].sort((x, y) => x - y) as [number, number];
  return (lb + 0.05) / (la + 0.05);
}

it("test_light_text_meets_AA_on_all_backgrounds", () => {
  // The accent and severity colors are also text on the highlighted (surface) and flash (panel) rows.
  const textColors = [
    theme.FOREGROUND_LIGHT,
    theme.MUTED_LIGHT,
    theme.ACCENT_LIGHT,
    theme.SEV_OK_LIGHT,
    theme.SEV_WARN_LIGHT,
    theme.SEV_CRIT_LIGHT,
  ];
  const backgrounds = [theme.BACKGROUND_LIGHT, theme.SURFACE_LIGHT, theme.PANEL_LIGHT];
  for (const color of textColors) {
    for (const bg of backgrounds) {
      expect(contrast(color, bg), `${color} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});
