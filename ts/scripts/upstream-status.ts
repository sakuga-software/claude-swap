/**
 * Report which TypeScript files are behind the upstream Python project.
 *
 * Usage: pnpm upstream:status [--no-fetch] [--ref <git ref>] [--markdown | --json] [--check]
 *
 * - `--ref`: compare against this ref. The default is the upstream branch of the manifest.
 *   Use `--ref HEAD` to compare against the Python tree that is merged into this branch.
 * - `--check`: exit with status 1 if a ported file is stale or an upstream file has no mapping.
 */
import { parseArgs } from "node:util";
import { fetchUpstream, git, isIgnored, mergedUpstream, readManifest, upstreamRef } from "./upstream-lib.js";

interface StaleFile {
  file: string;
  ts: string[];
  ported: string;
  commits: string[];
  diffstat: string;
}

const { values } = parseArgs({
  options: {
    "no-fetch": { type: "boolean", default: false },
    ref: { type: "string" },
    markdown: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    check: { type: "boolean", default: false },
  },
});

const manifest = readManifest();
if (!values["no-fetch"]) fetchUpstream(manifest);

const ref = values.ref ?? upstreamRef(manifest);
const refSha = git("rev-parse", "--short", ref);
const merged = mergedUpstream(manifest);
const unmergedCommits = git("rev-list", "--count", `${merged}..${upstreamRef(manifest)}`);
const upstreamFiles = new Set(git("ls-tree", "-r", "--name-only", ref).split("\n"));

const stale: StaleFile[] = [];
const notPorted: string[] = [];
let current = 0;

for (const [file, entry] of Object.entries(manifest.files)) {
  if (!upstreamFiles.has(file)) continue;
  if (entry.ported === null) {
    notPorted.push(file);
    continue;
  }
  const commits = git("log", "--format=%h %s", `${entry.ported}..${ref}`, "--", file).split("\n").filter(Boolean);
  if (commits.length === 0) {
    current += 1;
    continue;
  }
  const diffstat = git("diff", "--shortstat", `${entry.ported}..${ref}`, "--", file);
  stale.push({ file, ts: entry.ts, ported: entry.ported.slice(0, 7), commits, diffstat });
}

const removed = Object.keys(manifest.files).filter((file) => !upstreamFiles.has(file));
const unmapped = [...upstreamFiles].filter(
  (file) => file && !(file in manifest.files) && !isIgnored(file, manifest.ignore),
);

const report = {
  ref,
  refSha,
  merged: merged.slice(0, 7),
  unmergedCommits: Number(unmergedCommits),
  current,
  stale,
  notPorted,
  unmapped,
  removed,
};

if (values.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (values.markdown) {
  process.stdout.write(renderMarkdown());
} else {
  process.stdout.write(renderText());
}

if (values.check && (stale.length > 0 || unmapped.length > 0 || removed.length > 0)) process.exitCode = 1;

function renderText(): string {
  const lines = [
    `Upstream ${ref} = ${refSha}; merged into HEAD: ${report.merged} (${report.unmergedCommits} upstream commits not merged)`,
    `Ported and current: ${current} | stale: ${stale.length} | not ported: ${notPorted.length} | unmapped: ${unmapped.length} | removed upstream: ${removed.length}`,
  ];
  for (const s of stale) {
    lines.push("", `STALE ${s.file} -> ${s.ts.join(", ")}  (ported at ${s.ported}; ${s.diffstat})`);
    lines.push(...s.commits.map((c) => `    ${c}`));
    lines.push(`    git diff ${s.ported}..${refSha} -- ${s.file}`);
  }
  if (unmapped.length) lines.push("", "UNMAPPED (add to ts/port-manifest.json or its ignore list):", ...unmapped.map((f) => `    ${f}`));
  if (removed.length) lines.push("", "REMOVED UPSTREAM (delete the TS counterpart and the manifest entry):", ...removed.map((f) => `    ${f}`));
  if (notPorted.length) lines.push("", `NOT PORTED YET: ${notPorted.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

function renderMarkdown(): string {
  const out = [
    `Upstream \`${ref}\` is at \`${refSha}\`. This branch contains upstream up to \`${report.merged}\`.`,
    "",
    `| Current | Stale | Not ported | Unmapped | Removed upstream |`,
    `| --- | --- | --- | --- | --- |`,
    `| ${current} | ${stale.length} | ${notPorted.length} | ${unmapped.length} | ${removed.length} |`,
  ];
  if (stale.length) {
    out.push("", "### Files to port", "");
    for (const s of stale) {
      out.push(`- [ ] \`${s.file}\` → ${s.ts.map((t) => `\`${t}\``).join(", ")} (${s.diffstat})`);
      out.push("  <details><summary>" + `${s.commits.length} commit(s) since \`${s.ported}\`` + "</summary>", "");
      out.push(...s.commits.map((c) => `  - ${c}`));
      out.push("", `  \`git diff ${s.ported}..${refSha} -- ${s.file}\``, "  </details>");
    }
  }
  if (unmapped.length) out.push("", "### New upstream files without a mapping", "", ...unmapped.map((f) => `- [ ] \`${f}\``));
  if (removed.length) out.push("", "### Files removed upstream", "", ...removed.map((f) => `- [ ] \`${f}\``));
  out.push("", "Port each file, then run `pnpm upstream:mark <python file>...` from `ts/`. See `ts/PORTING.md`.");
  return `${out.join("\n")}\n`;
}
