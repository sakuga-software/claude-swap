import type { SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PID_REUSE_SLACK_S,
  getClaudeDir,
  getRunningInstances,
  internals,
  isPidAlive,
  listIdeInstances,
  listSessions,
  lstartSeconds,
  pidMatchesRecord,
  processIsClaude,
  processStartTicks,
  processStartedAt,
  statStartTicks,
} from "../src/process_detection.js";
import { abbreviatePath, entrypointLabel, formatAge } from "../src/printer.js";
import { testHome } from "./helpers/home.js";

let tmpPath: string;

beforeEach(() => {
  tmpPath = fs.mkdtempSync(path.join(testHome(), "tmp-"));
});

const osError = (message: string, code: string) => Object.assign(new Error(message), { code });

describe("TestGetClaudeDir", () => {
  it("test_default_path", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    expect(getClaudeDir()).toBe(path.join(os.homedir(), ".claude"));
  });

  it("test_respects_env_var", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", tmpPath);
    expect(getClaudeDir()).toBe(tmpPath);
  });
});

describe("TestIsPidAlive", () => {
  // Pin the platform so these tests run the POSIX branch on any host.
  it("test_alive_pid", () => {
    vi.spyOn(internals, "sysPlatform").mockReturnValue("linux");
    const kill = vi.spyOn(internals, "kill").mockReturnValue(undefined);
    expect(isPidAlive(12345)).toBe(true);
    expect(kill).toHaveBeenCalledExactlyOnceWith(12345, 0);
  });

  it("test_dead_pid", () => {
    vi.spyOn(internals, "sysPlatform").mockReturnValue("linux");
    vi.spyOn(internals, "kill").mockImplementation(() => {
      throw osError("No such process", "ESRCH");
    });
    expect(isPidAlive(12345)).toBe(false);
  });

  it("test_permission_error_means_alive", () => {
    vi.spyOn(internals, "sysPlatform").mockReturnValue("linux");
    vi.spyOn(internals, "kill").mockImplementation(() => {
      throw osError("Operation not permitted", "EPERM");
    });
    expect(isPidAlive(12345)).toBe(true);
  });

  it("test_windows_dispatches_to_ctypes_impl", () => {
    vi.spyOn(internals, "sysPlatform").mockReturnValue("win32");
    const win = vi.spyOn(internals, "isPidAliveWindows").mockReturnValue(true);
    expect(isPidAlive(12345)).toBe(true);
    expect(win).toHaveBeenCalledExactlyOnceWith(12345);
  });

  it("test_current_process_is_alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("test_invalid_pid_zero", () => {
    expect(isPidAlive(0)).toBe(false);
  });

  it("test_invalid_pid_one", () => {
    expect(isPidAlive(1)).toBe(false);
  });

  it("test_negative_pid", () => {
    expect(isPidAlive(-1)).toBe(false);
  });
});

const LSTART = "Wed Sep  2 20:35:59 2026";
const LSTART_S = 1788381359;
const TICKS = "11485";
// /proc/<pid>/stat: pid, (comm), then the numeric fields. The start time is field 22.
const STAT =
  "4242 (claude) S 1 4242 4242 0 -1 4194560 1234 0 0 0 10 5 0 0 20 0 8 0 " +
  `${TICKS} 123456789 4321 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 0 ` +
  "17 3 0 0 0 0 0 0 0 0 0 0 0 0 0\n";

describe("TestLstartSeconds", () => {
  it.each([
    [LSTART, LSTART_S],
    ["Thu Jan  1 00:00:00 1970", 0],
    ["Tue Nov 14 22:13:20 2023", 1_700_000_000],
  ])("test_parses_ps_lstart[%s]", (text, expected) => {
    expect(lstartSeconds(text)).toBe(expected);
  });

  it.each([
    "",
    "abc",
    "Wed Sep 2 20:35 2026",
    "Wed Foo  2 20:35:59 2026",
    "Wed Sep  2 20:35:59",
    "Wed Sep  2 20:35:xx 2026",
  ])("test_rejects_garbage[%s]", (text) => {
    expect(() => lstartSeconds(text)).toThrow(RangeError);
  });
});

describe("TestStatStartTicks", () => {
  it("test_reads_field_22", () => {
    expect(statStartTicks(STAT)).toBe(TICKS);
  });

  it("test_counts_from_the_last_parenthesis", () => {
    expect(statStartTicks(STAT.replace("(claude)", "(my (odd) name)"))).toBe(TICKS);
  });

  it.each(["", "4242 (claude) S 1 2 3", STAT.replace(TICKS, "x")])("test_rejects_garbage[%s]", (text) => {
    expect(statStartTicks(text)).toBeNull();
  });
});

describe("TestProcessStartTicks", () => {
  it("test_unreadable_is_unknowable", () => {
    vi.spyOn(internals, "readFile").mockImplementation(() => {
      throw osError("no /proc", "ENOENT");
    });
    expect(processStartTicks(4242)).toBeNull();
  });

  it("test_reads_proc_stat", () => {
    const read = vi.spyOn(internals, "readFile").mockReturnValue(STAT);
    expect(processStartTicks(4242)).toBe(TICKS);
    expect(read.mock.calls.at(-1)?.[0]).toBe("/proc/4242/stat");
  });

  it.skipIf(process.platform !== "linux")("test_own_process_matches_proc_self", () => {
    const expected = statStartTicks(fs.readFileSync("/proc/self/stat", "latin1"));
    expect(processStartTicks(process.pid)).toBe(expected);
  });
});

function subprocessResult(status: number, stdout: string): SpawnSyncReturns<string> {
  return { pid: 0, output: [null, stdout, ""], stdout, stderr: "", status, signal: null };
}

describe("TestProcessStartedAt", () => {
  it("test_windows_is_unknowable", () => {
    vi.spyOn(internals, "sysPlatform").mockReturnValue("win32");
    const run = vi.spyOn(internals, "spawnSync");
    expect(processStartedAt(1234)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("test_ps_failure_is_unknowable", () => {
    vi.spyOn(internals, "sysPlatform").mockReturnValue("linux");
    vi.spyOn(internals, "spawnSync").mockImplementation(() => {
      throw osError("no ps", "ENOENT");
    });
    expect(processStartedAt(1234)).toBeNull();
  });

  it("test_unknown_pid_is_unknowable", () => {
    vi.spyOn(internals, "sysPlatform").mockReturnValue("linux");
    vi.spyOn(internals, "spawnSync").mockReturnValue(subprocessResult(1, ""));
    expect(processStartedAt(1234)).toBeNull();
  });

  it("test_garbage_is_unknowable", () => {
    vi.spyOn(internals, "sysPlatform").mockReturnValue("linux");
    vi.spyOn(internals, "spawnSync").mockReturnValue(subprocessResult(0, "??\n"));
    expect(processStartedAt(1234)).toBeNull();
  });

  it("test_reads_lstart_the_way_claude_does", () => {
    vi.spyOn(internals, "sysPlatform").mockReturnValue("linux");
    const run = vi.spyOn(internals, "spawnSync").mockReturnValue(subprocessResult(0, `${LSTART}    \n`));
    expect(processStartedAt(1234)).toBe(LSTART_S);
    const [command, args, options] = run.mock.calls.at(-1)!;
    expect([command, ...args]).toEqual(["ps", "-o", "lstart=", "-p", "1234"]);
    const env = (options as { env: NodeJS.ProcessEnv }).env;
    expect(env.LC_ALL).toBe("C");
    expect(env.TZ).toBe("UTC");
  });

  it.skipIf(process.platform === "win32")("test_own_process_started_in_the_past", () => {
    const started = processStartedAt(process.pid);
    expect(started).not.toBeNull();
    expect(started!).toBeLessThanOrEqual(Date.now() / 1000);
  });
});

describe("TestProcessIsClaude", () => {
  it("test_ps_failure_is_unknowable", () => {
    vi.spyOn(internals, "sysPlatform").mockReturnValue("linux");
    vi.spyOn(internals, "spawnSync").mockImplementation(() => {
      throw osError("no ps", "ENOENT");
    });
    expect(processIsClaude(1234)).toBeNull();
  });

  it.each([
    ["claude           claude --resume 2d6cbe5d", true],
    ["node             node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", true],
    ["2.1.258          /home/u/.local/share/claude/versions/2.1.258", true],
    ["vim              vim notes.md", false],
  ])("test_judges_comm_and_args[%s]", (line, expected) => {
    vi.spyOn(internals, "sysPlatform").mockReturnValue("linux");
    const run = vi.spyOn(internals, "spawnSync").mockReturnValue(subprocessResult(0, `${line}\n`));
    expect(processIsClaude(1234)).toBe(expected);
    const [command, args] = run.mock.calls.at(-1)!;
    expect([command, ...args]).toEqual(["ps", "-o", "comm=,args=", "-p", "1234"]);
  });
});

describe("TestPidMatchesRecord", () => {
  it.each([null, "", "garbage"])("test_unstamped_or_garbage_record_passes[%s]", (procStart) => {
    const started = vi.spyOn(internals, "processStartedAt");
    expect(pidMatchesRecord(1234, procStart)).toBe(true);
    expect(started).not.toHaveBeenCalled();
  });

  it("test_unknowable_start_passes", () => {
    vi.spyOn(internals, "processStartedAt").mockReturnValue(null);
    const isClaude = vi.spyOn(internals, "processIsClaude");
    expect(pidMatchesRecord(1234, LSTART)).toBe(true);
    expect(isClaude).not.toHaveBeenCalled();
  });

  it("test_same_start_ticks_is_the_recorded_process", () => {
    vi.spyOn(internals, "processStartTicks").mockReturnValue(TICKS);
    const started = vi.spyOn(internals, "processStartedAt");
    expect(pidMatchesRecord(1234, TICKS)).toBe(true);
    expect(started).not.toHaveBeenCalled();
  });

  it("test_other_start_ticks_is_a_recycled_pid", () => {
    vi.spyOn(internals, "processStartTicks").mockReturnValue("998877");
    const isClaude = vi.spyOn(internals, "processIsClaude");
    expect(pidMatchesRecord(1234, TICKS)).toBe(false);
    expect(isClaude).not.toHaveBeenCalled();
  });

  it("test_unreadable_ticks_pass", () => {
    vi.spyOn(internals, "processStartTicks").mockReturnValue(null);
    expect(pidMatchesRecord(1234, "134332352612628209")).toBe(true);
  });

  it.each([LSTART_S, LSTART_S - 3600, LSTART_S + Math.floor(PID_REUSE_SLACK_S / 2)])(
    "test_process_not_younger_than_record_passes[%i]",
    (started) => {
      vi.spyOn(internals, "processStartedAt").mockReturnValue(started);
      const isClaude = vi.spyOn(internals, "processIsClaude");
      expect(pidMatchesRecord(1234, LSTART)).toBe(true);
      expect(isClaude).not.toHaveBeenCalled();
    },
  );

  it("test_stranger_younger_than_record_is_a_recycled_pid", () => {
    vi.spyOn(internals, "processStartedAt").mockReturnValue(LSTART_S + 86400);
    vi.spyOn(internals, "processIsClaude").mockReturnValue(false);
    expect(pidMatchesRecord(1234, LSTART)).toBe(false);
  });

  it("test_claude_younger_than_record_is_kept", () => {
    vi.spyOn(internals, "processStartedAt").mockReturnValue(LSTART_S + 86400);
    vi.spyOn(internals, "processIsClaude").mockReturnValue(true);
    expect(pidMatchesRecord(1234, LSTART)).toBe(true);
  });

  it("test_unknowable_identity_is_kept", () => {
    vi.spyOn(internals, "processStartedAt").mockReturnValue(LSTART_S + 86400);
    vi.spyOn(internals, "processIsClaude").mockReturnValue(null);
    expect(pidMatchesRecord(1234, LSTART)).toBe(true);
  });
});

function writeSession(sessionsDir: string, pid: number, overrides: Record<string, unknown> = {}): string {
  const data = {
    pid,
    sessionId: `session-${pid}`,
    cwd: "/home/user/project",
    startedAt: Date.now(),
    kind: "interactive",
    entrypoint: "cli",
    ...overrides,
  };
  const file = path.join(sessionsDir, `${pid}.json`);
  fs.writeFileSync(file, JSON.stringify(data), "utf8");
  return file;
}

function makeDir(name: string): string {
  const dir = path.join(tmpPath, name);
  fs.mkdirSync(dir);
  return dir;
}

describe("TestListSessions", () => {
  it("test_reads_valid_sessions", () => {
    const sessionsDir = makeDir("sessions");
    writeSession(sessionsDir, 1001, { entrypoint: "cli", cwd: "/home/user/app" });
    writeSession(sessionsDir, 1002, { entrypoint: "claude-vscode", cwd: "/home/user/web" });

    vi.spyOn(internals, "isPidAlive").mockReturnValue(true);
    const result = listSessions(tmpPath);

    expect(result).toHaveLength(2);
    expect(new Set(result.map((s) => s.pid))).toEqual(new Set([1001, 1002]));
  });

  it("test_filters_dead_pids", () => {
    const sessionsDir = makeDir("sessions");
    writeSession(sessionsDir, 1001);
    writeSession(sessionsDir, 1002);

    vi.spyOn(internals, "isPidAlive").mockImplementation((pid) => pid === 1001);
    const result = listSessions(tmpPath);

    expect(result).toHaveLength(1);
    expect(result[0]!.pid).toBe(1001);
  });

  it("test_filters_recycled_pids", () => {
    const sessionsDir = makeDir("sessions");
    writeSession(sessionsDir, 1001, { procStart: LSTART });
    writeSession(sessionsDir, 1002, { procStart: LSTART });

    vi.spyOn(internals, "isPidAlive").mockReturnValue(true);
    vi.spyOn(internals, "processStartedAt").mockImplementation((pid) => (pid === 1002 ? LSTART_S : LSTART_S + 86400));
    vi.spyOn(internals, "processIsClaude").mockReturnValue(false);
    const result = listSessions(tmpPath);

    expect(result.map((s) => s.pid)).toEqual([1002]);
  });

  it("test_filters_recycled_pids_by_start_ticks", () => {
    const sessionsDir = makeDir("sessions");
    writeSession(sessionsDir, 1001, { procStart: TICKS });
    writeSession(sessionsDir, 1002, { procStart: TICKS });

    vi.spyOn(internals, "isPidAlive").mockReturnValue(true);
    vi.spyOn(internals, "processStartTicks").mockImplementation((pid) => (pid === 1002 ? TICKS : "998877"));
    const result = listSessions(tmpPath);

    expect(result.map((s) => s.pid)).toEqual([1002]);
  });

  it("test_unknowable_start_time_keeps_session", () => {
    const sessionsDir = makeDir("sessions");
    writeSession(sessionsDir, 1001, { procStart: LSTART });

    vi.spyOn(internals, "isPidAlive").mockReturnValue(true);
    vi.spyOn(internals, "processStartedAt").mockReturnValue(null);
    const result = listSessions(tmpPath);

    expect(result.map((s) => s.pid)).toEqual([1001]);
  });

  it("test_missing_sessions_dir", () => {
    expect(listSessions(tmpPath)).toEqual([]);
  });

  it.each<[string, (p: string) => void]>([
    ["invalid_json", (p) => fs.writeFileSync(p, "not json{{{", "utf8")],
    ["invalid_utf8", (p) => fs.writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"pid": 1}')]))],
    ["pid_overflows_c_long", (p) => fs.writeFileSync(p, JSON.stringify({ pid: 2 ** 31 }), "utf8")],
    ["json_nested_too_deep", (p) => fs.writeFileSync(p, "[".repeat(2000) + "]".repeat(2000), "utf8")],
    ["json_is_an_array", (p) => fs.writeFileSync(p, "[]", "utf8")],
  ])("test_corrupt_session_file_is_skipped[%s]", (_id, writeBadFile) => {
    const sessionsDir = makeDir("sessions");
    writeBadFile(path.join(sessionsDir, "9999.json"));

    expect(listSessions(tmpPath)).toEqual([]);
  });

  it("test_missing_pid_field", () => {
    const sessionsDir = makeDir("sessions");
    fs.writeFileSync(path.join(sessionsDir, "9999.json"), JSON.stringify({ sessionId: "abc", cwd: "/tmp" }), "utf8");

    expect(listSessions(tmpPath)).toEqual([]);
  });

  it("test_optional_status_field", () => {
    const sessionsDir = makeDir("sessions");
    writeSession(sessionsDir, 1001, { status: "busy" });

    vi.spyOn(internals, "isPidAlive").mockReturnValue(true);
    const result = listSessions(tmpPath);

    expect(result[0]!.status).toBe("busy");
  });

  it("test_status_absent", () => {
    const sessionsDir = makeDir("sessions");
    writeSession(sessionsDir, 1001);

    vi.spyOn(internals, "isPidAlive").mockReturnValue(true);
    const result = listSessions(tmpPath);

    expect(result[0]!.status).toBeNull();
  });

  it("test_session_fields", () => {
    const sessionsDir = makeDir("sessions");
    writeSession(sessionsDir, 5000, {
      sessionId: "sess-abc",
      cwd: "/projects/foo",
      startedAt: 1700000000000,
      kind: "bg",
      entrypoint: "claude-desktop",
    });

    vi.spyOn(internals, "isPidAlive").mockReturnValue(true);
    const s = listSessions(tmpPath)[0]!;

    expect(s.pid).toBe(5000);
    expect(s.sessionId).toBe("sess-abc");
    expect(s.cwd).toBe("/projects/foo");
    expect(s.startedAt).toBe(1700000000000);
    expect(s.kind).toBe("bg");
    expect(s.entrypoint).toBe("claude-desktop");
  });
});

function writeIdeLock(ideDir: string, port: number, overrides: Record<string, unknown> = {}): string {
  const data = {
    pid: port + 1000,
    workspaceFolders: ["/home/user/project"],
    ideName: "Visual Studio Code",
    transport: "ws",
    ...overrides,
  };
  const file = path.join(ideDir, `${port}.lock`);
  fs.writeFileSync(file, JSON.stringify(data), "utf8");
  return file;
}

describe("TestListIdeInstances", () => {
  it("test_reads_valid_lockfiles", () => {
    const ideDir = makeDir("ide");
    writeIdeLock(ideDir, 45000, { ideName: "Visual Studio Code" });
    writeIdeLock(ideDir, 45001, { ideName: "Cursor" });

    vi.spyOn(internals, "isPidAlive").mockReturnValue(true);
    const result = listIdeInstances(tmpPath);

    expect(result).toHaveLength(2);
    expect(new Set(result.map((i) => i.ideName))).toEqual(new Set(["Visual Studio Code", "Cursor"]));
  });

  it("test_filters_dead_pids", () => {
    const ideDir = makeDir("ide");
    writeIdeLock(ideDir, 45000, { pid: 2001 });
    writeIdeLock(ideDir, 45001, { pid: 2002 });

    vi.spyOn(internals, "isPidAlive").mockImplementation((p) => p === 2001);
    const result = listIdeInstances(tmpPath);

    expect(result).toHaveLength(1);
    expect(result[0]!.pid).toBe(2001);
  });

  it("test_missing_ide_dir", () => {
    expect(listIdeInstances(tmpPath)).toEqual([]);
  });

  it.each<[string, (p: string) => void]>([
    ["invalid_json", (p) => fs.writeFileSync(p, "broken", "utf8")],
    ["pid_overflows_c_long", (p) => fs.writeFileSync(p, JSON.stringify({ pid: 2 ** 31 }), "utf8")],
    ["json_nested_too_deep", (p) => fs.writeFileSync(p, "[".repeat(2000) + "]".repeat(2000), "utf8")],
    ["json_is_an_array", (p) => fs.writeFileSync(p, "[]", "utf8")],
  ])("test_corrupt_json[%s]", (_id, writeBadFile) => {
    const ideDir = makeDir("ide");
    writeBadFile(path.join(ideDir, "9999.lock"));

    expect(listIdeInstances(tmpPath)).toEqual([]);
  });

  it("test_missing_pid_field", () => {
    const ideDir = makeDir("ide");
    fs.writeFileSync(path.join(ideDir, "9999.lock"), JSON.stringify({ ideName: "VS Code" }), "utf8");

    expect(listIdeInstances(tmpPath)).toEqual([]);
  });

  it("test_port_from_filename", () => {
    const ideDir = makeDir("ide");
    writeIdeLock(ideDir, 12345);

    vi.spyOn(internals, "isPidAlive").mockReturnValue(true);
    expect(listIdeInstances(tmpPath)[0]!.port).toBe(12345);
  });

  it("test_workspace_folders", () => {
    const ideDir = makeDir("ide");
    writeIdeLock(ideDir, 45000, { workspaceFolders: ["/a", "/b"] });

    vi.spyOn(internals, "isPidAlive").mockReturnValue(true);
    expect(listIdeInstances(tmpPath)[0]!.workspaceFolders).toEqual(["/a", "/b"]);
  });
});

describe("TestGetRunningInstances", () => {
  it("test_returns_both", () => {
    writeSession(makeDir("sessions"), 1001);
    writeIdeLock(makeDir("ide"), 45000);

    vi.spyOn(internals, "isPidAlive").mockReturnValue(true);
    const [sessions, ides] = getRunningInstances(tmpPath);

    expect(sessions).toHaveLength(1);
    expect(ides).toHaveLength(1);
  });

  it("test_empty_when_no_dirs", () => {
    const [sessions, ides] = getRunningInstances(tmpPath);
    expect(sessions).toEqual([]);
    expect(ides).toEqual([]);
  });
});

describe("TestEntrypointLabel", () => {
  it.each([
    ["cli", "CLI"],
    ["claude-vscode", "VS Code"],
    ["claude-desktop", "Desktop"],
    ["sdk-cli", "SDK"],
    ["mcp", "MCP"],
    ["unknown-thing", "unknown-thing"],
  ])("test_known_and_unknown[%s]", (entrypoint, expected) => {
    expect(entrypointLabel(entrypoint)).toBe(expected);
  });
});

describe("TestAbbreviatePath", () => {
  it("test_replaces_home", () => {
    expect(abbreviatePath(`${os.homedir()}/projects/foo`)).toBe("~/projects/foo");
  });

  it("test_non_home_path_unchanged", () => {
    expect(abbreviatePath("/opt/data/bar")).toBe("/opt/data/bar");
  });

  it("test_home_root", () => {
    expect(abbreviatePath(os.homedir())).toBe("~");
  });
});

describe("TestFormatAge", () => {
  it("test_just_now", () => {
    expect(formatAge(Date.now())).toBe("just now");
  });

  it("test_minutes", () => {
    expect(formatAge(Date.now() - 300_000)).toBe("5m ago");
  });

  it("test_hours", () => {
    expect(formatAge(Date.now() - 7_200_000)).toBe("2h ago");
  });

  it("test_days", () => {
    expect(formatAge(Date.now() - 172_800_000)).toBe("2d ago");
  });
});
