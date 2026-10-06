import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import * as macosKeychain from "../src/macos_keychain.js";
import { internals, KeychainError } from "../src/macos_keychain.js";
import { useRealKeychain } from "./helpers/keychain.js";

// These tests run the real function bodies against a mocked spawnSync.
useRealKeychain();

function completed(status: number, stdout = "", stderr = ""): SpawnSyncReturns<string> {
  return { pid: 1, output: [null, stdout, stderr], stdout, stderr, status, signal: null };
}

function failed(code: string): SpawnSyncReturns<string> {
  const error = Object.assign(new Error(code), { code });
  return { pid: 0, output: [null, "", ""], stdout: "", stderr: "", status: null, signal: null, error };
}

function mockRun(result: SpawnSyncReturns<string>) {
  return vi.spyOn(internals, "spawnSync").mockReturnValue(result);
}

function lastArgv(run: ReturnType<typeof mockRun>): string[] {
  const [file, args] = run.mock.lastCall!;
  return [file, ...args];
}

it("test_get_password_returns_value_on_rc0", () => {
  const run = mockRun(completed(0, "the-secret\n"));
  expect(macosKeychain.getPassword("svc", "acct")).toBe("the-secret");
  const args = lastArgv(run);
  expect(args.slice(0, 2)).toEqual(["/usr/bin/security", "find-generic-password"]);
  expect(args).toContain("-a");
  expect(args).toContain("acct");
  expect(args).toContain("svc");
});

it("test_get_password_returns_none_only_on_rc44", () => {
  mockRun(completed(44));
  expect(macosKeychain.getPassword("svc", "acct")).toBeNull();
});

it("test_get_password_raises_on_other_nonzero", () => {
  mockRun(completed(51, "", "boom"));
  expect(() => macosKeychain.getPassword("svc", "acct")).toThrow(KeychainError);
});

it("test_item_exists_true_on_rc0_and_never_requests_secret", () => {
  const run = mockRun(completed(0));
  expect(macosKeychain.itemExists("svc", "acct")).toBe(true);
  expect(lastArgv(run)).not.toContain("-w");
});

it("test_item_exists_false_on_rc44_and_errors", () => {
  for (const rc of [44, 51]) {
    mockRun(completed(rc));
    expect(macosKeychain.itemExists("svc", "acct")).toBe(false);
  }
});

it("test_set_password_small_payload_uses_security_i_stdin", () => {
  const run = mockRun(completed(0));
  macosKeychain.setPassword("svc", "acct", "short-secret");

  const args = lastArgv(run);
  const opts = run.mock.lastCall![2];
  expect(args).toEqual(["/usr/bin/security", "-i"]);
  expect(args).not.toContain("short-secret");
  const stdin = opts.input as string;
  expect(stdin.startsWith("add-generic-password -U")).toBe(true);
  expect(stdin).toContain("-X " + Buffer.from("short-secret").toString("hex"));
  expect(stdin).toContain('-a "acct"');
  expect(stdin).toContain('-s "svc"');
});

it("test_set_password_large_payload_falls_back_to_argv", () => {
  const big = "x".repeat(macosKeychain.SECURITY_STDIN_LINE_LIMIT);
  const run = mockRun(completed(0));
  macosKeychain.setPassword("svc", "acct", big);

  const args = lastArgv(run);
  expect(args.slice(0, 3)).toEqual(["/usr/bin/security", "add-generic-password", "-U"]);
  expect(run.mock.lastCall![2]).not.toHaveProperty("input");
  expect(args).toContain(Buffer.from(big).toString("hex"));
  expect(args).toContain("acct");
  expect(args).toContain("svc");
});

it("test_set_password_raises_on_nonzero", () => {
  mockRun(completed(45, "", "nope"));
  expect(() => macosKeychain.setPassword("svc", "acct", "secret")).toThrow(KeychainError);
});

it("test_set_get_roundtrip_hex_is_decodable", () => {
  const secret = 'token-with "quotes" and \\ backslash and é';
  const run = mockRun(completed(0));
  macosKeychain.setPassword("svc", "acct", secret);
  const stdin = run.mock.lastCall![2].input as string;
  const hexToken = stdin.split("-X ")[1]!.trim();
  expect(Buffer.from(hexToken, "hex").toString("utf8")).toBe(secret);
});

it("test_delete_password_rc0_and_rc44_are_success", () => {
  for (const rc of [0, 44]) {
    mockRun(completed(rc));
    macosKeychain.deletePassword("svc", "acct");
  }
});

it("test_delete_password_raises_on_other_nonzero", () => {
  mockRun(completed(51, "", "locked"));
  expect(() => macosKeychain.deletePassword("svc", "acct")).toThrow(KeychainError);
});

it("test_calls_pass_timeout_to_subprocess", () => {
  const run = mockRun(completed(0, "x\n"));
  macosKeychain.getPassword("svc", "acct");
  expect(run.mock.lastCall![2].timeout).toBe(macosKeychain.TIMEOUT_MS);
});

describe("test_timeout_becomes_keychain_error", () => {
  it.each([
    ["getPassword", () => macosKeychain.getPassword("svc", "acct")],
    ["setPassword", () => macosKeychain.setPassword("svc", "acct", "secret")],
    ["deletePassword", () => macosKeychain.deletePassword("svc", "acct")],
  ])("test_timeout_becomes_keychain_error[%s]", (_name, call) => {
    mockRun(failed("ETIMEDOUT"));
    expect(call).toThrow(KeychainError);
  });
});

it("test_item_exists_stays_false_on_timeout_and_missing_binary", () => {
  mockRun(failed("ETIMEDOUT"));
  expect(macosKeychain.itemExists("svc", "acct")).toBe(false);
  mockRun(failed("ENOENT"));
  expect(macosKeychain.itemExists("svc", "acct")).toBe(false);
});

it("test_keychain_account_name_prefers_user_env", () => {
  vi.stubEnv("USER", "alice");
  expect(macosKeychain.keychainAccountName()).toBe("alice");
});

it("test_keychain_account_name_no_user_env_avoids_legacy_default", () => {
  vi.stubEnv("USER", undefined);
  const name = macosKeychain.keychainAccountName();
  expect(name).toBeTruthy();
  expect(name).not.toBe("user");
});
