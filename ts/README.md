# claude-swap (TypeScript)

A TypeScript port of [claude-swap](https://github.com/realiti4/claude-swap), the multi-account switcher for Claude Code. It reads and writes the same account store as the Python version, so you can move between the two without losing accounts. Do not run both versions at the same time on one store: their file locks are not compatible.

The commands, flags, output and `--json` contract are the same as the Python version. See the [main README](../README.md) for usage.

## Install

```sh
npm i -g @sakuga-software/claude-swap
# or
pnpm add -g @sakuga-software/claude-swap
```

This installs `cswap` and `claude-swap`. If the Python version is also installed, the first one on your `PATH` wins. Remove one of them.

The macOS menu bar app is a native Swift app in [`../menubar`](../menubar). It calls `cswap` to do all its work.

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build && node dist/cli.js --help
```

The tests run in an isolated `HOME`. A guard stops any test that tries to write the real account store, and the setup blocks the network and replaces the Keychain.

## Stay in sync with upstream

The Python sources stay in this repository, unchanged, under `src/` and `tests/`. They are the specification of the port. [`PORTING.md`](PORTING.md) explains the conventions and the update procedure. In short:

```sh
git fetch upstream && git merge upstream/main   # no conflicts: the fork never edits upstream files
pnpm upstream:status                            # TypeScript files that are now stale, with the diff to port
pnpm upstream:mark src/claude_swap/paths.py     # record a port
```

The `Upstream sync` workflow does the merge and opens a PR with the checklist every week.
