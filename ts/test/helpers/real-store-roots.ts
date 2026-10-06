import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A path that the tests must never write.
 * - `tree`: the root and everything below it.
 * - `children`: the root and its direct children only.
 * - `exact`: the path itself only.
 */
export interface GuardedRoot {
  path: string;
  scope: "tree" | "children" | "exact";
}

export function realStoreRoots(env: NodeJS.ProcessEnv): GuardedRoot[] {
  const homes = new Set([env.HOME, env.USERPROFILE, os.userInfo().homedir].filter(isSet));
  const roots: GuardedRoot[] = [];
  const add = (p: string, scope: GuardedRoot["scope"]) => roots.push({ path: path.resolve(p), scope });

  for (const home of homes) {
    const claudeHome = path.join(home, ".claude");
    const backupRoots = [path.join(home, ".local", "share", "claude-swap"), path.join(home, ".claude-swap-backup")];
    add(home, "children");
    add(claudeHome, "children");
    add(path.join(claudeHome, "projects"), "tree");
    for (const backup of backupRoots) {
      add(backup, "tree");
      add(path.join(path.dirname(backup), `.${path.basename(backup)}.migrating`), "exact");
    }
  }
  if (isSet(env.XDG_DATA_HOME)) {
    const backup = path.join(env.XDG_DATA_HOME, "claude-swap");
    add(backup, "tree");
    add(path.join(env.XDG_DATA_HOME, ".claude-swap.migrating"), "exact");
  }
  for (const configDir of [env.CLAUDE_CONFIG_DIR, env.CLAUDE_SECURESTORAGE_CONFIG_DIR].filter(isSet)) {
    add(configDir, "children");
    add(path.join(configDir, "projects"), "tree");
  }
  return roots;
}

/**
 * The root that protects `target`, if any. A relative target resolves against
 * the current directory. The target and the roots match by their literal and
 * by their real spelling, because a symlink (macOS `/var` -> `/private/var`) can give two spellings to one path.
 */
export function isUnderRealStore(target: string, roots: GuardedRoot[]): GuardedRoot | undefined {
  const spellings = spellingsOf(path.resolve(target));
  return roots.find(({ path: root, scope }) =>
    spellingsOf(root, true).some((rootSpelling) =>
      spellings.some((spelling) => {
        if (spelling === rootSpelling) return true;
        if (scope === "tree") return spelling.startsWith(rootSpelling + path.sep);
        if (scope === "children") return path.dirname(spelling) === rootSpelling;
        return false;
      }),
    ),
  );
}

const rootSpellings = new Map<string, string[]>();

function spellingsOf(resolved: string, cache = false): string[] {
  const known = cache ? rootSpellings.get(resolved) : undefined;
  if (known) return known;
  const real = realSpelling(resolved);
  const result = real === resolved ? [resolved] : [resolved, real];
  if (cache) rootSpellings.set(resolved, result);
  return result;
}

/** The real path of the nearest existing ancestor, joined to the rest of `resolved`. */
function realSpelling(resolved: string): string {
  const tail: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** The first root that sits strictly below `target`. A recursive delete or a rename of `target` takes that root too. */
export function holdsRealStore(target: string, roots: GuardedRoot[]): GuardedRoot | undefined {
  const prefixes = spellingsOf(path.resolve(target)).map((s) => (s.endsWith(path.sep) ? s : s + path.sep));
  return roots.find(({ path: root }) =>
    spellingsOf(root, true).some((rootSpelling) => prefixes.some((prefix) => rootSpelling.startsWith(prefix))),
  );
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}
