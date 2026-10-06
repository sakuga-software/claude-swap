import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, CredentialReadError, TransferError } from "../src/exceptions.js";
import { accountRow } from "../src/json_output.js";
import { Platform } from "../src/models.js";
import { type UsageDict, credentialFingerprint, usageOutcome } from "../src/oauth.js";
import { sessionDirFor } from "../src/session.js";
import { internals as settingsInternals } from "../src/settings.js";
import { jsonDumps } from "../src/support/py.js";
import { ClaudeAccountSwitcher, type SequenceData, internals as switcherInternals } from "../src/switcher.js";
import { exportAccounts, importAccounts, importUsage, internals as transferInternals } from "../src/transfer.js";
import { type Captured, captureOutput } from "./helpers/capture.js";
import { testHome } from "./helpers/home.js";

type Json = Record<string, any>;

const SAMPLE_CREDS = { accessToken: "tok-1", refreshToken: "rtok-1", expiresAt: 9999 };
const SAMPLE_CONFIG = {
  oauthAccount: {
    emailAddress: "user@example.com",
    accountUuid: "acct-uuid",
    organizationUuid: "org-uuid",
    organizationName: "Acme",
  },
};

let capsys: { readouterr(): Captured };

beforeEach(() => {
  capsys = captureOutput();
  switcherInternals.FETCH_STAGGER_S = 0;
});

afterEach(() => {
  switcherInternals.FETCH_STAGGER_S = 0.25;
});

/** A switcher with file-based (Linux) credential storage. */
function linuxSwitcher(): ClaudeAccountSwitcher {
  const s = new ClaudeAccountSwitcher();
  s.platform = Platform.LINUX;
  s.setupDirectories();
  s.initSequenceFile();
  return s;
}

interface SeedOptions {
  orgUuid?: string;
  orgName?: string;
  creds?: Json;
  config?: Json;
  alias?: string;
}

/** Write an account to the backup and to sequence.json. */
function seedAccount(s: ClaudeAccountSwitcher, num: number, email: string, opts: SeedOptions = {}): void {
  const { orgUuid = "", orgName = "", alias } = opts;
  const credsObj = opts.creds ?? { ...SAMPLE_CREDS, _marker: email };
  const configObj = opts.config ?? {
    oauthAccount: { emailAddress: email, accountUuid: `acct-${num}`, organizationUuid: orgUuid, organizationName: orgName },
  };
  s.writeAccountCredentials(String(num), email, jsonDumps(credsObj));
  s.writeAccountConfig(String(num), email, jsonDumps(configObj));

  const data = (s.getSequenceData() ?? {
    activeAccountNumber: null,
    lastUpdated: "",
    sequence: [],
    accounts: {},
  }) as Json;
  data.accounts[String(num)] = {
    email,
    uuid: `acct-${num}`,
    organizationUuid: orgUuid,
    organizationName: orgName,
    added: "2024-01-01T00:00:00Z",
  };
  if (alias) data.accounts[String(num)].alias = alias;
  if (!data.sequence.includes(num)) {
    data.sequence.push(num);
    data.sequence.sort((a: number, b: number) => a - b);
  }
  if (data.activeAccountNumber === null) data.activeAccountNumber = num;
  s.writeJson(s.sequenceFile, data);
}

function seq(s: ClaudeAccountSwitcher): Json {
  return s.getSequenceData() as Json;
}

function readJson(file: string): Json {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Json;
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value));
}

/** A second home beside the test home (Python `temp_home.parent / name`). */
function siblingHome(name: string): string {
  const dir = path.join(testHome(), "..siblings", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Python `patch.dict(os.environ, {"HOME": dir})` around a block. */
async function withHome<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  vi.stubEnv("HOME", dir);
  vi.stubEnv("USERPROFILE", dir);
  try {
    return await fn();
  } finally {
    vi.stubEnv("HOME", testHome());
    vi.stubEnv("USERPROFILE", testHome());
  }
}

function expectThrow(fn: () => unknown, cls: new (...args: any[]) => Error, match: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(cls);
  expect((caught as Error).message).toMatch(match);
}

function rewriteEnvelope(file: string, change: (env: Json) => void): void {
  const env = readJson(file);
  change(env);
  writeJson(file, env);
}

describe("TestRoundTrip", () => {
  it("test_export_import_round_trip", async () => {
    const home = testHome();
    const src = linuxSwitcher();
    seedAccount(src, 1, "alice@example.com", { orgUuid: "org-a", orgName: "Org A" });
    seedAccount(src, 2, "bob@example.com");

    const outFile = path.join(home, "backup.cswap");
    exportAccounts(src, outFile);

    expect(fs.existsSync(outFile)).toBe(true);
    const envelope = readJson(outFile);
    expect(envelope.version).toBe(1);
    expect(envelope.encrypted).toBe(false);
    expect(envelope.accounts).toHaveLength(2);
    expect(new Set(envelope.accounts.map((a: Json) => a.email))).toEqual(
      new Set(["alice@example.com", "bob@example.com"]),
    );

    const dstHome = siblingHome("dst");
    await withHome(dstHome, () => {
      const dst = linuxSwitcher();
      importAccounts(dst, outFile);

      const data = seq(dst);
      expect(data).not.toBeNull();
      expect(new Set(Object.keys(data.accounts))).toEqual(new Set(["1", "2"]));
      expect(data.accounts["1"].email).toBe("alice@example.com");
      expect(data.accounts["1"].organizationUuid).toBe("org-a");

      const credsText = dst.readAccountCredentials("1", "alice@example.com");
      expect(JSON.parse(credsText)._marker).toBe("alice@example.com");
    });
  });

  it("test_active_state_carried_but_not_applied", async () => {
    const home = testHome();
    const src = linuxSwitcher();
    seedAccount(src, 1, "a@example.com");
    seedAccount(src, 2, "b@example.com");
    const data = seq(src);
    data.activeAccountNumber = 2;
    src.writeJson(src.sequenceFile, data);

    const outFile = path.join(home, "backup.cswap");
    exportAccounts(src, outFile);
    expect(readJson(outFile).activeAccountNumber).toBe(2);

    const dstHome = siblingHome("dst");
    await withHome(dstHome, () => {
      const dst = linuxSwitcher();
      seedAccount(dst, 9, "local@example.com");
      const d = seq(dst);
      d.activeAccountNumber = 9;
      dst.writeJson(dst.sequenceFile, d);

      importAccounts(dst, outFile);
      expect(seq(dst).activeAccountNumber).toBe(9);
    });
  });
});

describe("TestAliasTransfer", () => {
  it("test_alias_round_trips", async () => {
    const home = testHome();
    const src = linuxSwitcher();
    seedAccount(src, 1, "alice@example.com", { alias: "dev" });
    seedAccount(src, 2, "bob@example.com");

    const outFile = path.join(home, "backup.cswap");
    exportAccounts(src, outFile);
    const envelope = readJson(outFile);
    const byEmail = Object.fromEntries(envelope.accounts.map((a: Json) => [a.email, a]));
    expect(byEmail["alice@example.com"].alias).toBe("dev");
    expect("alias" in byEmail["bob@example.com"]).toBe(false);

    await withHome(siblingHome("dst"), () => {
      const dst = linuxSwitcher();
      importAccounts(dst, outFile);
      const data = seq(dst);
      expect(data.accounts["1"].alias).toBe("dev");
      expect("alias" in data.accounts["2"]).toBe(false);
    });
  });

  it("test_import_alias_collision_with_local_drops_and_warns", async () => {
    const home = testHome();
    const dstHome = siblingHome("dst");
    const src = linuxSwitcher();
    seedAccount(src, 1, "alice@example.com", { alias: "dev" });
    const outFile = path.join(home, "backup.cswap");
    exportAccounts(src, outFile);

    await withHome(dstHome, () => {
      const dst = linuxSwitcher();
      seedAccount(dst, 9, "existing@example.com", { alias: "dev" });

      importAccounts(dst, outFile);

      const data = seq(dst);
      expect(data.accounts["9"].alias).toBe("dev");
      const importedNum = Object.keys(data.accounts).find((n) => data.accounts[n].email === "alice@example.com")!;
      expect("alias" in data.accounts[importedNum]).toBe(false);
    });
  });

  it("test_import_reexport_of_same_account_keeps_own_alias", async () => {
    const home = testHome();
    const dstHome = siblingHome("dst");
    const src = linuxSwitcher();
    seedAccount(src, 1, "alice@example.com", { alias: "dev" });
    const outFile = path.join(home, "backup.cswap");
    exportAccounts(src, outFile);

    await withHome(dstHome, () => {
      const dst = linuxSwitcher();
      seedAccount(dst, 1, "alice@example.com", { alias: "dev" });

      importAccounts(dst, outFile, true);

      expect(seq(dst).accounts["1"].alias).toBe("dev");
    });
  });

  it("test_import_duplicate_alias_within_export_rejected", async () => {
    const home = testHome();
    const src = linuxSwitcher();
    seedAccount(src, 1, "alice@example.com", { alias: "dev" });
    seedAccount(src, 2, "bob@example.com", { alias: "dev" });
    const outFile = path.join(home, "backup.cswap");
    exportAccounts(src, outFile);
    // Export cannot make a duplicate alias, but a hand-edited file can.
    rewriteEnvelope(outFile, (env) => {
      for (const acc of env.accounts) acc.alias = "dev";
    });

    await withHome(siblingHome("dst"), () => {
      const dst = linuxSwitcher();
      expect(() => importAccounts(dst, outFile)).toThrow(TransferError);
    });
  });

  it("test_import_invalid_alias_format_rejected", async () => {
    const home = testHome();
    const src = linuxSwitcher();
    seedAccount(src, 1, "alice@example.com");
    const outFile = path.join(home, "backup.cswap");
    exportAccounts(src, outFile);
    rewriteEnvelope(outFile, (env) => {
      env.accounts[0].alias = "123";
    });

    await withHome(siblingHome("dst"), () => {
      const dst = linuxSwitcher();
      expect(() => importAccounts(dst, outFile)).toThrow(TransferError);
    });
  });
});

describe("TestSelectiveExport", () => {
  it("test_export_single_by_number", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "a@example.com");
    seedAccount(s, 2, "b@example.com");

    const out = path.join(testHome(), "one.cswap");
    exportAccounts(s, out, "2");
    const envelope = readJson(out);
    expect(envelope.accounts).toHaveLength(1);
    expect(envelope.accounts[0].email).toBe("b@example.com");
  });

  it("test_export_single_by_email", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "a@example.com");
    seedAccount(s, 2, "b@example.com");

    const out = path.join(testHome(), "one.cswap");
    exportAccounts(s, out, "a@example.com");
    expect(readJson(out).accounts[0].email).toBe("a@example.com");
  });

  it("test_export_unknown_number_raises", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "a@example.com");

    expectThrow(() => exportAccounts(s, path.join(testHome(), "x.cswap"), "999"), TransferError, /account not found/);
  });

  it("test_export_no_accounts_raises", () => {
    const s = linuxSwitcher();
    expectThrow(() => exportAccounts(s, path.join(testHome(), "x.cswap")), TransferError, /no accounts to export/);
  });
});

describe("TestConflictPolicy", () => {
  it("test_skip_when_account_exists_without_force", () => {
    const src = linuxSwitcher();
    seedAccount(src, 1, "alice@example.com", { orgUuid: "org-a" });
    const out = path.join(testHome(), "b.cswap");
    exportAccounts(src, out);

    importAccounts(src, out, false);
    expect(capsys.readouterr().err).toContain("Skipped alice@example.com");
    expect(Object.keys(seq(src).accounts)).toEqual(["1"]);
  });

  it("test_force_overwrites_existing_slot_in_place", () => {
    // --force updates the local matching slot (3), not the exported slot (1), and leaves bob at slot 1 alone.
    const s = linuxSwitcher();
    seedAccount(s, 3, "alice@example.com", { orgUuid: "org-a", orgName: "Org A" });
    const out = path.join(testHome(), "alice.cswap");
    exportAccounts(s, out, "3");
    rewriteEnvelope(out, (env) => {
      env.accounts[0].number = 1;
      env.accounts[0].credentials._marker = "ALICE_NEW";
    });

    seedAccount(s, 1, "bob@example.com");
    const bobCredsBefore = s.readAccountCredentials("1", "bob@example.com");

    importAccounts(s, out, true);

    expect(capsys.readouterr().err).toContain("Overwrote alice@example.com (slot 3)");
    expect(JSON.parse(s.readAccountCredentials("3", "alice@example.com"))._marker).toBe("ALICE_NEW");
    expect(s.readAccountCredentials("1", "bob@example.com")).toBe(bobCredsBefore);

    const data = seq(s);
    expect(data.accounts["1"].email).toBe("bob@example.com");
    expect(data.accounts["3"].email).toBe("alice@example.com");
  });

  it("test_import_over_live_login_hints_force_activation", () => {
    const home = testHome();
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com", { orgUuid: "org-a", orgName: "Org A" });
    writeJson(path.join(home, ".claude.json"), {
      oauthAccount: {
        emailAddress: "alice@example.com",
        accountUuid: "acct-1",
        organizationUuid: "org-a",
        organizationName: "Org A",
      },
    });
    writeJson(path.join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "sk-stale-live" } });
    const out = path.join(home, "alice.cswap");
    exportAccounts(s, out);

    importAccounts(s, out, true);

    const err = capsys.readouterr().err;
    expect(err).toContain("alice@example.com is your current live login");
    expect(err).toContain("cswap --switch-to 1 --force");
  });

  it("test_import_without_matching_live_login_prints_no_hint", () => {
    const home = testHome();
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com", { orgUuid: "org-a", orgName: "Org A" });
    writeJson(path.join(home, ".claude.json"), {
      oauthAccount: { emailAddress: "bob@example.com", accountUuid: "acct-bob" },
    });
    const out = path.join(home, "alice.cswap");
    exportAccounts(s, out);

    importAccounts(s, out, true);

    expect(capsys.readouterr().err).not.toContain("current live login");
  });

  it("test_slot_allocation_when_exported_slot_taken", async () => {
    // The exported slot belongs to another account here: allocate max+1, as add_account does.
    const srcHome = siblingHome("src");
    const out = path.join(srcHome, "a.cswap");
    await withHome(srcHome, () => {
      const src = linuxSwitcher();
      seedAccount(src, 1, "alice@example.com");
      exportAccounts(src, out);
    });

    const dst = linuxSwitcher();
    seedAccount(dst, 1, "bob@example.com");

    importAccounts(dst, out);

    const data = seq(dst);
    expect(data.accounts["1"].email).toBe("bob@example.com");
    expect(data.accounts["2"].email).toBe("alice@example.com");
  });
});

describe("TestCrossPlatform", () => {
  it("test_export_macos_keychain_import_linux_files", async () => {
    const macSwitcher = new ClaudeAccountSwitcher();
    macSwitcher.platform = Platform.MACOS;
    macSwitcher.setupDirectories();
    macSwitcher.initSequenceFile();

    seedAccount(macSwitcher, 1, "alice@example.com", { orgUuid: "org-a" });

    const out = path.join(testHome(), "x.cswap");
    exportAccounts(macSwitcher, out);

    await withHome(siblingHome("dst"), () => {
      const dst = linuxSwitcher();
      importAccounts(dst, out);

      expect(fs.existsSync(path.join(dst.credentialsDir, ".creds-1-alice@example.com.enc"))).toBe(true);
    });
  });
});

function makeEnvelope(email = "user@example.com", number: unknown = 1): Json {
  return {
    version: 1,
    exportedAt: "2026-01-01T00:00:00Z",
    exportedFrom: "linux",
    swapVersion: "0.0.0",
    encrypted: false,
    activeAccountNumber: Number.isInteger(number) ? number : null,
    accounts: [
      {
        number,
        email,
        uuid: "u",
        organizationUuid: "",
        organizationName: "",
        added: "2024-01-01T00:00:00Z",
        credentials: SAMPLE_CREDS,
        config: SAMPLE_CONFIG,
      },
    ],
  };
}

describe("TestValidation", () => {
  function importEnvelope(s: ClaudeAccountSwitcher, env: Json, name: string): () => void {
    const f = path.join(testHome(), name);
    writeJson(f, env);
    return () => importAccounts(s, f);
  }

  it("test_path_traversal_email_rejected", () => {
    const s = linuxSwitcher();
    expectThrow(
      importEnvelope(s, makeEnvelope("../../evil"), "evil.cswap"),
      TransferError,
      /invalid or missing email/,
    );
    const parent = path.dirname(testHome());
    for (const dir of [parent, path.dirname(parent)]) {
      expect(fs.existsSync(path.join(dir, ".creds-1-.."))).toBe(false);
    }
  });

  it("test_negative_slot_number_rejected", () => {
    const s = linuxSwitcher();
    expectThrow(importEnvelope(s, makeEnvelope(undefined, -1), "neg.cswap"), TransferError, /invalid slot number/);
  });

  it("test_zero_slot_number_rejected", () => {
    const s = linuxSwitcher();
    expectThrow(importEnvelope(s, makeEnvelope(undefined, 0), "zero.cswap"), TransferError, /invalid slot number/);
  });

  it("test_string_slot_number_rejected", () => {
    const s = linuxSwitcher();
    expectThrow(importEnvelope(s, makeEnvelope(undefined, "../"), "str.cswap"), TransferError, /invalid slot number/);
  });

  it("test_missing_version_rejected", () => {
    const s = linuxSwitcher();
    const env = makeEnvelope();
    delete env.version;
    expectThrow(importEnvelope(s, env, "v.cswap"), TransferError, /unsupported export version/);
  });

  it("test_wrong_version_rejected", () => {
    const s = linuxSwitcher();
    const env = makeEnvelope();
    env.version = 2;
    expectThrow(importEnvelope(s, env, "v.cswap"), TransferError, /unsupported export version/);
  });

  it("test_encrypted_flag_rejected", () => {
    const s = linuxSwitcher();
    const env = makeEnvelope();
    env.encrypted = true;
    expectThrow(importEnvelope(s, env, "e.cswap"), TransferError, /encrypted exports are not supported/);
  });

  it("test_malformed_top_level_json_rejected", () => {
    const s = linuxSwitcher();
    const f = path.join(testHome(), "bad.cswap");
    fs.writeFileSync(f, "{not json");
    expectThrow(() => importAccounts(s, f), TransferError, /not valid JSON/);
  });

  it("test_credentials_garbage_string_rejected", () => {
    // A string credential that is not a key reads as an API-key account and fails as an invalid key.
    const s = linuxSwitcher();
    const env = makeEnvelope();
    env.accounts[0].credentials = "a string";
    expectThrow(importEnvelope(s, env, "c.cswap"), TransferError, /must be a raw sk-ant-api/);
  });

  it("test_credentials_non_object_non_string_rejected", () => {
    const s = linuxSwitcher();
    const env = makeEnvelope();
    env.accounts[0].credentials = [1, 2, 3];
    expectThrow(importEnvelope(s, env, "c.cswap"), TransferError, /must be a JSON object/);
  });

  const fields = ["organizationUuid", "organizationName", "uuid", "added"];
  const badValues: unknown[] = [["a", "b"], { x: 1 }, 42];
  it.each(fields.flatMap((field) => badValues.map((badValue) => [field, badValue] as const)))(
    "test_string_fields_reject_non_string_types[%s-%j]",
    (field, badValue) => {
      const s = linuxSwitcher();
      const env = makeEnvelope();
      env.accounts[0][field] = badValue;
      expectThrow(importEnvelope(s, env, "bad.cswap"), TransferError, new RegExp(`${field} for .* must be a string`));

      const data = s.getSequenceData() as Json | null;
      expect(data === null || Object.keys(data.accounts ?? {}).length === 0).toBe(true);
    },
  );

  it("test_missing_file_rejected", () => {
    const s = linuxSwitcher();
    expectThrow(() => importAccounts(s, path.join(testHome(), "nope.cswap")), TransferError, /not found/);
  });
});

describe("TestPipeMode", () => {
  it("test_export_to_stdout_writes_only_json", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com");
    exportAccounts(s, "-");
    const captured = capsys.readouterr();

    const env = JSON.parse(captured.out) as Json;
    expect(env.version).toBe(1);
    expect(env.accounts[0].email).toBe("alice@example.com");
    expect(captured.err).not.toContain("Exported");
  });

  it("test_import_from_stdin", () => {
    const env = {
      version: 1,
      exportedAt: "2026-01-01T00:00:00Z",
      exportedFrom: "linux",
      swapVersion: "0.0.0",
      encrypted: false,
      activeAccountNumber: 1,
      accounts: [
        {
          number: 1,
          email: "alice@example.com",
          uuid: "u",
          organizationUuid: "",
          organizationName: "",
          added: "2024-01-01T00:00:00Z",
          credentials: SAMPLE_CREDS,
          config: SAMPLE_CONFIG,
        },
      ],
    };
    const s = linuxSwitcher();
    vi.spyOn(transferInternals, "readStdin").mockReturnValue(JSON.stringify(env));
    importAccounts(s, "-");

    expect(seq(s).accounts["1"].email).toBe("alice@example.com");
  });
});

describe("TestEmptyHome", () => {
  it("test_import_into_empty_home_initializes_sequence", async () => {
    const srcHome = siblingHome("src");
    const out = path.join(srcHome, "x.cswap");
    await withHome(srcHome, () => {
      const src = linuxSwitcher();
      seedAccount(src, 1, "alice@example.com");
      exportAccounts(src, out);
    });

    await withHome(siblingHome("empty"), () => {
      const dst = new ClaudeAccountSwitcher();
      dst.platform = Platform.LINUX;
      expect(fs.existsSync(dst.sequenceFile)).toBe(false);

      importAccounts(dst, out);

      expect(fs.existsSync(dst.sequenceFile)).toBe(true);
      expect(seq(dst).accounts["1"].email).toBe("alice@example.com");
    });
  });
});

describe.skipIf(process.platform === "win32")("TestFilePermissions", () => {
  it("test_export_file_is_0600", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com");
    const out = path.join(testHome(), "x.cswap");
    exportAccounts(s, out);

    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
  });

  it("test_export_temp_file_never_created_world_readable", () => {
    // The temp file holds a live refresh token: it must have mode 0600 at creation, even with a permissive umask.
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com");
    const out = path.join(testHome(), "x.cswap");

    const realMkstemp = settingsInternals.mkstemp;
    const modesAtCreation: number[] = [];
    vi.spyOn(settingsInternals, "mkstemp").mockImplementation((dir: string, suffix?: string) => {
      const [fd, p] = realMkstemp(dir, suffix);
      modesAtCreation.push(fs.fstatSync(fd).mode & 0o777);
      return [fd, p];
    });
    const oldUmask = process.umask(0o022);
    try {
      exportAccounts(s, out);
    } finally {
      process.umask(oldUmask);
    }

    expect(modesAtCreation).toEqual([0o600]);
  });
});

function account(number: number, email: string, uuid: string): Json {
  return {
    number,
    email,
    uuid,
    organizationUuid: "",
    organizationName: "",
    added: "2024-01-01T00:00:00Z",
    credentials: SAMPLE_CREDS,
    config: SAMPLE_CONFIG,
  };
}

function envelopeOf(accounts: Json[]): Json {
  return {
    version: 1,
    exportedAt: "2026-01-01T00:00:00Z",
    exportedFrom: "linux",
    swapVersion: "0.0.0",
    encrypted: false,
    activeAccountNumber: 1,
    accounts,
  };
}

describe("TestValidateAllBeforeWrite", () => {
  it("test_malformed_later_account_does_not_partial_write", () => {
    const s = linuxSwitcher();
    const f = path.join(testHome(), "bad.cswap");
    writeJson(f, envelopeOf([account(1, "alice@example.com", "u1"), account(2, "../../evil", "u2")]));

    expectThrow(() => importAccounts(s, f), TransferError, /invalid or missing email/);

    const data = s.getSequenceData() as Json;
    expect(data).not.toBeNull();
    expect(data.accounts ?? {}).toEqual({});
    expect(fs.readdirSync(s.credentialsDir).filter((n) => n.includes("alice"))).toEqual([]);
    expect(fs.readdirSync(s.configsDir).filter((n) => n.includes("alice"))).toEqual([]);
  });

  it("test_duplicate_account_in_export_rejected", () => {
    const s = linuxSwitcher();
    const f = path.join(testHome(), "dup.cswap");
    writeJson(f, envelopeOf([account(1, "alice@example.com", "u1"), account(2, "alice@example.com", "u1")]));
    expectThrow(() => importAccounts(s, f), TransferError, /duplicate account/);
  });
});

describe("TestCleanHomeActivation", () => {
  // After an import on a fresh machine, switch_to / switch must activate the
  // imported account even though no Claude Code session has logged in.

  async function seedAndExport(srcHome: string): Promise<string> {
    return withHome(srcHome, () => {
      const src = linuxSwitcher();
      seedAccount(src, 1, "alice@example.com");
      seedAccount(src, 2, "bob@example.com");
      const data = seq(src);
      data.activeAccountNumber = 2;
      src.writeJson(src.sequenceFile, data);
      const out = path.join(srcHome, "backup.cswap");
      exportAccounts(src, out);
      return out;
    });
  }

  it("test_switch_to_after_import_activates_target", async () => {
    const exportPath = await seedAndExport(siblingHome("src"));
    const dstHome = siblingHome("dst");
    await withHome(dstHome, async () => {
      const dst = linuxSwitcher();
      importAccounts(dst, exportPath);

      const configPath = dst.getClaudeConfigPath();
      expect(fs.existsSync(configPath)).toBe(false);

      vi.spyOn(dst, "listAccounts").mockResolvedValue(null);
      await dst.switchTo("1");

      expect(fs.existsSync(configPath)).toBe(true);
      expect(readJson(configPath).oauthAccount.emailAddress).toBe("alice@example.com");

      const liveCredsPath = path.join(dstHome, ".claude", ".credentials.json");
      expect(fs.existsSync(liveCredsPath)).toBe(true);
      expect(readJson(liveCredsPath)._marker).toBe("alice@example.com");

      expect(seq(dst).activeAccountNumber).toBe(1);
    });
  });

  it("test_switch_rotate_after_import_uses_active_from_envelope", async () => {
    const exportPath = await seedAndExport(siblingHome("src"));
    await withHome(siblingHome("dst"), async () => {
      const dst = linuxSwitcher();
      importAccounts(dst, exportPath);

      expect(seq(dst).activeAccountNumber).toBe(2);

      const configPath = dst.getClaudeConfigPath();
      expect(fs.existsSync(configPath)).toBe(false);

      vi.spyOn(dst, "listAccounts").mockResolvedValue(null);
      await dst.switch();

      expect(readJson(configPath).oauthAccount.emailAddress).toBe("bob@example.com");
      expect(seq(dst).activeAccountNumber).toBe(2);
    });
  });

  it("test_import_preserves_existing_active_account", async () => {
    const exportPath = await seedAndExport(siblingHome("src"));

    const dst = linuxSwitcher();
    seedAccount(dst, 5, "local@example.com");
    const data = seq(dst);
    data.activeAccountNumber = 5;
    dst.writeJson(dst.sequenceFile, data);

    importAccounts(dst, exportPath);

    expect(seq(dst).activeAccountNumber).toBe(5);
  });

  it("test_active_seeded_to_resolved_slot_not_envelope_slot", async () => {
    // An unrelated local account holds the envelope's active slot number, so
    // the active account goes to another slot. activeAccountNumber must follow it.
    const exportPath = await seedAndExport(siblingHome("src"));

    const dst = linuxSwitcher();
    seedAccount(dst, 2, "local@example.com");
    const data = seq(dst);
    data.activeAccountNumber = null;
    dst.writeJson(dst.sequenceFile, data);

    importAccounts(dst, exportPath);

    const final = seq(dst);
    expect(final.accounts["2"].email).toBe("local@example.com");
    const bobSlot = Object.keys(final.accounts).find((n) => final.accounts[n].email === "bob@example.com")!;
    expect(bobSlot).not.toBe("2");
    expect(final.activeAccountNumber).toBe(Number(bobSlot));
  });

  it("test_clean_switch_preserves_existing_local_config", async () => {
    const exportPath = await seedAndExport(siblingHome("src"));
    await withHome(siblingHome("dst"), async () => {
      const dst = linuxSwitcher();
      const configPath = dst.getClaudeConfigPath();
      writeJson(configPath, {
        tipsHistory: { shown: ["welcome"] },
        projects: { "/path/to/project": { mcpServers: { memory: { type: "stdio" } } } },
        userID: "local-user-id",
        numStartups: 42,
      });

      importAccounts(dst, exportPath);

      vi.spyOn(dst, "listAccounts").mockResolvedValue(null);
      await dst.switchTo("1");

      const merged = readJson(configPath);
      expect(merged.tipsHistory).toEqual({ shown: ["welcome"] });
      expect(merged.projects["/path/to/project"].mcpServers).toEqual({ memory: { type: "stdio" } });
      expect(merged.userID).toBe("local-user-id");
      expect(merged.numStartups).toBe(42);
      expect(merged.oauthAccount.emailAddress).toBe("alice@example.com");
    });
  });

  it("test_clean_switch_fallback_when_local_config_malformed", async () => {
    const exportPath = await seedAndExport(siblingHome("src"));
    await withHome(siblingHome("dst"), async () => {
      const dst = linuxSwitcher();
      const configPath = dst.getClaudeConfigPath();
      fs.writeFileSync(configPath, "{not valid json");

      importAccounts(dst, exportPath);

      vi.spyOn(dst, "listAccounts").mockResolvedValue(null);
      await dst.switchTo("1");

      expect(readJson(configPath).oauthAccount.emailAddress).toBe("alice@example.com");
    });
  });

  it("test_a_valid_empty_config_is_spliced_not_called_unparseable", async () => {
    // A valid but empty `{}` config is readable: the switch must splice it, not salvage it as unparseable.
    const exportPath = await seedAndExport(siblingHome("src"));
    await withHome(siblingHome("dst"), async () => {
      const dst = linuxSwitcher();
      const configPath = dst.getClaudeConfigPath();
      fs.writeFileSync(configPath, "{}");

      importAccounts(dst, exportPath);
      vi.spyOn(dst, "listAccounts").mockResolvedValue(null);
      await dst.switchTo("1");

      expect(readJson(configPath).oauthAccount.emailAddress).toBe("alice@example.com");
      expect(fs.readdirSync(path.dirname(configPath)).filter((n) => n.includes(".unreadable-"))).toEqual([]);
    });
  });

  it("test_active_seeded_when_envelope_active_was_skipped", async () => {
    // The envelope's active account exists locally and is skipped: seed activeAccountNumber to its local slot.
    const exportPath = await seedAndExport(siblingHome("src"));

    const dst = linuxSwitcher();
    seedAccount(dst, 7, "bob@example.com");
    const data = seq(dst);
    data.activeAccountNumber = null;
    dst.writeJson(dst.sequenceFile, data);

    importAccounts(dst, exportPath);

    const final = seq(dst);
    expect(final.accounts["7"].email).toBe("bob@example.com");
    expect(final.activeAccountNumber).toBe(7);
  });
});

const BLOATED_CONFIG = {
  oauthAccount: {
    emailAddress: "alice@example.com",
    accountUuid: "acct-uuid",
    organizationUuid: "org-a",
    organizationName: "Acme",
  },
  userID: "host-machine-identity",
  anonymousId: "anon-host-id",
  projects: { "/Users/host/repo": {} },
  tipsHistory: { welcome: 1, "shift-enter": 5 },
  cachedGrowthBookFeatures: { "flag-a": true, "flag-b": false },
  appleTerminalBackupPath: "/Users/host/Library/Preferences/x.plist.bak",
  numStartups: 42,
};

describe("TestSlimVsFullConfig", () => {
  it("test_default_export_strips_non_oauth_keys", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com", { orgUuid: "org-a", config: BLOATED_CONFIG });

    const out = path.join(testHome(), "slim.cswap");
    exportAccounts(s, out);
    const cfg = readJson(out).accounts[0].config;
    expect(Object.keys(cfg)).toEqual(["oauthAccount"]);
    expect(cfg.oauthAccount.emailAddress).toBe("alice@example.com");
    for (const leaked of ["userID", "anonymousId", "projects", "appleTerminalBackupPath"]) {
      expect(leaked in cfg).toBe(false);
    }
  });

  it("test_full_export_preserves_all_keys", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com", { orgUuid: "org-a", config: BLOATED_CONFIG });

    const out = path.join(testHome(), "full.cswap");
    exportAccounts(s, out, null, true);
    expect(readJson(out).accounts[0].config).toEqual(BLOATED_CONFIG);
  });

  it("test_export_missing_oauthAccount_raises", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com", { config: { projects: {}, userID: "x" } });

    expectThrow(() => exportAccounts(s, path.join(testHome(), "x.cswap")), TransferError, /missing oauthAccount/);
  });

  it("test_slim_export_round_trip_to_fresh_machine", async () => {
    const srcHome = siblingHome("src");
    const exportPath = path.join(srcHome, "x.cswap");
    await withHome(srcHome, () => {
      const src = linuxSwitcher();
      seedAccount(src, 1, "alice@example.com", { orgUuid: "org-a", config: BLOATED_CONFIG });
      exportAccounts(src, exportPath);
    });

    await withHome(siblingHome("dst"), async () => {
      const dst = linuxSwitcher();
      importAccounts(dst, exportPath);

      vi.spyOn(dst, "listAccounts").mockResolvedValue(null);
      await dst.switchTo("1");

      const live = readJson(dst.getClaudeConfigPath());
      expect(live.oauthAccount.emailAddress).toBe("alice@example.com");
      expect(live.userID).not.toBe("host-machine-identity");
      expect(live.anonymousId).not.toBe("anon-host-id");
      expect("appleTerminalBackupPath" in live).toBe(false);
    });
  });
});

describe("TestSlimVsFullCredentials", () => {
  // #135: a default export carries only the login of the account, not the
  // machine-shared MCP/plugin OAuth state or the device-bound token.
  const SIBLINGED_CREDS = {
    claudeAiOauth: { accessToken: "sk-live", refreshToken: "rt-live" },
    mcpOAuth: { linear: { refreshToken: "mcp-rt" } },
    trustedDeviceToken: "device-token-a",
    someFutureField: { value: 1 },
  };

  it("test_default_export_keeps_only_claude_ai_oauth", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com", { orgUuid: "org-a", creds: SIBLINGED_CREDS });

    const out = path.join(testHome(), "slim.cswap");
    exportAccounts(s, out);
    expect(readJson(out).accounts[0].credentials).toEqual({
      claudeAiOauth: { accessToken: "sk-live", refreshToken: "rt-live" },
    });
  });

  it("test_full_export_keeps_entire_credential_object", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com", { orgUuid: "org-a", creds: SIBLINGED_CREDS });

    const out = path.join(testHome(), "full.cswap");
    exportAccounts(s, out, null, true);
    expect(readJson(out).accounts[0].credentials).toEqual(SIBLINGED_CREDS);
  });

  it("test_legacy_shape_without_claude_ai_oauth_exports_verbatim", () => {
    const legacy = { accessToken: "tok-legacy", refreshToken: "rt-legacy" };
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com", { orgUuid: "org-a", creds: legacy });

    const out = path.join(testHome(), "legacy.cswap");
    exportAccounts(s, out);
    expect(readJson(out).accounts[0].credentials).toEqual(legacy);
  });
});

describe("TestExportSkipsBrokenSlots", () => {
  // Issue #41: an all-accounts export skips a broken slot with a warning. An explicit --account still fails.

  function breakCredentials(s: ClaudeAccountSwitcher, num: number, email: string): void {
    fs.rmSync(path.join(s.credentialsDir, `.creds-${num}-${email}.enc`), { force: true });
  }

  function breakConfig(s: ClaudeAccountSwitcher, num: number, email: string): void {
    fs.rmSync(path.join(s.configsDir, `.claude-config-${num}-${email}.json`), { force: true });
  }

  it("test_all_accounts_skips_missing_credentials_with_stderr_warning", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com");
    seedAccount(s, 2, "bob@example.com");
    breakCredentials(s, 1, "alice@example.com");

    const out = path.join(testHome(), "backup.cswap");
    exportAccounts(s, out);

    expect(readJson(out).accounts.map((a: Json) => a.email)).toEqual(["bob@example.com"]);

    const captured = capsys.readouterr();
    expect(captured.err).toContain("Skipping Account-1");
    expect(captured.err).toContain("alice@example.com");
    expect(captured.out).not.toContain("Skipping Account-1");
  });

  it("test_all_accounts_skips_missing_config_with_stderr_warning", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com");
    seedAccount(s, 2, "bob@example.com");
    breakConfig(s, 1, "alice@example.com");

    const out = path.join(testHome(), "backup.cswap");
    exportAccounts(s, out);

    expect(readJson(out).accounts.map((a: Json) => a.email)).toEqual(["bob@example.com"]);
    expect(capsys.readouterr().err).toContain("Skipping Account-1");
  });

  it("test_explicit_account_with_missing_credentials_hard_fails", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com");
    seedAccount(s, 2, "bob@example.com");
    breakCredentials(s, 1, "alice@example.com");

    expectThrow(
      () => exportAccounts(s, path.join(testHome(), "x.cswap"), "1"),
      CredentialReadError,
      /no backup credentials/,
    );
  });

  it("test_explicit_account_with_missing_config_hard_fails", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com");
    seedAccount(s, 2, "bob@example.com");
    breakConfig(s, 1, "alice@example.com");

    expectThrow(() => exportAccounts(s, path.join(testHome(), "x.cswap"), "1"), ConfigError, /no backup config/);
  });

  it("test_all_slots_broken_raises_transfer_error", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com");
    seedAccount(s, 2, "bob@example.com");
    breakCredentials(s, 1, "alice@example.com");
    breakCredentials(s, 2, "bob@example.com");

    expectThrow(() => exportAccounts(s, path.join(testHome(), "x.cswap")), TransferError, /no exportable accounts/);
  });

  it("test_skipped_active_slot_clears_envelope_active", () => {
    // The skipped slot is the recorded active one: the envelope must not name it as active.
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com");
    seedAccount(s, 2, "bob@example.com");

    const data = seq(s);
    data.activeAccountNumber = 1;
    s.writeJson(s.sequenceFile, data);
    breakCredentials(s, 1, "alice@example.com");

    const out = path.join(testHome(), "backup.cswap");
    exportAccounts(s, out);

    const envelope = readJson(out);
    expect(envelope.accounts.map((a: Json) => a.email)).toEqual(["bob@example.com"]);
    expect(envelope.activeAccountNumber).toBeNull();
  });

  it("test_stdout_pipe_mode_keeps_stdout_pure_json", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com");
    seedAccount(s, 2, "bob@example.com");
    breakCredentials(s, 1, "alice@example.com");

    exportAccounts(s, "-");
    const captured = capsys.readouterr();

    expect((JSON.parse(captured.out) as Json).accounts.map((a: Json) => a.email)).toEqual(["bob@example.com"]);
    expect(captured.err).toContain("Skipping Account-1");
  });
});

describe("TestImportSessionInvalidation", () => {
  function reexportWithMarker(s: ClaudeAccountSwitcher): string {
    const out = path.join(testHome(), "alice.cswap");
    exportAccounts(s, out, "1");
    rewriteEnvelope(out, (env) => {
      env.accounts[0].credentials._marker = "NEW";
    });
    return out;
  }

  it("test_force_overwrite_invalidates_session_credentials", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com", { orgUuid: "org-a" });
    const out = reexportWithMarker(s);

    const sessionDir = sessionDirFor(s.backupDir, "1", "alice@example.com");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".credentials.json"), "pre-import creds");
    fs.writeFileSync(path.join(sessionDir, ".claude.json"), '{"projects": {}}');

    importAccounts(s, out, true);

    expect(fs.existsSync(path.join(sessionDir, ".credentials.json"))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, ".claude.json"))).toBe(true);
  });

  it("test_force_overwrite_warns_but_keeps_live_session", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com", { orgUuid: "org-a" });
    const out = reexportWithMarker(s);

    const sessionDir = sessionDirFor(s.backupDir, "1", "alice@example.com");
    const pidDir = path.join(sessionDir, "sessions");
    fs.mkdirSync(pidDir, { recursive: true });
    writeJson(path.join(pidDir, `${process.pid}.json`), { pid: process.pid });
    fs.writeFileSync(path.join(sessionDir, ".credentials.json"), "pre-import creds");

    importAccounts(s, out, true);

    expect(capsys.readouterr().err).toContain("live");
    expect(fs.readFileSync(path.join(sessionDir, ".credentials.json"), "utf8")).toBe("pre-import creds");
    expect(JSON.parse(s.readAccountCredentials("1", "alice@example.com"))._marker).toBe("NEW");
  });
});

describe("TestImportClearsDeadTokenQuarantine", () => {
  // The import must lift the dead-token quarantine so the imported credential
  // gets a new test (issues #136, #138). The checks read the verdict, not fetch eligibility.

  it("test_import_force_lifts_quarantine", () => {
    const s = linuxSwitcher();
    seedAccount(s, 2, "bob@example.com");
    const ident = { "2": ["bob@example.com", ""] as [string, string] };
    s.usageStore.record({ "2": { error: "invalid_grant" } }, ident);
    expect(s.usageStore.entries(ident)["2"]!.tokenDead()).toBe(true);

    const out = path.join(testHome(), "bob.cswap");
    exportAccounts(s, out, "2");
    rewriteEnvelope(out, (env) => {
      env.accounts[0].credentials._marker = "BOB_NEW";
    });

    importAccounts(s, out, true);

    const entry = s.usageStore.entries(ident)["2"]!;
    expect(entry.tokenDead()).toBe(false);
    expect(entry.authDeadStrikes).toBe(0);
    expect(JSON.parse(s.readAccountCredentials("2", "bob@example.com"))._marker).toBe("BOB_NEW");
  });

  it("test_force_import_of_the_byte_identical_struck_generation_lifts_the_quarantine", () => {
    // The strike is bound to the fingerprint of the generation that the import
    // brings back, so only the explicit `clearDeadToken` call lifts it (issue #218).
    const s = linuxSwitcher();
    seedAccount(s, 2, "bob@example.com");
    const ident = { "2": ["bob@example.com", ""] as [string, string] };
    const fp = credentialFingerprint(s.readAccountCredentials("2", "bob@example.com"));
    s.usageStore.record({ "2": { error: "invalid_grant", struckFp: fp } }, ident);
    let entry = s.usageStore.entries(ident)["2"]!;
    expect(entry.struckFingerprint).toBe(fp);
    expect(entry.tokenDead(undefined, fp)).toBe(true);

    const out = path.join(testHome(), "bob.cswap");
    exportAccounts(s, out, "2");
    importAccounts(s, out, true);

    entry = s.usageStore.entries(ident)["2"]!;
    expect(entry.authDeadStrikes).toBe(0);
    expect(entry.struckFingerprint).toBeNull();
    expect(entry.tokenDead(undefined, fp)).toBe(false);
  });

  it("test_reimport_after_removal_lifts_orphan_quarantine", () => {
    // Removal does not prune usage.json: a plain re-import into the same slot must still clear the orphan row.
    const s = linuxSwitcher();
    seedAccount(s, 2, "bob@example.com");
    const ident = { "2": ["bob@example.com", ""] as [string, string] };
    s.usageStore.record({ "2": { error: "invalid_grant" } }, ident);
    expect(s.usageStore.entries(ident)["2"]!.tokenDead()).toBe(true);

    const out = path.join(testHome(), "bob.cswap");
    exportAccounts(s, out, "2");

    const data = seq(s);
    delete data.accounts["2"];
    data.sequence = data.sequence.filter((n: number) => n !== 2);
    s.writeJson(s.sequenceFile, data);

    expect(s.usageStore.entries(ident)["2"]!.tokenDead()).toBe(true);

    importAccounts(s, out, false);

    expect(capsys.readouterr().err).toContain("Imported bob@example.com");
    const entry = s.usageStore.entries(ident)["2"]!;
    expect(entry.tokenDead()).toBe(false);
    expect(entry.authDeadStrikes).toBe(0);
  });

  it("test_plain_import_replaces_quarantined_slot", () => {
    // Narrow auto-heal (issue #136): a plain import replaces a slot only if its own row is quarantined.
    const s = linuxSwitcher();
    seedAccount(s, 2, "bob@example.com");
    const ident = { "2": ["bob@example.com", ""] as [string, string] };
    s.usageStore.record({ "2": { error: "invalid_grant" } }, ident);
    expect(s.usageStore.entries(ident)["2"]!.tokenDead()).toBe(true);

    const out = path.join(testHome(), "bob.cswap");
    exportAccounts(s, out, "2");
    rewriteEnvelope(out, (env) => {
      env.accounts[0].credentials._marker = "BOB_HEALED";
    });

    importAccounts(s, out, false);

    const err = capsys.readouterr().err;
    expect(err).toContain("Replaced bob@example.com (slot 2 was quarantined: refresh token dead)");
    expect(err).toContain("1 replaced (dead token)");
    const entry = s.usageStore.entries(ident)["2"]!;
    expect(entry.tokenDead()).toBe(false);
    expect(entry.authDeadStrikes).toBe(0);
    expect(JSON.parse(s.readAccountCredentials("2", "bob@example.com"))._marker).toBe("BOB_HEALED");
  });

  it("test_a_healed_strike_does_not_license_a_plain_import_to_replace", () => {
    // The import must ask `slotTokenDead`, not the unbound `tokenDead()`: a
    // strike bound to a generation that the slot no longer stores is healed.
    const s = linuxSwitcher();
    seedAccount(s, 2, "bob@example.com");
    const ident = { "2": ["bob@example.com", ""] as [string, string] };
    s.usageStore.record({ "2": { error: "invalid_grant", struckFp: "sha256:someothergeneration" } }, ident);
    expect(s.usageStore.entries(ident)["2"]!.tokenDead()).toBe(true);
    const stored = s.readAccountCredentials("2", "bob@example.com");
    expect(s.usageStore.entries(ident)["2"]!.tokenDead(undefined, credentialFingerprint(stored))).toBe(false);
    expect(s.slotTokenDead("2", "bob@example.com")).toBe(false);

    const out = path.join(testHome(), "bob.cswap");
    exportAccounts(s, out, "2");
    rewriteEnvelope(out, (env) => {
      env.accounts[0].credentials._marker = "BOB_OVERWRITTEN";
    });

    importAccounts(s, out, false);

    expect(capsys.readouterr().err).toContain("already exists, use --force");
    expect(JSON.parse(s.readAccountCredentials("2", "bob@example.com"))._marker).not.toBe("BOB_OVERWRITTEN");
  });

  it("test_the_heal_finds_the_row_of_an_org_scoped_account", () => {
    // The row lookup must use the organizationUuid of the slot: an empty one matches no org-scoped row.
    const s = linuxSwitcher();
    const ORG = "org-uuid-1234";
    seedAccount(s, 2, "bob@example.com", { orgUuid: ORG });
    const ident = { "2": ["bob@example.com", ORG] as [string, string] };
    s.usageStore.record({ "2": { error: "invalid_grant" } }, ident);
    expect(s.usageStore.entries(ident)["2"]!.tokenDead()).toBe(true);

    expect(s.slotTokenDead("2", "bob@example.com")).toBe(true);
  });

  it("test_import_heals_an_active_slot_struck_on_its_live_generation", () => {
    // An active slot has two stored sources, the live credential and the
    // backup. A strike on the live generation must also trigger the heal.
    const s = linuxSwitcher();
    seedAccount(s, 2, "bob@example.com");
    const ident = { "2": ["bob@example.com", ""] as [string, string] };

    const live = jsonDumps({ claudeAiOauth: { accessToken: "sk-live", refreshToken: "rt-live", expiresAt: 9999999999000 } });
    const newerBackup = jsonDumps({
      claudeAiOauth: { accessToken: "sk-bk", refreshToken: "rt-bk", expiresAt: 9999999999000 },
    });
    const cfg = s.getClaudeConfigPath();
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    s.writeJson(cfg, {
      oauthAccount: {
        emailAddress: "bob@example.com",
        accountUuid: "acct-2",
        organizationUuid: "",
        organizationName: "",
      },
    });
    s.store.writeActiveCredentialsFile(live);
    s.writeAccountCredentials("2", "bob@example.com", newerBackup);
    s.usageStore.record({ "2": { error: "invalid_grant", struckFp: credentialFingerprint(live) } }, ident);

    const out = path.join(testHome(), "bob.cswap");
    exportAccounts(s, out, "2");
    rewriteEnvelope(out, (env) => {
      env.accounts[0].credentials._marker = "BOB_HEALED";
    });

    expect(s.currentAccountNumber()).toBe("2");
    expect(s.slotTokenDead("2", "bob@example.com")).toBe(true);

    importAccounts(s, out, false);

    expect(capsys.readouterr().err).toContain("was quarantined: refresh token dead");
  });

  it("test_plain_import_skips_healthy_slot", () => {
    const s = linuxSwitcher();
    seedAccount(s, 2, "bob@example.com");
    const out = path.join(testHome(), "bob.cswap");
    exportAccounts(s, out, "2");
    rewriteEnvelope(out, (env) => {
      env.accounts[0].credentials._marker = "BOB_NEW";
    });

    importAccounts(s, out, false);

    const err = capsys.readouterr().err;
    expect(err).toContain("Skipped bob@example.com");
    expect(err).not.toContain("Replaced");
    expect(err).not.toContain("replaced (dead token)");
    expect(JSON.parse(s.readAccountCredentials("2", "bob@example.com"))._marker).toBe("bob@example.com");
  });

  it("test_plain_import_ignores_foreign_dead_row_on_slot", () => {
    // The heal is identity-guarded: a dead row of a previous occupant must not trigger it.
    const s = linuxSwitcher();
    seedAccount(s, 2, "bob@example.com");
    s.usageStore.record({ "2": { error: "invalid_grant" } }, { "2": ["alice@example.com", ""] });
    expect(s.usageStore.entries({ "2": ["bob@example.com", ""] })["2"]!.tokenDead()).toBe(false);

    const out = path.join(testHome(), "bob.cswap");
    exportAccounts(s, out, "2");
    rewriteEnvelope(out, (env) => {
      env.accounts[0].credentials._marker = "BOB_NEW";
    });

    importAccounts(s, out, false);

    const err = capsys.readouterr().err;
    expect(err).toContain("Skipped bob@example.com");
    expect(err).not.toContain("Replaced");
    expect(JSON.parse(s.readAccountCredentials("2", "bob@example.com"))._marker).toBe("bob@example.com");
  });

  it("test_plain_import_heal_warns_about_live_session", () => {
    // The heal rewrites the stored credential as --force does, so it gives the same live-session warning.
    const s = linuxSwitcher();
    seedAccount(s, 2, "bob@example.com");
    const ident = { "2": ["bob@example.com", ""] as [string, string] };
    s.usageStore.record({ "2": { error: "invalid_grant" } }, ident);

    const out = path.join(testHome(), "bob.cswap");
    exportAccounts(s, out, "2");

    const sessionDir = sessionDirFor(s.backupDir, "2", "bob@example.com");
    const pidDir = path.join(sessionDir, "sessions");
    fs.mkdirSync(pidDir, { recursive: true });
    writeJson(path.join(pidDir, `${process.pid}.json`), { pid: process.pid });
    fs.writeFileSync(path.join(sessionDir, ".credentials.json"), "pre-import creds");

    importAccounts(s, out, false);

    const err = capsys.readouterr().err;
    expect(err).toContain("live");
    expect(err).toContain("Replaced bob@example.com");
    expect(fs.readFileSync(path.join(sessionDir, ".credentials.json"), "utf8")).toBe("pre-import creds");
    expect(s.usageStore.entries(ident)["2"]!.tokenDead()).toBe(false);
  });

  it("test_fresh_slot_import_creates_no_quarantine", async () => {
    const src = linuxSwitcher();
    seedAccount(src, 2, "bob@example.com");
    const out = path.join(testHome(), "bob.cswap");
    exportAccounts(src, out, "2");

    await withHome(siblingHome("dst_fresh"), () => {
      const dst = linuxSwitcher();
      importAccounts(dst, out);

      const data = seq(dst);
      const slot = Object.keys(data.accounts).find((n) => data.accounts[n].email === "bob@example.com")!;
      const entry = dst.usageStore.entries({ [slot]: ["bob@example.com", ""] })[slot]!;
      expect(entry.tokenDead()).toBe(false);
      expect(entry.authDeadStrikes).toBe(0);
    });
  });
});

describe("TestForceOverwriteNarratesTheStrikeClear", () => {
  // A forced overwrite of a struck slot must say that it cleared the strike,
  // and say so again if the import brings back the condemned generation (issue #218).

  function strikeStoredGeneration(s: ClaudeAccountSwitcher, error = "invalid_grant"): void {
    const fp = credentialFingerprint(s.readAccountCredentials("2", "bob@example.com"));
    s.usageStore.record({ "2": { error, struckFp: fp } }, { "2": ["bob@example.com", ""] });
  }

  it("test_force_overwrite_names_the_same_condemned_generation", () => {
    const s = linuxSwitcher();
    seedAccount(s, 2, "bob@example.com");
    strikeStoredGeneration(s);

    const out = path.join(testHome(), "bob.cswap");
    exportAccounts(s, out, "2");
    importAccounts(s, out, true);

    const err = capsys.readouterr().err;
    expect(err).toContain("Overwrote bob@example.com (slot 2)");
    expect(err).toContain("cleared this slot's stored dead-token strike");
    expect(err).toContain("same credential generation");
  });

  it("test_force_overwrite_with_a_newer_generation_omits_the_generation_note", () => {
    const s = linuxSwitcher();
    seedAccount(s, 2, "bob@example.com");
    strikeStoredGeneration(s);

    const out = path.join(testHome(), "bob.cswap");
    exportAccounts(s, out, "2");
    rewriteEnvelope(out, (env) => {
      env.accounts[0].credentials.refreshToken = "rtok-2-rotated";
    });
    importAccounts(s, out, true);

    const err = capsys.readouterr().err;
    expect(err).toContain("cleared this slot's stored dead-token strike");
    expect(err).not.toContain("same credential generation");
  });

  it("test_force_overwrite_narrates_only_the_struck_account", () => {
    const s = linuxSwitcher();
    seedAccount(s, 2, "bob@example.com");
    seedAccount(s, 3, "carol@example.com");
    s.usageStore.record({ "2": { error: "invalid_grant" } }, { "2": ["bob@example.com", ""] });

    const out = path.join(testHome(), "both.cswap");
    exportAccounts(s, out);
    importAccounts(s, out, true);

    const err = capsys.readouterr().err;
    expect(err).toContain("Overwrote bob@example.com (slot 2)");
    expect(err).toContain("Overwrote carol@example.com (slot 3)");
    expect(err.split("cleared this slot's stored dead-token strike").length - 1).toBe(1);
  });

  it("test_force_overwrite_narrates_a_condemned_generation_without_a_refresh_token", () => {
    // A no_refresh_token strike binds to the content hash. The note must use the generic wording.
    const s = linuxSwitcher();
    seedAccount(s, 2, "bob@example.com", { creds: { accessToken: "tok-1", expiresAt: 9999 } });
    const fp = credentialFingerprint(s.readAccountCredentials("2", "bob@example.com"));
    expect(fp !== null && fp.startsWith("sha256-full:")).toBe(true);
    s.usageStore.record({ "2": { error: "no_refresh_token", struckFp: fp } }, { "2": ["bob@example.com", ""] });

    const out = path.join(testHome(), "bob.cswap");
    exportAccounts(s, out, "2");
    importAccounts(s, out, true);

    const err = capsys.readouterr().err;
    expect(err).toContain("cleared this slot's stored dead-token strike");
    expect(err).toContain("same credential generation");
    expect(err).not.toContain("invalid_grant");
    expect(err).not.toContain("refresh-token generation");
  });
});

/**
 * A backup whose token is valid (far-future expiry), so the usage request
 * (replaced) runs without a refresh. Distinct per account: two slots with one
 * credential read as a duplicate login.
 */
function liveCreds(tag: string): Json {
  return { claudeAiOauth: { accessToken: `tok-${tag}`, refreshToken: `rtok-${tag}`, expiresAt: 4_102_444_800_000 } };
}

/** An account row as `cswap list --json` of another machine prints it. Slot 9: rows match by identity, never by slot. */
function usageRow(email: string, orgUuid = "", pct = 42.0, ageS = 30.0): Json {
  return accountRow(
    9,
    email,
    "",
    orgUuid,
    false,
    { five_hour: { pct, resets_at: "2099-01-01T00:00:00+00:00" } } as UsageDict,
    { usageFetchedAt: Date.now() / 1000 - ageS, usageAgeS: ageS },
  ) as Json;
}

function usageDocument(...rows: Json[]): string {
  return JSON.stringify({ schemaVersion: 1, activeAccountNumber: null, accounts: rows });
}

describe("TestImportUsage", () => {
  function doImport(s: ClaudeAccountSwitcher, document: string, holdS: number | null = null): void {
    const file = path.join(testHome(), "usage.json");
    fs.writeFileSync(file, document, "utf8");
    importUsage(s, file, holdS);
  }

  it("test_rows_are_matched_by_identity", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com", { orgUuid: "org-a" });
    seedAccount(s, 2, "bob@example.com");
    const unavailable = {
      email: "alice@example.com",
      organizationUuid: "org-a",
      usageStatus: "unavailable",
      usage: null,
    };
    doImport(
      s,
      usageDocument(usageRow("bob@example.com", "", 42.0), usageRow("stranger@example.com"), unavailable),
    );

    const entries = s.usageStore.entries({ "1": ["alice@example.com", "org-a"], "2": ["bob@example.com", ""] });
    expect(entries["2"]!.lastGood!.five_hour!.pct).toBe(42.0);
    expect(Math.abs(entries["2"]!.ageS! - 30.0)).toBeLessThanOrEqual(5);
    expect(entries["1"]!.lastGood).toBeNull();
    const err = capsys.readouterr().err;
    expect(err).toContain("Adopted usage for bob@example.com → slot 2");
    expect(err).toContain("Done: 1 adopted, 0 kept, 2 skipped");
  });

  it("test_a_held_account_is_not_fetched", async () => {
    // Through the real collector: the held account is served from the adopted reading, the other one is fetched.
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com", { creds: liveCreds("alice") });
    seedAccount(s, 2, "bob@example.com", { creds: liveCreds("bob") });
    doImport(s, usageDocument(usageRow("bob@example.com", "", 42.0, 400.0)), 600.0);

    const fetched: string[] = [];
    vi.spyOn(switcherInternals, "tryFetchUsageForAccount").mockImplementation(async (_num, email) => {
      fetched.push(email);
      return usageOutcome({ five_hour: { pct: 1.0 } });
    });
    const payload = (await s.listAccounts(false, true)) as Json;

    expect(fetched).toEqual(["alice@example.com"]);
    const bob = payload.accounts.find((a: Json) => a.email === "bob@example.com");
    // 400 s is past STALE_OK_S: only the hold keeps the reading decision-grade.
    expect(bob.usageStatus).toBe("ok");
    expect(bob.usage.fiveHour.pct).toBe(42.0);
  });

  it("test_a_zero_hold_hands_the_account_back", async () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com", { creds: liveCreds("alice") });
    const document = usageDocument(usageRow("alice@example.com", "", 42.0, 400.0));
    doImport(s, document, 600.0);
    doImport(s, document, 0.0);
    expect(capsys.readouterr().err).toContain("holds lifted");

    const fetch = vi
      .spyOn(switcherInternals, "tryFetchUsageForAccount")
      .mockResolvedValue(usageOutcome({ five_hour: { pct: 1.0 } }));
    await s.listAccounts(false, true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("test_a_held_active_account_shows_its_reading_not_token_expired", async () => {
    // A held slot does not wait for a fetch to refresh its expired token: the row shows the adopted reading.
    const home = testHome();
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com");
    writeJson(path.join(home, ".claude.json"), {
      oauthAccount: { emailAddress: "alice@example.com", accountUuid: "acct-1" },
    });
    writeJson(path.join(home, ".claude", ".credentials.json"), {
      claudeAiOauth: { accessToken: "tok", refreshToken: "rtok", expiresAt: 1000 },
    });
    doImport(s, usageDocument(usageRow("alice@example.com", "", 42.0)), 600.0);

    const fetch = vi.spyOn(switcherInternals, "tryFetchUsageForAccount");
    const payload = (await s.listAccounts(false, true)) as Json;

    expect(fetch).not.toHaveBeenCalled();
    expect(payload.accounts).toHaveLength(1);
    const [row] = payload.accounts;
    expect(row.active).toBe(true);
    expect(row.usageStatus).toBe("ok");
    expect(row.usage.fiveHour.pct).toBe(42.0);
  });

  it("test_reads_stdin", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com");
    vi.spyOn(transferInternals, "readStdin").mockReturnValue(usageDocument(usageRow("alice@example.com")));
    importUsage(s, "-");
    expect(s.usageStore.entries({ "1": ["alice@example.com", ""] })["1"]!.lastGood).not.toBeNull();
  });

  it.each([
    ['{"schemaVersion": 2, "accounts": []}', /unsupported usage document schemaVersion/],
    ['{"schemaVersion": 1}', /no accounts list/],
    ["[]", /must be a JSON object/],
  ])("test_malformed_document_is_refused[%s]", (document, message) => {
    const s = linuxSwitcher();
    expectThrow(() => doImport(s, document), TransferError, message);
  });

  it("test_a_bad_row_writes_nothing", () => {
    const s = linuxSwitcher();
    seedAccount(s, 1, "alice@example.com");
    seedAccount(s, 2, "bob@example.com");
    const bad = usageRow("bob@example.com");
    bad.usageAgeSeconds = -5;
    expectThrow(
      () => doImport(s, usageDocument(usageRow("alice@example.com"), bad)),
      TransferError,
      /usageAgeSeconds for bob@example.com/,
    );
    expect(fs.existsSync(s.usageStore.path)).toBe(false);
  });
});
