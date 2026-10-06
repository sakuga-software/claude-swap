/** Check the npm registry for newer versions of claude-swap. */
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCacheDir, MISSING, readCache, writeCache } from "./cache.js";
import { accent, error } from "./printer.js";

/**
 * The Python version caches the PyPI version in `update_check.json`. This port
 * keeps the npm dist-tags in a different file, so each tool reads only its own registry data.
 */
export const CACHE_FILE_NAME = "update_check_npm.json";
export const CACHE_TTL = 24 * 3600;
export const PACKAGE_NAME = "@sakuga-software/claude-swap";
export const REGISTRY_URL = "https://registry.npmjs.org/@sakuga-software%2fclaude-swap";
const FETCH_TIMEOUT_MS = 2000;

export type InstallMethod = "npm" | "pnpm";

const UPGRADE_COMMANDS: Record<InstallMethod, string[]> = {
  npm: ["npm", "i", "-g", PACKAGE_NAME],
  pnpm: ["pnpm", "add", "-g", PACKAGE_NAME],
};

const VERSION_RE = /^(\d+(?:\.\d+)*)(?:[-_.]?(alpha|beta|preview|pre|rc|a|b|c)[-_.]?(\d+)?)?/i;
const PRE_RANKS: Record<string, number> = { alpha: 0, a: 0, beta: 1, b: 1, preview: 2, pre: 2, rc: 2, c: 2 };
const FINAL_RANK = 3;

/** A version as a sort key. `preRank` is `FINAL_RANK` if the version is not a pre-release. */
export interface Version {
  release: number[];
  preRank: number;
  preNumber: number;
}

type SpawnSyncFn = (file: string, args: string[], options: SpawnSyncOptions) => SpawnSyncReturns<string | Buffer>;

/** The replaceable parts of this module. Tests change these properties. */
export const internals = {
  platform: process.platform as string,
  fetch: (url: string, init: RequestInit): Promise<Response> => fetch(url, init),
  spawnSync: spawnSync as SpawnSyncFn,
  cachePath: (): string => path.join(getCacheDir(), CACHE_FILE_NAME),
  /** The real path of the installed package code. It is the analog of `sys.prefix`. */
  installPath: (): string => {
    const here = fileURLToPath(import.meta.url);
    try {
      return fs.realpathSync(here);
    } catch {
      return here;
    }
  },
  detectInstallMethod: (): InstallMethod | null => detectInstallMethod(),
};

/**
 * Parse a release number with an optional pre-release suffix.
 * It accepts the PEP 440 form (`0.27.0b1`) and the semver form (`0.27.0-beta.1`).
 * Throws `RangeError` if the text does not start with a version.
 */
export function parseVersion(v: string): Version {
  const m = VERSION_RE.exec(v);
  if (m === null) throw new RangeError(`unrecognized version: ${JSON.stringify(v)}`);
  const release = (m[1] ?? "").split(".").map(Number);
  // 0.27 and 0.27.0 are the same release.
  while (release.length > 1 && release[release.length - 1] === 0) release.pop();
  if (m[2] === undefined) return { release, preRank: FINAL_RANK, preNumber: 0 };
  return { release, preRank: PRE_RANKS[m[2].toLowerCase()] ?? FINAL_RANK, preNumber: Number(m[3] ?? 0) };
}

/** Compare like Python tuples: the release first, then the pre-release fields. */
export function compareVersions(a: Version, b: Version): number {
  const length = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < length; i++) {
    const left = a.release[i];
    const right = b.release[i];
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    if (left !== right) return left - right;
  }
  return a.preRank - b.preRank || a.preNumber - b.preNumber;
}

/** Whether `latest` is an upgrade to tell the user about. */
export function isNewer(latest: string, current: string): boolean {
  const latestVersion = parseVersion(latest);
  const currentVersion = parseVersion(current);
  // A user on a final release does not hear about pre-releases. A user on a pre-release hears about later ones.
  if (latestVersion.preRank !== FINAL_RANK && currentVersion.preRank === FINAL_RANK) return false;
  return compareVersions(latestVersion, currentVersion) > 0;
}

function pathParts(p: string): string[] {
  return p
    .split(/[\\/]+/)
    .filter((part) => part !== "")
    .map((part) => part.toLowerCase());
}

function hasAdjacent(parts: string[], first: string, second: string): boolean {
  return parts.some((part, i) => part === first && parts[i + 1] === second);
}

function isUnder(child: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Return `"npm"`, `"pnpm"`, or `null` if the install method is not clear. */
export function detectInstallMethod(): InstallMethod | null {
  const installPath = internals.installPath();
  const parts = pathParts(installPath);

  // Do the pnpm check first: a pnpm global store also contains `node_modules`.
  if (hasAdjacent(parts, "pnpm", "global")) return "pnpm";
  if (hasAdjacent(parts, "lib", "node_modules") || hasAdjacent(parts, "npm", "node_modules")) return "npm";

  // Trust an environment variable only if the install path is under it.
  const overrides: [string | undefined, InstallMethod][] = [
    [process.env.PNPM_HOME, "pnpm"],
    [process.env.NPM_CONFIG_PREFIX ?? process.env.npm_config_prefix, "npm"],
  ];
  for (const [root, name] of overrides) {
    if (root && isUnder(installPath, root)) return name;
  }
  return null;
}

function distTagVersions(cached: unknown): string[] {
  if (typeof cached === "string") return [cached];
  if (cached !== null && typeof cached === "object" && !Array.isArray(cached)) {
    return Object.values(cached).filter((v): v is string => typeof v === "string");
  }
  return [];
}

/** The newest dist-tag version that `isNewer` accepts, or `null`. */
function newestUpgrade(distTags: unknown, currentVersion: string): string | null {
  let best: string | null = null;
  for (const candidate of distTagVersions(distTags)) {
    try {
      if (!isNewer(candidate, currentVersion)) continue;
      if (best === null || compareVersions(parseVersion(candidate), parseVersion(best)) > 0) best = candidate;
    } catch {
      // An unparseable tag is not an upgrade.
    }
  }
  return best;
}

async function fetchDistTags(): Promise<Record<string, string> | null> {
  try {
    const resp = await internals.fetch(REGISTRY_URL, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { "dist-tags"?: unknown };
    const tags = data["dist-tags"];
    if (tags === null || typeof tags !== "object" || Array.isArray(tags)) return null;
    return Object.fromEntries(
      Object.entries(tags).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return null;
  }
}

/** Return a notification if a newer version exists, else `null`. This function never throws. */
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  try {
    let distTags: unknown = readCache(internals.cachePath(), CACHE_TTL);
    if (distTags === MISSING) {
      distTags = await fetchDistTags();
      // Cache a failure too, so that an offline machine does not wait for the timeout on each run.
      writeCache(internals.cachePath(), distTags);
    }

    const latestVersion = newestUpgrade(distTags, currentVersion);
    if (latestVersion === null) return null;

    const method = internals.detectInstallMethod();
    const direct = method ? UPGRADE_COMMANDS[method].join(" ") : undefined;
    let hint: string;
    if (direct && internals.platform !== "win32") {
      hint = "Run `cswap upgrade` to update.";
    } else if (direct) {
      // On Windows, `cswap upgrade` only prints the command.
      hint = `Run \`${direct}\` to update.`;
    } else {
      hint = "Run `cswap upgrade` for upgrade instructions.";
    }
    return `A newer version of claude-swap is available (${latestVersion}). You are using ${currentVersion}. ${hint}`;
  } catch {
    return null;
  }
}

/**
 * Run the upgrade command of the install method.
 * Returns the exit code of the command, or 1 if the detection fails or the package manager is not on PATH.
 */
export function runSelfUpgrade(): number {
  const method = internals.detectInstallMethod();
  const cmd = method ? UPGRADE_COMMANDS[method] : undefined;
  if (!method || !cmd) {
    error(
      "Could not detect install method (looked for npm / pnpm global installs).\n" +
        `  install path: ${internals.installPath()}\n` +
        `  node:         ${process.execPath}\n` +
        "To upgrade manually, run one of:\n" +
        `  ${UPGRADE_COMMANDS.npm.join(" ")}\n` +
        `  ${UPGRADE_COMMANDS.pnpm.join(" ")}\n` +
        "If you run claude-swap from a source checkout, use `git pull` instead.",
    );
    return 1;
  }

  // On Windows, `npm` and `pnpm` are `.cmd` files, and spawnSync cannot start them without a shell.
  if (internals.platform === "win32") {
    process.stdout.write(`To upgrade claude-swap on Windows, run:\n  ${accent(cmd.join(" "))}\n`);
    return 1;
  }

  const [file = "", ...args] = cmd;
  const result = internals.spawnSync(file, args, { stdio: "inherit" });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      error(
        `Detected ${method} install but \`${file}\` is not on PATH. ` +
          "Run the upgrade manually from a shell where it is available.",
      );
      return 1;
    }
    throw result.error;
  }
  return result.status ?? 1;
}
