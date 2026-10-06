import { describe, expect, it, vi } from "vitest";
import * as appearance from "../src/appearance.js";
import * as printer from "../src/printer.js";

// Each pair below is an ordering: the first test latches, the second reads.
// The entry check in `deterministicColour()` is the real guard. These pairs only show what the leak looks like.

it("test_a_test_may_latch_the_colour_cache", () => {
  printer.internals.colorsEnabled = true;
  expect(printer.colorsEnabled()).toBe(true);
});

it("test_the_next_test_is_not_styled_by_it", () => {
  vi.spyOn(printer.internals, "stdoutIsatty").mockReturnValue(false);
  expect(printer.accent("Skipping")).toBe("Skipping");
  expect(printer.muted("usage")).not.toContain("\x1b[");
});

it("test_a_test_may_latch_the_theme", () => {
  vi.stubEnv("FORCE_COLOR", "1");
  printer.internals.colorsEnabled = null;
  printer.setTheme("light");
  expect(printer.accent("x")).toContain("38;2;149;76;42");
});

it("test_the_next_test_is_not_themed_by_it", () => {
  vi.stubEnv("FORCE_COLOR", "1");
  printer.internals.colorsEnabled = null;
  expect(printer.accent("x"), "the previous test's light theme outlived it").toContain("38;5;173");
});

it.skipIf(process.platform === "win32")("test_the_suite_does_not_query_the_developers_terminal", () => {
  // Node has no pty without a native dependency. Fake tty checks replace the pty, and a spy on the output replaces the read of the pty master.
  // Do not set TERM here: the test checks the TERM value that the global hook sets.
  vi.stubEnv("TMUX", undefined);
  vi.stubEnv("STY", undefined);
  appearance.resetCache();

  const emitted: string[] = [];
  vi.spyOn(appearance.internals, "stdinIsatty").mockReturnValue(true);
  vi.spyOn(appearance.internals, "stdoutIsatty").mockReturnValue(true);
  vi.spyOn(appearance.internals, "writeStdout").mockImplementation((text: string) => {
    emitted.push(text);
  });
  vi.spyOn(printer.internals, "stdoutIsatty").mockReturnValue(true);
  expect(appearance.internals.stdinIsatty() && printer.internals.stdoutIsatty(), "premise: a tty").toBe(true);

  expect(appearance.detectTerminalBackground()).toBeNull();

  printer.internals.colorsEnabled = null;
  const coloursOn = printer.colorsEnabled();

  expect(emitted.join(""), `the OSC-11 query hit the terminal: ${JSON.stringify(emitted)}`).not.toContain("\x1b]11;?");
  expect(
    coloursOn,
    `TERM=${JSON.stringify(process.env.TERM)} blocks the OSC-11 query but not colour detection; the suite styles its own assertions`,
  ).toBe(false);
});

describe("TestScopedContextDoesNotLeakTheAutouseScrub", () => {
  it.skip("test_scoped_context_does_not_leak_it", () => {
    // Python only: pytest gives one shared MonkeyPatch instance to each test, so `undo()` in a test also undoes the autouse scrub.
    // Vitest has no shared instance, so the failure mode does not exist.
  });
});
