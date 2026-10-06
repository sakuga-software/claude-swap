---
name: port-upstream
description: Bring the TypeScript port of claude-swap up to date with upstream realiti4/claude-swap — merge upstream, list the stale TypeScript files, port each Python diff with its tests, and mark the manifest. Use when the user asks to sync, update or pull from upstream or the fork's origin project.
---

# Port upstream changes

Read `ts/PORTING.md` first. It holds the layout, the naming rules and the test rules.

1. Make sure the working tree is clean. If the current branch is not an `upstream-sync/*` branch,
   run `git fetch upstream main` and `git switch -c upstream-sync/$(git rev-parse --short upstream/main)`,
   then `git merge --no-edit upstream/main`. The merge must not conflict, because the fork never
   edits upstream files. If it conflicts, stop and tell the user which fork commit edited an
   upstream file.
2. From `ts/`, run `pnpm upstream:status --no-fetch`. Also handle the UNMAPPED and REMOVED groups:
   map a new file in `port-manifest.json` (or add it to `ignore`), and delete the counterpart of a
   removed file.
3. For each STALE file, run the `git diff` command that the report prints. Apply the same change to
   the TypeScript counterpart. Port the test diff into the matching `it("<python test name>")`.
   A large set of stale files is independent work: give each file group to a subagent.
4. Run `pnpm typecheck` and `pnpm test`. Fix the failures.
5. Run `pnpm upstream:mark <python file>...` for every file that you ported.
6. Run `pnpm upstream:status --no-fetch --check`. It must exit with status 0.
7. Commit, push, and open or update the PR. Put the output of
   `pnpm upstream:status --no-fetch --markdown` (run before step 5) in the PR body.
