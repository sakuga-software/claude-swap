import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "../src/models.js";
import * as paths from "../src/paths.js";
import { HISTORY_ITEMS } from "../src/session.js";
import { isOsError } from "../src/support/oserror.js";
import { testHome } from "./helpers/home.js";
import { RealStoreWriteBlocked, guardedRoots, setGuardedRoots } from "./helpers/real-store-guard.js";
import { type GuardedRoot, isUnderRealStore, realStoreRoots } from "./helpers/real-store-roots.js";

const roots: GuardedRoot[] = JSON.parse(process.env.CSWAP_TEST_REAL_STORE_ROOTS ?? "[]");
const realHome = os.userInfo().homedir;
const probe = ".cswap-test-real-store-guard-probe-DELETE-ME";

const frozenRoots = guardedRoots();
const startCwd = process.cwd();

afterEach(() => {
  setGuardedRoots(frozenRoots as GuardedRoot[]);
  process.chdir(startCwd);
});

/** Run `fn` with the guard armed on stand-in roots only. Put back the frozen roots after it. */
function armed<T>(stand: GuardedRoot[], fn: () => T): T {
  const previous = setGuardedRoots(stand);
  try {
    return fn();
  } finally {
    setGuardedRoots(previous);
  }
}

function tree(p: string): GuardedRoot {
  return { path: path.resolve(p), scope: "tree" };
}

function children(p: string): GuardedRoot {
  return { path: path.resolve(p), scope: "children" };
}

function tmpPath(): string {
  return fs.mkdtempSync(path.join(testHome(), "tmp-"));
}

function standInRoot(): string {
  const root = path.join(tmpPath(), "claude-swap");
  fs.mkdirSync(root);
  return root;
}

function rootsWith(scope: GuardedRoot["scope"], list: GuardedRoot[]): Set<string> {
  return new Set(list.filter((r) => r.scope === scope).map((r) => r.path));
}

function entries(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return (fs.readdirSync(root, { recursive: true }) as string[]).sort();
}

/** The environment of the Python `_freeze_real_store_specs` simulations: a fake home and no override. */
function simulatedEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HOME: home, USERPROFILE: home, ...extra };
}

describe("real store guard", () => {
  it("freezes the real roots before any test changes HOME", () => {
    expect(roots.map((r) => r.path)).toContain(path.join(realHome, ".claude"));
    expect(os.homedir()).toBe(testHome());
  });

  it.each([
    ["writeFileSync", () => fs.writeFileSync(path.join(realHome, ".claude", probe), "x")],
    ["mkdirSync", () => fs.mkdirSync(path.join(realHome, ".claude-swap-backup", probe), { recursive: true })],
    ["openSync w", () => fs.openSync(path.join(realHome, ".claude.json"), "w")],
    ["renameSync source", () => fs.renameSync(path.join(realHome, ".claude-swap-backup"), path.join(testHome(), "x"))],
    ["rmSync", () => fs.rmSync(path.join(realHome, ".local", "share", "claude-swap"), { recursive: true })],
  ])("refuses %s into the real store", (_name, write) => {
    expect(write).toThrow(RealStoreWriteBlocked);
  });

  it("refuses the promise API", async () => {
    await expect(fs.promises.writeFile(path.join(realHome, ".claude", probe), "x")).rejects.toThrow(RealStoreWriteBlocked);
  });

  it("allows writes in the isolated home", () => {
    const target = path.join(testHome(), ".claude", ".credentials.json");
    fs.writeFileSync(target, "{}");
    expect(fs.readFileSync(target, "utf8")).toBe("{}");
  });

  it("allows reads of the real store", () => {
    expect(() => fs.openSync(path.join(realHome, ".claude.json"), "r")).not.toThrow(RealStoreWriteBlocked);
  });

  it("leaves deep paths under ~/.claude alone", () => {
    const deep = path.join(realHome, ".claude", "jobs", "x", "y");
    expect(roots.some((r) => r.path === deep)).toBe(false);
  });

  it("refuses a recursive delete or a rename of a directory that contains a root", () => {
    const parent = tmpPath();
    const root = path.join(parent, "share", "claude-swap");
    fs.mkdirSync(root, { recursive: true });
    armed([tree(root)], () => {
      expect(() => fs.rmSync(path.join(parent, "share"), { recursive: true })).toThrow(RealStoreWriteBlocked);
      expect(() => fs.renameSync(path.join(parent, "share"), path.join(parent, "moved"))).toThrow(RealStoreWriteBlocked);
    });
    expect(fs.existsSync(root)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("matches a root and a target that a symlink spells two ways", () => {
    const base = tmpPath();
    const realDir = path.join(base, "real");
    fs.mkdirSync(path.join(realDir, "claude-swap"), { recursive: true });
    const alias = path.join(base, "alias");
    fs.symlinkSync(realDir, alias);

    armed([tree(path.join(alias, "claude-swap"))], () => {
      expect(() => fs.writeFileSync(path.join(realDir, "claude-swap", "sequence.json"), "{}")).toThrow(RealStoreWriteBlocked);
    });
    armed([tree(path.join(realDir, "claude-swap"))], () => {
      expect(() => fs.writeFileSync(path.join(alias, "claude-swap", "sequence.json"), "{}")).toThrow(RealStoreWriteBlocked);
    });
  });
});

describe("test_real_store_guard", () => {
  it("test_control_a_tmp_path_write_is_allowed", () => {
    const target = path.join(tmpPath(), "control-a-allowed.txt");
    fs.writeFileSync(target, "ok", "utf8");
    expect(fs.readFileSync(target, "utf8")).toBe("ok");
  });

  it("test_control_b_and_c_real_store_write_is_refused", async () => {
    // Expose the real HOME, the state that a timer sees after the teardown of its own test.
    vi.stubEnv("HOME", realHome);
    vi.stubEnv("USERPROFILE", realHome);
    const realMarker = path.join(paths.getBackupRoot(), probe);
    expect(realMarker.startsWith(realHome)).toBe(true);

    // Control B: the main flow of the test.
    expect(() => fs.writeFileSync(realMarker, "probe\n", "utf8")).toThrow(RealStoreWriteBlocked);
    expect(fs.existsSync(realMarker)).toBe(false);

    // Control C: a callback that runs later, outside the synchronous body of the test.
    const outcome = await new Promise<{ wrote: boolean; error?: unknown }>((resolve) => {
      setTimeout(() => {
        try {
          fs.writeFileSync(path.join(paths.getBackupRoot(), probe), "probe\n", "utf8");
          resolve({ wrote: true });
        } catch (error) {
          resolve({ wrote: false, error });
        }
      }, 10);
    });
    expect(outcome.wrote).toBe(false);
    expect(outcome.error).toBeInstanceOf(RealStoreWriteBlocked);
    expect(fs.existsSync(realMarker)).toBe(false);
  });

  it("test_rmtree_of_a_protected_root_is_refused_before_any_child_is_removed", () => {
    const root = standInRoot();
    fs.mkdirSync(path.join(root, "configs"));
    fs.writeFileSync(path.join(root, "configs", ".claude-config-1-a@example.com.json"), "{}");
    fs.mkdirSync(path.join(root, "credentials"));
    fs.writeFileSync(path.join(root, "credentials", ".creds-1-a@example.com.enc"), "x");
    fs.writeFileSync(path.join(root, "sequence.json"), "{}");
    const before = entries(root);
    expect(before).toHaveLength(5);

    armed([tree(root)], () => {
      expect(() => fs.rmSync(root, { recursive: true, force: true })).toThrow(RealStoreWriteBlocked);
    });

    expect(entries(root)).toEqual(before);
  });

  it("test_os_mkdir_and_os_remove_into_protected_root_are_refused", () => {
    const root = standInRoot();
    const target = path.join(root, "sequence.json");
    fs.writeFileSync(target, "{}");

    armed([tree(root)], () => {
      const newDir = path.join(root, "new_subdir");
      expect(() => fs.mkdirSync(newDir)).toThrow(RealStoreWriteBlocked);
      expect(fs.existsSync(newDir)).toBe(false);

      expect(() => fs.unlinkSync(target)).toThrow(RealStoreWriteBlocked);
      expect(fs.existsSync(target)).toBe(true);
    });
  });

  it("test_os_open_flags_only_write_into_protected_root_is_refused", () => {
    const root = standInRoot();
    const target = path.join(root, "sequence.json");
    let fd: number | undefined;
    try {
      armed([tree(root)], () => {
        expect(() => {
          fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT);
        }).toThrow(RealStoreWriteBlocked);
      });
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    expect(fs.existsSync(target)).toBe(false);
  });

  it("test_non_recursive_root_protects_only_direct_children", () => {
    const root = path.join(tmpPath(), ".claude");
    const deepDir = path.join(root, "jobs", "abc", "tmp");
    fs.mkdirSync(deepDir, { recursive: true });

    armed([children(root)], () => {
      const deepTarget = path.join(deepDir, "somefile.json");
      fs.writeFileSync(deepTarget, "ok", "utf8");
      expect(fs.existsSync(deepTarget)).toBe(true);

      const directTarget = path.join(root, ".credentials.json");
      expect(() => fs.writeFileSync(directTarget, "ok", "utf8")).toThrow(RealStoreWriteBlocked);
      expect(fs.existsSync(directTarget)).toBe(false);
    });
  });

  it("test_a_dot_dot_spelling_cannot_walk_past_a_non_recursive_root", () => {
    const root = path.join(tmpPath(), ".claude");
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });

    armed([children(root)], () => {
      const walked = `${root}/sub/../.credentials.json`;
      expect(() => fs.openSync(walked, "w")).toThrow(RealStoreWriteBlocked);
    });
    expect(fs.existsSync(path.join(root, ".credentials.json"))).toBe(false);
  });

  it.each([false, true])("test_frozen_specs_include_the_two_non_recursive_roots[%s]", (legacyGlobalConfig) => {
    const home = path.join(tmpPath(), "home");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    if (legacyGlobalConfig) fs.writeFileSync(path.join(home, ".claude", ".config.json"), "{}", "utf8");

    const nonRecursive = rootsWith("children", realStoreRoots(simulatedEnv(home)));

    expect(nonRecursive).toContain(path.join(home, ".claude"));
    expect(nonRecursive).toContain(home);
  });

  it.each([Platform.LINUX, Platform.MACOS])(
    "test_frozen_specs_cover_the_migration_flag_and_the_transcript_tree[%s]",
    (platform) => {
      const home = path.join(tmpPath(), "home");
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      vi.spyOn(Platform, "detect").mockReturnValue(platform);

      // Control: the stub really selected this layout.
      expect(paths.getBackupRoot()).toBe(
        platform === Platform.MACOS
          ? path.join(home, ".claude-swap-backup")
          : path.join(home, ".local", "share", "claude-swap"),
      );

      const specs = realStoreRoots(process.env);
      const all = new Set(specs.map((r) => r.path));
      const recursive = rootsWith("tree", specs);

      const flag = paths.migrationFlagFor(paths.getBackupRoot());
      expect(all).toContain(flag);
      // The flag is a sibling of the backup root, so no tree root reaches it.
      expect([...recursive].some((root) => flag.startsWith(root + path.sep))).toBe(false);
      // A file root matches only on equality: assert the refusal itself.
      fs.mkdirSync(path.dirname(flag), { recursive: true });
      armed(specs, () => {
        expect(() => fs.writeFileSync(flag, "")).toThrow(RealStoreWriteBlocked);
      });

      // Every directory that `--share-history` shares needs a tree root: it lands two levels under `~/.claude`.
      for (const name of HISTORY_ITEMS) {
        if (name.endsWith(".jsonl")) continue;
        expect(recursive).toContain(path.join(home, ".claude", name));
      }
      expect(rootsWith("children", specs)).toContain(path.join(home, ".claude"));
    },
  );

  it("test_frozen_specs_ignore_a_developer_exported_claude_config_dir", () => {
    const home = path.join(tmpPath(), "home");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const elsewhere = path.join(home, "elsewhere");
    fs.mkdirSync(elsewhere);

    const nonRecursive = rootsWith("children", realStoreRoots(simulatedEnv(home, { CLAUDE_CONFIG_DIR: elsewhere })));

    expect(nonRecursive).toContain(path.join(home, ".claude"));
    expect(nonRecursive).toContain(elsewhere);
  });

  it("test_frozen_specs_include_the_ambient_xdg_override_backup_root", () => {
    const base = tmpPath();
    const home = path.join(base, "home");
    fs.mkdirSync(home);
    const xdg = path.join(base, "xdg-outside-home");
    fs.mkdirSync(xdg);

    const recursive = rootsWith("tree", realStoreRoots(simulatedEnv(home, { XDG_DATA_HOME: xdg })));

    expect(recursive).toContain(path.join(xdg, "claude-swap"));
    expect(recursive).toContain(path.join(home, ".local", "share", "claude-swap"));
  });

  it("test_layout_a_runtime_real_store_is_refused_and_unrelated_tmp_still_writes", () => {
    const base = tmpPath();
    const home = path.join(base, "home");
    fs.mkdirSync(home);
    const xdg = path.join(base, "xdg-outside-home");
    fs.mkdirSync(xdg);
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_DATA_HOME", xdg);
    vi.spyOn(Platform, "detect").mockReturnValue(Platform.LINUX);

    armed(realStoreRoots(process.env), () => {
      const runtimeRealStore = paths.getBackupRoot();
      expect(runtimeRealStore).toBe(path.join(xdg, "claude-swap"));

      // YES arm: the runtime real store is refused.
      const yesTarget = path.join(runtimeRealStore, "sequence.json");
      expect(() => {
        fs.mkdirSync(path.dirname(yesTarget), { recursive: true });
        fs.writeFileSync(yesTarget, "{}", "utf8");
      }).toThrow(RealStoreWriteBlocked);
      expect(fs.existsSync(yesTarget)).toBe(false);

      // NO arm: an unrelated path still takes the write.
      const noTarget = path.join(base, "unrelated", "file.txt");
      fs.mkdirSync(path.dirname(noTarget), { recursive: true });
      fs.writeFileSync(noTarget, "ok", "utf8");
      expect(fs.readFileSync(noTarget, "utf8")).toBe("ok");
    });
  });

  it("test_module_level_hints_are_wired_to_the_derivation_function", () => {
    // The TS guard has no substring pre-filter. The equivalent wiring is that the
    // live guard reads exactly the roots that vitest.config.ts derived and froze.
    expect(guardedRoots()).toEqual(roots);
    expect(roots.length).toBeGreaterThan(0);
  });

  it("test_arbitrary_claude_config_dir_is_not_dropped_by_the_hint_prefilter", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cswap-c2-noclaude-"));
    try {
      const home = path.join(base, "home");
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      const workProfile = path.join(home, "work-profile");
      fs.mkdirSync(workProfile);

      const specs = realStoreRoots(simulatedEnv(home, { CLAUDE_CONFIG_DIR: workProfile }));
      expect(specs.map((r) => r.path)).toContain(workProfile);

      const target = path.join(workProfile, ".credentials.json");
      expect([".claude", "claude-swap"].some((hint) => target.includes(hint))).toBe(false);

      armed(specs, () => {
        expect(() => fs.writeFileSync(target, '{"pwned": true}', "utf8")).toThrow(RealStoreWriteBlocked);
      });
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("test_i1_os_rename_source_out_of_protected_root_is_refused", () => {
    const root = standInRoot();
    fs.writeFileSync(path.join(root, "sequence.json"), "{}");
    const outside = path.join(path.dirname(root), "outside_dst");

    armed([tree(root)], () => {
      expect(() => fs.renameSync(root, outside)).toThrow(RealStoreWriteBlocked);
    });
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("test_i2_os_symlink_into_protected_root_is_refused", () => {
    const root = standInRoot();
    const attackerTarget = path.join(path.dirname(root), "attacker.txt");
    fs.writeFileSync(attackerTarget, "x");
    const linkPath = path.join(root, "evil-link");

    armed([tree(root)], () => {
      expect(() => fs.symlinkSync(attackerTarget, linkPath)).toThrow(RealStoreWriteBlocked);
    });
    expect(fs.existsSync(linkPath)).toBe(false);
    expect(() => fs.lstatSync(linkPath)).toThrow();
  });

  it("test_i3_relative_path_with_cwd_inside_protected_root_is_refused", () => {
    const root = standInRoot();

    armed([tree(root)], () => {
      process.chdir(root);
      try {
        expect(() => fs.writeFileSync("relative_seq.json", "{}")).toThrow(RealStoreWriteBlocked);
      } finally {
        process.chdir(startCwd);
      }
    });
    expect(fs.existsSync(path.join(root, "relative_seq.json"))).toBe(false);
  });

  it("test_i4_os_truncate_on_protected_root_file_is_refused", () => {
    const root = standInRoot();
    const target = path.join(root, "sequence.json");
    fs.writeFileSync(target, '{"accounts": {"1": "a"}}');

    armed([tree(root)], () => {
      expect(() => fs.truncateSync(target, 0)).toThrow(RealStoreWriteBlocked);
    });
    expect(fs.statSync(target).size).toBeGreaterThan(0);
  });

  it("test_i5_bytes_path_into_protected_root_is_refused", () => {
    const root = standInRoot();
    const target = path.join(root, "sequence.json");
    fs.writeFileSync(target, '{"accounts": {"1": "a"}}');

    armed([tree(root)], () => {
      expect(() => fs.writeFileSync(Buffer.from(target), "OVERWRITTEN")).toThrow(RealStoreWriteBlocked);
    });
    expect(fs.readFileSync(target, "utf8")).toBe('{"accounts": {"1": "a"}}');
  });

  it("test_derived_hints_exclude_the_bare_home_root_basename", () => {
    // The TS guard has no pre-filter. The intent: the bare home root protects its
    // direct children only, so it does not refuse every path under the home.
    const home = "/home/some-real-looking-username";
    const specs: GuardedRoot[] = [tree(`${home}/.local/share/claude-swap`), children(`${home}/.claude`), children(home)];

    expect(isUnderRealStore(`${home}/projects/app/src/file.ts`, specs)).toBeUndefined();
    expect(isUnderRealStore(`/tmp/pytest-of-some-real-looking-username/x`, specs)).toBeUndefined();
    expect(isUnderRealStore(`${home}/.claude.json`, specs)?.path).toBe(path.resolve(home));
  });

  it("test_mkdir_exist_ok_true_does_not_swallow_the_refusal", () => {
    const root = path.join(tmpPath(), "claude-swap");

    // A: absent directory.
    armed([tree(root)], () => {
      expect(() => fs.mkdirSync(root, { recursive: true })).toThrow(RealStoreWriteBlocked);
    });
    expect(fs.existsSync(root)).toBe(false);

    fs.mkdirSync(root, { recursive: true });

    armed([tree(root)], () => {
      // B: existing directory. The refusal must not look like an OS error that a caller absorbs.
      let caught: unknown;
      try {
        fs.mkdirSync(root, { recursive: true });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RealStoreWriteBlocked);
      expect(isOsError(caught)).toBe(false);

      // C: control, the guard is armed on this root.
      expect(() => fs.writeFileSync(path.join(root, "sequence.json"), "{}", "utf8")).toThrow(RealStoreWriteBlocked);
    });
  });

  it("test_a_relative_candidate_that_already_carries_a_hint_is_still_joined", () => {
    const root = path.join(tmpPath(), "claude-swap");
    fs.mkdirSync(path.join(root, "configs"), { recursive: true });

    armed([tree(root)], () => {
      process.chdir(root);
      try {
        // Control: a bare relative file name is refused.
        expect(() => fs.writeFileSync("sequence.json", "{}", "utf8")).toThrow(RealStoreWriteBlocked);

        const hintedRelative = "configs/.claude-config-1-someone_example.com.json";
        expect(() => fs.writeFileSync(hintedRelative, '{"pwned": true}', "utf8")).toThrow(RealStoreWriteBlocked);
        expect(fs.existsSync(path.join(root, hintedRelative))).toBe(false);
      } finally {
        process.chdir(startCwd);
      }
    });
  });

  it("test_the_legacy_backup_root_is_protected_recursively", () => {
    // The roots that the live guard reads, not a new derivation.
    const frozenLegacy = path.join(realHome, paths.LEGACY_BACKUP_DIRNAME);
    expect(guardedRoots().find((r) => r.path === frozenLegacy)?.scope).toBe("tree");

    expect(rootsWith("tree", realStoreRoots(process.env))).toContain(paths.getLegacyBackupRoot());
  });

  it.skipIf(process.platform === "win32")("test_c0_a_scratch_home_still_protects_the_os_account_home_store", () => {
    const base = tmpPath();
    const scratch = path.join(base, "scratch-home");
    fs.mkdirSync(scratch);
    const pwdHome = os.userInfo().homedir;

    const specs = realStoreRoots(simulatedEnv(scratch, { XDG_DATA_HOME: path.join(base, "xdg-outside") }));
    const all = specs.map((r) => r.path);

    // Derive both expectations under the HOME that each one resolves against.
    vi.stubEnv("XDG_DATA_HOME", undefined);
    vi.stubEnv("HOME", pwdHome);
    expect(os.homedir()).toBe(pwdHome);
    const pwdRoot = paths.getBackupRoot();
    vi.stubEnv("HOME", scratch);
    const scratchRoot = paths.getBackupRoot();

    expect(all).toContain(pwdRoot);
    expect(all).toContain(scratchRoot);
  });
});
