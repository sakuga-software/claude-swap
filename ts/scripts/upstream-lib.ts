import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const MANIFEST_PATH = path.join(REPO_ROOT, "ts", "port-manifest.json");

export interface ManifestEntry {
  ts: string[];
  ported: string | null;
}

export interface Manifest {
  $comment?: string;
  upstream: { remote: string; url: string; branch: string };
  ignore: string[];
  files: Record<string, ManifestEntry>;
}

export function git(...args: string[]): string {
  return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function readManifest(): Manifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

export function writeManifest(manifest: Manifest): void {
  const files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify({ ...manifest, files }, null, 2)}\n`);
}

export function upstreamRef(manifest: Manifest): string {
  return `${manifest.upstream.remote}/${manifest.upstream.branch}`;
}

/** Add the upstream remote if the clone does not have it (CI checkouts), then fetch it. */
export function fetchUpstream(manifest: Manifest): void {
  const remotes = git("remote").split("\n");
  if (!remotes.includes(manifest.upstream.remote)) {
    git("remote", "add", manifest.upstream.remote, manifest.upstream.url);
  }
  git("fetch", "--quiet", manifest.upstream.remote, manifest.upstream.branch);
}

/** The upstream commit that the Python tree of HEAD contains. */
export function mergedUpstream(manifest: Manifest): string {
  return git("merge-base", "HEAD", upstreamRef(manifest));
}

export function isIgnored(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("/*") ? file.startsWith(pattern.slice(0, -1)) : file === pattern,
  );
}
