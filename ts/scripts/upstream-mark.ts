/**
 * Record that TypeScript counterparts match an upstream commit.
 *
 * Usage: pnpm upstream:mark <file>... [--at <commit>]
 *
 * A <file> is an upstream path (`src/claude_swap/paths.py`) or a TypeScript path from the manifest.
 * The default commit is the upstream commit that HEAD contains, because the port reads the
 * Python files of this branch.
 */
import { parseArgs } from "node:util";
import { git, mergedUpstream, readManifest, upstreamRef, writeManifest } from "./upstream-lib.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { at: { type: "string" } },
});

if (positionals.length === 0) {
  process.stderr.write("usage: pnpm upstream:mark <file>... [--at <commit>]\n");
  process.exit(2);
}

const manifest = readManifest();
const at = git("rev-parse", values.at ?? mergedUpstream(manifest));

try {
  git("merge-base", "--is-ancestor", at, upstreamRef(manifest));
} catch {
  process.stderr.write(`${at} is not on ${upstreamRef(manifest)}\n`);
  process.exit(2);
}

for (const arg of positionals) {
  const relative = arg.replace(/^\.\//, "");
  const key =
    relative in manifest.files
      ? relative
      : Object.keys(manifest.files).find((file) =>
          manifest.files[file]!.ts.some((ts) => ts === relative || ts === `ts/${relative}`),
        );
  if (!key) {
    process.stderr.write(`no manifest entry for ${arg}\n`);
    process.exitCode = 2;
    continue;
  }
  manifest.files[key]!.ported = at;
  process.stdout.write(`${key} -> ported at ${at.slice(0, 7)}\n`);
}

writeManifest(manifest);
