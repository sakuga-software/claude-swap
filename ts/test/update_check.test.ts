import type { SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CACHE_TTL, checkForUpdate, detectInstallMethod, internals, runSelfUpgrade } from "../src/update_check.js";
import { testHome } from "./helpers/home.js";

const original = { ...internals };
let tmpPath: string;

beforeEach(() => {
  tmpPath = testHome();
  internals.cachePath = () => path.join(tmpPath, "default-cache.json");
  internals.fetch = () => Promise.reject(new Error("A test tried to reach the real npm registry. Mock internals.fetch."));
  internals.spawnSync = () => {
    throw new Error("A test tried to run a real package manager. Mock internals.spawnSync.");
  };
});

afterEach(() => {
  Object.assign(internals, original);
});

function npmResponse(version: string): Response {
  return new Response(JSON.stringify({ "dist-tags": { latest: version } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(version: string) {
  return vi.spyOn(internals, "fetch").mockImplementation(async () => npmResponse(version));
}

/** Write a cache file in the shared cache format. */
function writeCacheFile(file: string, data: unknown, timestamp?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ timestamp: timestamp ?? Date.now() / 1000, data }));
}

function useCache(file: string): void {
  internals.cachePath = () => file;
}

function completed(status: number): SpawnSyncReturns<string> {
  return { pid: 0, output: [], stdout: "", stderr: "", status, signal: null };
}

function captureStream(stream: NodeJS.WriteStream): () => string {
  const chunks: string[] = [];
  vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return () => chunks.join("");
}

describe("TestCheckForUpdate", () => {
  it("test_newer_version_available", async () => {
    useCache(path.join(tmpPath, "cache.json"));
    mockFetch("0.4.0");

    const result = await checkForUpdate("0.3.2");

    expect(result).not.toBeNull();
    expect(result).toContain("0.4.0");
    expect(result).toContain("0.3.2");
  });

  it("test_already_on_latest", async () => {
    useCache(path.join(tmpPath, "cache.json"));
    mockFetch("0.3.2");

    expect(await checkForUpdate("0.3.2")).toBeNull();
  });

  it("test_network_error_returns_none_and_caches", async () => {
    const cachePath = path.join(tmpPath, "cache.json");
    useCache(cachePath);
    vi.spyOn(internals, "fetch").mockRejectedValue(new Error("network error"));

    const result = await checkForUpdate("0.3.2");

    expect(result).toBeNull();
    expect(fs.existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    expect(cache.data).toBeNull();
  });

  it("test_fresh_error_cache_skips_network", async () => {
    const cachePath = path.join(tmpPath, "cache.json");
    writeCacheFile(cachePath, null);
    useCache(cachePath);
    const fetchMock = mockFetch("0.4.0");

    const result = await checkForUpdate("0.3.2");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("test_fresh_cache_no_network", async () => {
    const cachePath = path.join(tmpPath, "cache.json");
    writeCacheFile(cachePath, { latest: "0.5.0" });
    useCache(cachePath);
    const fetchMock = mockFetch("0.4.0");

    const result = await checkForUpdate("0.3.2");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result).toContain("0.5.0");
  });

  it("test_stale_cache_fetches_from_pypi", async () => {
    const cachePath = path.join(tmpPath, "cache.json");
    writeCacheFile(cachePath, { latest: "0.3.0" }, Date.now() / 1000 - CACHE_TTL - 1);
    useCache(cachePath);
    const fetchMock = mockFetch("0.4.0");

    const result = await checkForUpdate("0.3.2");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).not.toBeNull();
    expect(result).toContain("0.4.0");
  });
});

// claude-swap ships every cycle as a pre-release first, so the current version is often 0.27.0-beta.1.
describe("TestCheckForUpdatePrereleases", () => {
  it("test_prerelease_is_told_about_later_release", async () => {
    useCache(path.join(tmpPath, "cache.json"));
    mockFetch("0.28.0");

    const result = await checkForUpdate("0.27.0-beta.1");

    expect(result).not.toBeNull();
    expect(result).toContain("0.28.0");
    expect(result).toContain("0.27.0-beta.1");
  });

  it("test_prerelease_is_told_about_its_own_final_release", async () => {
    useCache(path.join(tmpPath, "cache.json"));
    mockFetch("0.27.0");

    const result = await checkForUpdate("0.27.0-beta.1");

    expect(result).not.toBeNull();
    expect(result).toContain("0.27.0");
  });

  it("test_prerelease_is_told_about_later_prerelease", async () => {
    useCache(path.join(tmpPath, "cache.json"));
    mockFetch("0.27.0-rc.1");

    const result = await checkForUpdate("0.27.0-beta.2");

    expect(result).not.toBeNull();
    expect(result).toContain("0.27.0-rc.1");
  });

  it("test_final_release_is_not_pushed_onto_a_prerelease", async () => {
    useCache(path.join(tmpPath, "cache.json"));
    mockFetch("0.28.0-beta.1");

    expect(await checkForUpdate("0.27.0")).toBeNull();
  });

  it("test_unparseable_version_stays_silent", async () => {
    useCache(path.join(tmpPath, "cache.json"));
    mockFetch("0.28.0");

    expect(await checkForUpdate("main")).toBeNull();
  });
});

// The Python names say uv and pipx. Here, the uv cases test pnpm and the pipx cases test npm.
describe("TestDetectInstallMethod", () => {
  function setPrefix(prefix: string): void {
    internals.installPath = () => prefix;
    vi.stubEnv("PNPM_HOME", undefined);
    vi.stubEnv("NPM_CONFIG_PREFIX", undefined);
    vi.stubEnv("npm_config_prefix", undefined);
  }

  it("test_uv_tool_default_path", () => {
    setPrefix("/home/me/.local/share/pnpm/global/5/node_modules/@sakuga-software/claude-swap/dist/cli.js");
    expect(detectInstallMethod()).toBe("pnpm");
  });

  it("test_pipx_default_path", () => {
    setPrefix("/usr/local/lib/node_modules/@sakuga-software/claude-swap/dist/cli.js");
    expect(detectInstallMethod()).toBe("npm");
  });

  it("test_non_adjacent_uv_tools_does_not_match", () => {
    // Both segments are present but not adjacent. This must not match.
    setPrefix("/home/me/projects/pnpm/some-global/claude-swap/dist/cli.js");
    expect(detectInstallMethod()).toBeNull();
  });

  it("test_non_adjacent_pipx_venvs_does_not_match", () => {
    setPrefix("/home/me/repos/lib-clone/node_modules-of-mine/claude-swap/dist/cli.js");
    expect(detectInstallMethod()).toBeNull();
  });

  it("test_source_checkout_returns_none", () => {
    setPrefix("/home/me/code/claude-swap/ts/dist/cli.js");
    expect(detectInstallMethod()).toBeNull();
  });

  it("test_mixed_case_path_detected", () => {
    // The match ignores case, for example on Windows.
    setPrefix("/Home/Me/.local/share/PNPM/Global/5/node_modules/@sakuga-software/claude-swap/dist/cli.js");
    expect(detectInstallMethod()).toBe("pnpm");
  });

  it("test_uv_tool_dir_env_with_prefix_under_it", () => {
    const customRoot = path.join(tmpPath, "pnpm-home");
    setPrefix(path.join(customRoot, "store", "claude-swap", "dist", "cli.js"));
    vi.stubEnv("PNPM_HOME", customRoot);
    expect(detectInstallMethod()).toBe("pnpm");
  });

  it("test_uv_tool_dir_env_set_but_prefix_elsewhere", () => {
    // The install path is somewhere else. The environment variable alone must not match.
    const customRoot = path.join(tmpPath, "pnpm-home");
    setPrefix(path.join(tmpPath, "some-project", "dist", "cli.js"));
    vi.stubEnv("PNPM_HOME", customRoot);
    expect(detectInstallMethod()).toBeNull();
  });

  it("test_pipx_home_env_with_prefix_under_it", () => {
    const customRoot = path.join(tmpPath, "npm-prefix");
    setPrefix(path.join(customRoot, "node_modules", "@sakuga-software", "claude-swap", "dist", "cli.js"));
    vi.stubEnv("NPM_CONFIG_PREFIX", customRoot);
    expect(detectInstallMethod()).toBe("npm");
  });
});

describe("TestCheckForUpdateMessage", () => {
  it("test_detected_method_non_windows_suggests_cswap_upgrade", async () => {
    // With npm or pnpm on macOS or Linux, `cswap upgrade` does the upgrade.
    internals.platform = "linux";
    useCache(path.join(tmpPath, "cache.json"));
    internals.detectInstallMethod = () => "pnpm";
    mockFetch("0.4.0");

    const result = await checkForUpdate("0.3.2");

    expect(result).not.toBeNull();
    expect(result).toContain("cswap upgrade");
    expect(result).not.toContain("pnpm add -g");
  });

  it("test_detected_method_windows_suggests_direct_command", async () => {
    // On Windows, `cswap upgrade` only prints the command, so the message gives the real command.
    internals.platform = "win32";
    useCache(path.join(tmpPath, "cache.json"));
    internals.detectInstallMethod = () => "npm";
    mockFetch("0.4.0");

    const result = await checkForUpdate("0.3.2");

    expect(result).not.toBeNull();
    expect(result).toContain("npm i -g @sakuga-software/claude-swap");
    expect(result).not.toContain("cswap upgrade");
  });

  it("test_unknown_method_suggests_cswap_instructions", async () => {
    useCache(path.join(tmpPath, "cache.json"));
    internals.detectInstallMethod = () => null;
    mockFetch("0.4.0");

    const result = await checkForUpdate("0.3.2");

    expect(result).not.toBeNull();
    expect(result).toContain("cswap upgrade` for upgrade instructions");
    expect(result).not.toContain("npm i -g");
    expect(result).not.toContain("pnpm add -g");
  });
});

describe("TestRunSelfUpgrade", () => {
  beforeEach(() => {
    internals.platform = "linux";
  });

  it("test_uv_invokes_uv_tool_upgrade", () => {
    internals.detectInstallMethod = () => "pnpm";
    const run = vi.spyOn(internals, "spawnSync").mockReturnValue(completed(0));

    expect(runSelfUpgrade()).toBe(0);
    expect(run).toHaveBeenCalledExactlyOnceWith("pnpm", ["add", "-g", "@sakuga-software/claude-swap"], {
      stdio: "inherit",
    });
  });

  it("test_pipx_invokes_pipx_upgrade", () => {
    internals.detectInstallMethod = () => "npm";
    const run = vi.spyOn(internals, "spawnSync").mockReturnValue(completed(0));

    expect(runSelfUpgrade()).toBe(0);
    expect(run).toHaveBeenCalledExactlyOnceWith("npm", ["i", "-g", "@sakuga-software/claude-swap"], {
      stdio: "inherit",
    });
  });

  it("test_propagates_nonzero_exit_code", () => {
    internals.detectInstallMethod = () => "pnpm";
    vi.spyOn(internals, "spawnSync").mockReturnValue(completed(2));

    expect(runSelfUpgrade()).toBe(2);
  });

  it("test_unknown_method_returns_1_and_prints_instructions", () => {
    internals.detectInstallMethod = () => null;
    const run = vi.spyOn(internals, "spawnSync");
    const err = captureStream(process.stderr);

    expect(runSelfUpgrade()).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(err()).toContain("npm i -g @sakuga-software/claude-swap");
    expect(err()).toContain("pnpm add -g @sakuga-software/claude-swap");
    expect(err()).toContain("git pull");
  });

  it("test_filenotfound_returns_1", () => {
    internals.detectInstallMethod = () => "pnpm";
    const enoent: NodeJS.ErrnoException = Object.assign(new Error("spawnSync pnpm ENOENT"), { code: "ENOENT" });
    vi.spyOn(internals, "spawnSync").mockReturnValue({ ...completed(0), status: null, error: enoent });
    const err = captureStream(process.stderr);

    expect(runSelfUpgrade()).toBe(1);
    expect(err()).toContain("PATH");
  });
});

// On Windows, the function prints the command for the user and returns 1. It never runs the command.
describe("TestRunSelfUpgradeWindows", () => {
  beforeEach(() => {
    internals.platform = "win32";
  });

  it("test_uv_prints_command_and_does_not_run", () => {
    internals.detectInstallMethod = () => "pnpm";
    const run = vi.spyOn(internals, "spawnSync");
    const out = captureStream(process.stdout);

    expect(runSelfUpgrade()).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(out()).toContain("pnpm add -g @sakuga-software/claude-swap");
  });

  it("test_pipx_prints_command_and_does_not_run", () => {
    internals.detectInstallMethod = () => "npm";
    const run = vi.spyOn(internals, "spawnSync");
    const out = captureStream(process.stdout);

    expect(runSelfUpgrade()).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(out()).toContain("npm i -g @sakuga-software/claude-swap");
  });

  it("test_unknown_method_hits_generic_fallback", () => {
    internals.detectInstallMethod = () => null;
    const run = vi.spyOn(internals, "spawnSync");
    const err = captureStream(process.stderr);

    expect(runSelfUpgrade()).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(err()).toContain("npm i -g @sakuga-software/claude-swap");
    expect(err()).toContain("pnpm add -g @sakuga-software/claude-swap");
    expect(err()).toContain("git pull");
  });
});
