import { vi } from "vitest";
import { resetCache as resetAppearanceCache } from "../../src/appearance.js";
import { internals as printer } from "../../src/printer.js";

/**
 * The developer's terminal must not decide the test results. Call this before each test.
 *
 * It throws if a previous test left the color cache or the theme latched.
 * The values are read first, before the reset, so the check sees what the previous test left.
 */
export function deterministicColour(): void {
  const inherited = [printer.colorsEnabled, printer.theme] as const;
  if (inherited[0] !== null) {
    throw new Error("a previous test latched the colour cache and nothing reset it, or a broader-scoped hook latched it during setup");
  }
  if (inherited[1] !== "dark") {
    throw new Error("a previous test latched the theme, or a broader-scoped hook latched it during setup");
  }
  vi.stubEnv("FORCE_COLOR", undefined);
  vi.stubEnv("NO_COLOR", undefined);
  // TERM=dumb stops the terminal background query, which writes to the real tty. It also disables color.
  vi.stubEnv("TERM", "dumb");
  resetColour();
}

/** Reset the color cache, the theme and the appearance cache. Call this after each test. */
export function resetColour(): void {
  printer.colorsEnabled = null;
  printer.theme = "dark";
  resetAppearanceCache();
}
