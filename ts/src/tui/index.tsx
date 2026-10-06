/**
 * The Ink TUI of claude-swap: `cswap tui`, bare `cswap` in an interactive terminal, and `cswap watch`.
 * The CLI imports this module only on those paths, so the plain commands never load React and Ink.
 */

import { render } from "ink";
import { detectTerminalBackground, drainStdin } from "../appearance.js";
import type { ClaudeAccountSwitcher } from "../switcher.js";
import { CswapApp, CswapView, type StartPage } from "./app.js";

/**
 * A view of `process.stdout` whose `write` is the original one.
 * `runAction` replaces `process.stdout.write` during an action, and the frames of Ink must not go into its capture.
 */
function rendererStdout(): NodeJS.WriteStream {
  const stdout = process.stdout;
  const write = stdout.write.bind(stdout);
  return new Proxy(stdout, {
    get(target, prop) {
      if (prop === "write") return write;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * Run the TUI over a switcher. Returns the exit code of the process.
 * `start = "watch"` opens on the live watch page, on top of the dashboard.
 */
export async function run(switcher: ClaudeAccountSwitcher, start: StartPage = "dashboard"): Promise<number> {
  // Query the terminal background while stdin is still in cooked mode, before Ink starts.
  // The query always runs, so that a change to "auto" works when the start theme is explicit.
  // Both calls fail safe, but a detection bug must never stop the TUI from starting.
  let detected: string | null;
  try {
    detected = detectTerminalBackground();
  } catch {
    detected = null;
  }
  const app = new CswapApp(switcher, { start, detected });
  // Discard a late OSC reply now, so that Ink does not read it as key presses.
  try {
    drainStdin();
  } catch {
    // Best effort only.
  }
  const instance = render(<CswapView app={app} />, {
    stdout: rendererStdout(),
    exitOnCtrlC: false,
    alternateScreen: true,
  });
  await instance.waitUntilExit();
  return app.returnCode ?? 0;
}
