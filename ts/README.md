# claude-swap (TypeScript)

A TypeScript port of [claude-swap](https://github.com/realiti4/claude-swap), the multi-account switcher for Claude Code.

- **Same tool.** The commands, flags, help text, exit codes and `--json` output match the Python version. See the [main README](../README.md) for usage.
- **Same store.** It reads and writes the account store of the Python version (`~/.claude-swap-backup`, or `$XDG_DATA_HOME/claude-swap` on Linux), the same Keychain items and the same export files.
- **Node, not Python.** The CLI and the dashboard run on Node 22.15 or later. The dashboard uses [Ink](https://github.com/vadimdemedes/ink). The macOS menu bar is a native Swift app.

> **Do not run the Python and the TypeScript versions at the same time on one store.** Their file locks do not see each other. Uninstall one menu bar service before you install the other: both use the label `com.cswap.menubar`.

## Install

```sh
npm i -g @sakuga-software/claude-swap@beta     # or: pnpm add -g @sakuga-software/claude-swap@beta
```

This installs `cswap` and `claude-swap`. The versions are pre-releases for now, so the `@beta` tag is necessary: `cswap upgrade` follows the `latest` tag, which starts with the first stable release.

Check which one you run with `cswap --version`. The TypeScript version prints an npm version such as `0.27.0-beta.1`; the Python version prints `0.27.0b1`. If both are installed, the first one on your `PATH` wins.

From a checkout:

```sh
git clone https://github.com/sakuga-software/claude-swap.git
cd claude-swap/ts
pnpm install
pnpm build
npm link                  # puts `cswap` and `claude-swap` on your PATH
```

## First run on a machine that has the Python version

1. Copy your store: `cp -R ~/.claude-swap-backup ~/.claude-swap-backup.bak` (on Linux, `~/.local/share/claude-swap`).
2. Stop the Python menu bar service if you use it: `cswap menubar --uninstall-service` with the Python `cswap`.
3. Start with a read-only command: `cswap list --json`.

## Menu bar (macOS)

The menu bar app lives in [`../menubar`](../menubar). It holds no account logic: it runs `cswap` and reads its `--json` output.

```sh
cd ../menubar
scripts/bundle.sh                 # builds build/CswapMenuBar.app (needs Xcode or the Swift toolchain)
cswap menubar                     # starts it
cswap menubar --install-service   # keeps it running with launchd
```

`cswap menubar` looks for the app in `$CSWAP_MENUBAR_APP`, then next to the package, then in `menubar/build`, `~/Applications` and `/Applications`.

## What differs from the Python version

The list is in [`PORTING.md`](PORTING.md#differences-from-the-python-version). The points a user can meet:

- Windows: `cswap run` fails if `claude` is a `.cmd` shim, and the old keyring migration does not run.
- A number with no fraction prints as `80`, not `80.0`, in `--json` output.
- Help output has no colour.

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build && node dist/cli.js --help
```

The test suite is the pytest suite of the Python version, ported test by test with the same names. It runs in an isolated `HOME`. A guard stops any test that tries to write the real account store, and the setup blocks the network and replaces the Keychain.

`ts-ci.yml` runs typecheck, tests and build on Linux, macOS and Windows, and builds the menu bar app on macOS.

## Release

1. Set `version` in `package.json` and merge it to `main`.
2. Publish by hand from `ts/`: `npm publish --tag beta` for a pre-release, `npm publish` for a stable version. `prepack` builds `dist/` first.
3. Or push the tag `ts-v<version>`. The `Publish to npm` workflow checks that the tag matches `package.json`, runs the tests and publishes with provenance. It needs the `NPM_TOKEN` repository secret.

A GitHub release is not the trigger, because a release also starts the PyPI workflow that comes from upstream.

## Stay in sync with upstream

The Python sources stay in this repository, unchanged, under `src/` and `tests/`. They are the specification of the port, and `git merge upstream/main` only ever changes them.

```sh
git fetch upstream && git merge upstream/main   # brings in the Python changes
pnpm upstream:status                            # TypeScript files that are now stale, with the diff to port
pnpm upstream:mark src/claude_swap/paths.py     # record a port
```

`port-manifest.json` records, for each upstream file, the upstream commit that its TypeScript counterpart matches. The `Upstream sync` workflow does the merge every Monday and opens a pull request with the checklist. [`PORTING.md`](PORTING.md) has the conventions and the full procedure.
