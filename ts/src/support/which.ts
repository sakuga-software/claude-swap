import fs from "node:fs";
import path from "node:path";

/**
 * `shutil.which(name)`: the first executable file named `name` on `PATH`, or null.
 * On Windows, the function also tries each `PATHEXT` extension, so it finds a `.cmd` shim.
 */
export function which(name: string): string | null {
  const windows = process.platform === "win32";
  const extensions = windows ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (!windows) fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Missing or not executable here. Try the next candidate.
      }
    }
  }
  return null;
}
