import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** `os.path.expanduser` for `~` and `~/...`. The `~user` form stays as it is. */
export function expandUser(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * `Path.resolve()` (non-strict): make `p` absolute and resolve the symlinks
 * of the longest part that exists. The part that does not exist stays as written.
 */
export function resolvePath(p: string): string {
  const absolute = path.resolve(p);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(resolvePath(parent), path.basename(absolute));
  }
}
