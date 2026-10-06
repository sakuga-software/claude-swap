# Porting claude-swap to TypeScript

This fork rewrites [realiti4/claude-swap](https://github.com/realiti4/claude-swap) in
TypeScript. The Python sources stay in the repository, unchanged, as the
specification. The TypeScript code lives in `ts/` (CLI, core, Ink TUI) and in
`menubar/` (the native macOS menu bar app).

## Layout

| Upstream (Python) | TypeScript |
| --- | --- |
| `src/claude_swap/<module>.py` | `ts/src/<module>.ts` (same snake_case file name) |
| `src/claude_swap/tui/<module>.py` | `ts/src/tui/<module>.tsx` |
| `src/claude_swap/menubar.py` | `menubar/` (Swift) and `ts/src/menubar.ts` |
| `tests/test_<module>.py` | `ts/test/<module>.test.ts` |
| `tests/conftest.py` | `ts/test/setup.ts` and `ts/test/helpers/` |
| `pyproject.toml` | `ts/package.json` |

`ts/port-manifest.json` holds the exact map. A TypeScript helper with no Python
source goes in `ts/src/support/`. The manifest does not track that directory.

**Never edit, move or delete a file under `src/`, `tests/` or another path that
upstream owns.** If upstream owns no file at a path, `git merge upstream/main`
cannot conflict with it. That is the base of the update method below.

## Updating from upstream

Each manifest entry records `ported`, the upstream commit that the TypeScript
counterpart matches. The procedure:

1. `git fetch upstream && git switch -c upstream-sync/<date> && git merge upstream/main`.
   The merge only touches Python files, so it has no conflicts.
2. `cd ts && pnpm upstream:status --no-fetch` lists every stale file with the
   upstream commits and the `git diff` command to read.
3. For each stale file, read the diff and apply the same change to the
   TypeScript counterpart. Port the test diff too. A changed test is the
   clearest signal of a changed behavior.
4. `pnpm typecheck && pnpm test`.
5. `pnpm upstream:mark <python file>...` records the merged upstream commit.
6. Open a PR. `pnpm upstream:status --markdown` gives a checklist for its body.

The `upstream-sync` workflow does steps 1, 2 and 6 every Monday. It opens a PR
with the checklist. If the `CLAUDE_PORT_ENABLED` repository variable is `true`,
a Claude Code job then does steps 3 to 5 on that PR. Locally, the
`port-upstream` skill (`.claude/skills/port-upstream`) does the same.

`pnpm upstream:status --check` exits with status 1 if a ported file is stale
or upstream added a file that the manifest does not map. Use `--ref HEAD` to
check against the merged tree instead of the upstream branch.

## Code conventions

### Names

- Functions, methods, variables, parameters: `snake_case` becomes `camelCase`
  (`get_backup_root` → `getBackupRoot`). Keep the words in the same order so a
  search for the Python name finds the TypeScript one.
- Classes and exceptions keep their names (`ClaudeAccountSwitcher`, `LockError`).
- Module constants keep `UPPER_SNAKE_CASE`.
- A Python `_private` name becomes a module-private `camelCase` name. If a
  Python test uses it, export it. Do not use the TypeScript `private` keyword
  on a method that a test calls.
- JSON keys and file names on disk never change.

### Types

- A `@dataclass` becomes an `interface` (plain data) or a `class` (with
  methods). An `Enum` becomes a `const` object plus a union type of its values.
- Use `string` for paths, with `node:path`. Get the home directory with
  `os.homedir()` every time you need it, because tests change `HOME`.
- A Python `None` becomes `null` in data that goes to JSON, and `undefined`
  elsewhere only if the code reads better that way.

### I/O model

- Filesystem, subprocess and lock calls are **synchronous**:
  `fs.*Sync`, `child_process.spawnSync`/`execFileSync`, and
  `sleepSync` from `src/support/sleep.ts` in a retry loop. This keeps the
  control flow of the Python code.
- Network calls use `fetch` and are **asynchronous**. A function that calls
  the network, directly or not, is `async`. A Python `ThreadPoolExecutor`
  becomes `Promise.all`. A Python thread with a loop becomes an `async` loop
  or a `setInterval` timer that the code clears in a `finally` block.
- Atomic writes, file modes and lock protocols must stay identical. The
  Python and TypeScript versions read and write the same store
  (`~/.claude-swap-backup` or `$XDG_DATA_HOME/claude-swap`), the same Claude
  Code files and the same Keychain items.

### Data on disk

The TypeScript version must read every file that the Python version writes,
and the Python version must read every file that the TypeScript version
writes: same keys, same value types, same timestamp formats. Use
`src/support/py.ts` for the Python formats (`isoformat`, `json.dumps` spacing)
where a reader or a test depends on the exact text.

### Comments

Follow the comment rules of the repository owner: write a comment only for a
warning, for a reason that the code cannot show, or for the doc comment of an
exported API. Write it in ASD-STE100 Simplified Technical English. The Python
sources carry long design histories. Do not copy them. Keep the one-sentence
reason, and let the Python file hold the history.

### Errors and output

- `exceptions.py` becomes classes that extend `Error` with the same names and
  the same hierarchy. Set `name` on each class.
- Text output, exit codes and `--json` output must match the Python version.
  Tests compare them.

## Test conventions

- Port each pytest file 1:1. A test class becomes `describe("<ClassName>")`.
  A test function becomes `it("<test_function_name>")` **with the exact Python
  name**, so a test that upstream changes maps to one TypeScript test.
- `@pytest.mark.parametrize` becomes `it.each`.
- If a test checks a Python-only mechanism (audit hooks, import machinery,
  the GIL), keep it as `it.skip("<test_name>", ...)` and write the reason in
  the body, so the map stays complete.
- Fixtures from `conftest.py` live in `test/helpers/`. Autouse fixtures live in
  `test/setup.ts`.

### Test isolation (mandatory)

`test/setup.ts` installs a guard for the life of each worker. The guard
throws `RealStoreWriteBlocked` if a test writes the real account store or the
real Claude Code files. Before each test, `isolateHome()` gives the test a new
`HOME` and removes `CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`,
`XDG_DATA_HOME`, `FORCE_COLOR` and `NO_COLOR`. Use `testHome()` to get it.
Never weaken the guard to make a test pass.

The setup file also replaces the Keychain backend and the OAuth profile fetch
by default, as `conftest.py` does.

### Replacing a dependency in a test

ES modules export read-only bindings, so `monkeypatch.setattr` has no direct
equivalent.

- To replace a function of another module, use
  `vi.mock("../src/<module>.js", async (orig) => ({ ...(await orig()), fn: vi.fn() }))`
  and set the behavior per test with `vi.mocked(fn).mockImplementation(...)`.
- To replace a constant, a cache or a function inside the same module,
  the module exports a mutable `internals` object and reads through it
  (`internals.JITTER_FRAC`). The test changes the property and the
  `afterEach` hook restores it, or the test uses `vi.spyOn(internals, "fn")`.
- Use `vi.stubEnv` for environment variables and `vi.useFakeTimers` /
  `vi.setSystemTime` for the clock.

## Differences from the Python version

Keep this list current. A port that adds a difference adds a line here.

### The two versions must not run at the same time on one store

- `FileLock` (`locking.ts`) is a directory at `<path>.d`, not an `flock`.
  The Python and TypeScript locks do not see each other.
- The LaunchAgent label `com.cswap.menubar` is the same in both versions.
  Uninstall one service before you install the other.

### Event loop

- A Python thread waits on a lock while another thread holds it. In
  TypeScript, the refresh lane holds `lockFile` across a network `await`. A
  synchronous mutator cannot wait for it without a block of the event loop.
  Thus `enterFileLock` throws `LockError` at once if a task of this process
  holds the lock, and the TUI calls `whenNoLockHeldInProcess()` before each
  action.
- The `claude_locks` toucher is a timer. It runs only while the event loop
  is free. A synchronous body must not hold a Claude Code lock for more than
  10 s (config) or 60 s (credentials).
- The active-read verdict is per async call chain (`AsyncLocalStorage`), not
  per thread.

### Platform gaps

- Windows: Node does not start a `.cmd` shim without a shell. The `claude`
  probe reports "unreachable" and `cswap run` fails if `claude` is a `.cmd`.
- Windows: the keyring-to-files migration is a no-op. Node has no Credential
  Manager binding. A Python run on the same store can still do it.
- macOS: the keyring-to-security migration reads the old items with the
  `security` CLI and leaves them in place. `cswap purge` removes them.
- The terminal background query uses raw mode, not cbreak, for at most 1 s.

### Distribution

- The npm package is `@sakuga-software/claude-swap`. It is not published yet.
- `cswap upgrade` runs `npm i -g` or `pnpm add -g`. The update check caches
  in `update_check_npm.json`, apart from the Python `update_check.json`.
- The package exposes the CLI only. `src/index.ts` is not a build entry.
- `cswap menubar` starts `CswapMenuBar.app`. Build it with
  `menubar/scripts/bundle.sh`. No workflow ships a built app yet.
- `launch_agent.resolveProgram()` falls back to `cswap` on `PATH`. If you
  install the service from a checkout and the Python `cswap` comes first on
  `PATH`, the plist starts the Python version.

### Output

- A float with no fraction prints as an integer (`80`, not `80.0`) in JSON
  files and in `--json` output. JSON readers see the same value.
- `--version` prints the npm version (`0.27.0-beta.1`, not `0.27.0b1`).
- Error text that includes a JavaScript error message differs from Python
  (`Error: boom`, not `RuntimeError: boom`).
- Help output has no colour. Python 3.14 colours it in a terminal.

## Commands

```sh
cd ts
pnpm install
pnpm typecheck
pnpm test
pnpm build && node dist/cli.js --help
pnpm upstream:status
```
