import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

let current: string | undefined;

/** The isolated home of the running test. The setup file creates it before each test. */
export function testHome(): string {
  if (!current) throw new Error("testHome() called outside a test");
  return current;
}

/**
 * Give the test a new empty home with a `.claude` directory, and remove
 * every variable that moves a path out of that home.
 */
export function isolateHome(): string {
  current = fs.mkdtempSync(path.join(os.tmpdir(), "cswap-home-"));
  fs.mkdirSync(path.join(current, ".claude"));
  vi.stubEnv("HOME", current);
  vi.stubEnv("USERPROFILE", current);
  for (const name of ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "XDG_DATA_HOME", "FORCE_COLOR", "NO_COLOR"]) {
    vi.stubEnv(name, undefined);
  }
  // TERM=dumb stops the terminal background query. That query writes to the real tty.
  vi.stubEnv("TERM", "dumb");
  return current;
}

export function releaseHome(): void {
  if (current) fs.rmSync(current, { recursive: true, force: true });
  current = undefined;
}
