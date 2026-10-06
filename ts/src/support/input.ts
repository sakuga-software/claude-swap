/** Synchronous terminal input, like Python `input()`, `getpass.getpass()` and `sys.stdin.readline()`. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";

/** Standard input ended before a line was read. The equivalent of Python `EOFError`. */
export class EOFError extends Error {
  override name = "EOFError";
}

/**
 * Read one line from file descriptor 0. Return the line without its end, or
 * null at the end of the input with no data.
 */
export function readLineSync(): string | null {
  const chunks: number[] = [];
  const byte = Buffer.alloc(1);
  for (;;) {
    let n: number;
    try {
      n = fs.readSync(0, byte, 0, 1, null);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") continue;
      if (code === "EOF") break;
      throw e;
    }
    if (n === 0) break;
    if (byte[0] === 0x0a) return Buffer.from(chunks).toString("utf8").replace(/\r$/, "");
    chunks.push(byte[0]!);
  }
  return chunks.length > 0 ? Buffer.from(chunks).toString("utf8") : null;
}

/** Python `input(prompt)`. Throw `EOFError` at the end of the input. */
export function inputSync(prompt = ""): string {
  if (prompt) process.stdout.write(prompt);
  const line = readLineSync();
  if (line === null) throw new EOFError("EOF when reading a line");
  return line;
}

/** Python `sys.stdin.readline()` with the line end removed. Return "" at the end of the input. */
export function readStdinLine(): string {
  return readLineSync() ?? "";
}

/** Python `getpass.getpass(prompt)`: read a line with the terminal echo off. */
export function getpassSync(prompt = "Password: "): string {
  const tty = process.stdin.isTTY === true;
  const stty = (arg: string) => spawnSync("stty", [arg], { stdio: ["inherit", "ignore", "ignore"] });
  process.stderr.write(prompt);
  if (tty && process.platform !== "win32") stty("-echo");
  try {
    const line = readLineSync();
    if (line === null) throw new EOFError("EOF when reading a line");
    return line;
  } finally {
    if (tty && process.platform !== "win32") stty("echo");
    process.stderr.write("\n");
  }
}
