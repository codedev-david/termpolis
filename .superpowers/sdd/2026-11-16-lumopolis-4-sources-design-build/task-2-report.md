# Task 2 report: safe shallow git clone source

Commit 62c83de9 on main (pushed).

## Built
- `src/main/world/gitSource.ts`: `validateGitUrl`, `cloneKey`, `cloneArgs`, `cloneRepo`, plus the real deps `nodeExecFile`, `dirSizeOf`, `removeDir` and `pathExists`.
  - URL regex `^(https://|ssh://|git@)[^\s]+$` plus a control-character reject.
  - The ref must match `^[A-Za-z0-9._/-]+$`, must not start with `-` and must not contain `..`.
  - Every git command carries `-c protocol.file.allow=never -c core.hooksPath=NUL` (`/dev/null` off Windows).
  - The env is `process.env` plus `GIT_TERMINAL_PROMPT=0` and `GIT_ALLOW_PROTOCOL=https:ssh`.
  - Clone: `clone --depth 1 --filter=blob:none --single-branch [--branch ref] -- url dir`, 5 minute timeout.
  - An existing `<root>/.git` takes the `-C root fetch --depth 1 origin <ref|HEAD>` and `reset --hard FETCH_HEAD` path.
  - A size poll every 2 s aborts git over 2 GB, then deletes the folder. It checks once more after git exits.
  - The external abort signal gives `Cancelled`.
  - stderr's first line is shown with any `user:pass@` redacted.
- `worldHost.ts`:
  - Host fns `cloneSource(url, ref?)` and `cancelClone(url, ref?)`, with one AbortController per clone hash. A second call for the same hash joins the running clone.
  - Progress `clone:<hash16>`, stage `cloning`, pct 0 at start and pct 100 on success. `HostState` now keeps `userDataPath`, which is the clone base.
  - Deps `cloneRepo?` and `cloneDeps?` for tests.
- `worldClient.ts`: `clone(url, ref?)` and `cancelClone(url, ref?)`. Clone progress reaches `onProgress` with root `''`.

## Tests
- `tests/electron/worldGitSource.test.ts` (37 tests) covers every named test in the brief, plus ref validation, partial-clone cleanup, a failing size check, real fs deps and a real `nodeExecFile` run using node itself, not git.
- Extended `worldHost.test.ts` and `worldClient.test.ts`.
- The 20 world test files in `tests/electron` pass (464 tests). `tsc` on `tsconfig.node.json` and eslint are clean.

## Coverage
gitSource.ts, worldHost.ts and worldClient.ts are each at 100% on lines, functions, branches and statements.

## Deviations and decisions
- `cloneArgs` takes an optional 4th arg, `isWindows`, which defaults to the platform.
- `CloneDeps` gains optional `exists`, `signal`, `env`, `pollMs` and `maxBytes`.
- A failed update (fetch or reset) of an existing complete clone does NOT delete it, because it is not a partial clone. It returns the error. A failed fresh clone, a size overrun or a cancel always removes the folder. An update that grows past 2 GB is deleted.
- A leftover folder without `.git` is removed before a fresh clone, so git does not refuse to clone into it.
- `cloneSource` treats an empty-string ref as no ref.

## Self-review
- Hostile URLs and refs are refused before any process runs. The URL and ref cannot start with `-`, and the URL sits after `--`.
- No credential reads and no network in tests.
- `worldHostImports` guard passes: no electron import was added.
- Concern: the real `git` binary path was never exercised, because there are no network tests. Manual smoke testing belongs to Task 6.

## Fix round 1

- I1: `--quiet` on clone and fetch. The error line is the first `fatal:`/`error:`/`remote:` line, else the first non-empty line, with `user:pass@` redacted. Test: "a 404 shows git's own error line" (real-git-shaped stderr) and "an auth failure shows the fatal line".
- I2:
  - (a) `nodeExecFile` is now spawn-based and resolves only on the child's `close`. A kill-grace timer (10 s, `killGraceMs` hook) bounds the wait if a grandchild holds stderr open. It never rejects.
  - (b) A fresh clone goes to `<hash>.tmp-<random>`. On success it writes the marker `.git/lumopolis-complete`, then renames into root. Stale `<hash>.tmp-*` siblings and any unmarked root are removed first.
  - (c) `removeDir` uses maxRetries 5 and retryDelay 200.
  - (d) Every rm goes through `rmq`, which swallows failures. A root that cannot be cleared gives CLEAR_MESSAGE. A mark or rename failure gives FINISH_MESSAGE. `cloneRepo` never rejects.
  - Covering tests: "an AbortSignal resolves only after the child has exited" (the pid is dead when the promise resolves), "an rm failure ...", "a failure to mark or rename ...", "sweeps stale ...", and the real-fs temp-then-rename test. The grace and double-stop paths are in `worldGitSourceExec.test.ts`, which uses a fake child.
- I3:
  - Fetch and reset run with `--git-dir <root>/.git --work-tree <root>` before the subcommand, and `GIT_CEILING_DIRECTORIES=<base>/world/repos` is set in the env.
  - The update path is taken only when `<root>/.git/lumopolis-complete` exists. Otherwise the folder is deleted and cloned fresh.
  - Tests: "an existing complete clone is pinned ...", "an unmarked folder at root is not trusted ...", and the real-fs test.
- Not done (deferred minors): M1, M3, M5, M6, M7, M8. M2 was covered by `if (ext?.aborted) ctl.abort()`, with a test. M4 is partly covered, because a timeout now reads "it took too long".
- Command: `npx vitest run tests/electron/world*.test.ts` with coverage on gitSource.ts, worldHost.ts and worldClient.ts.
- Result: 21 files and 480 tests passed. All three files are at 100% on all four metrics. `tsc` and eslint are clean.

## Fix round 2

- N1: the final rename now goes through `renameWithRetry` (exported): 5 attempts, backoff 100 ms x attempt, retries only EPERM/EACCES/EBUSY, any other code fails at once. `rename` and `sleep` are injectable via CloneDeps. After the last failure the temp dir is removed and FINISH_MESSAGE returned.
- N1 tests: EPERM+EBUSY then success (3 calls, sleeps 100/200, clone kept); persistent EACCES (5 attempts, sleeps 100/200/300/400, WORK removed, FINISH_MESSAGE); ENOENT or no code (1 attempt, no sleep); default sleep really waits.
- N2: the rm-failure test case (a) now aborts during git so rm(WORK) really runs and rejects.
- N4: the kill-grace callback reports "it took too long" after a timeout. New test in worldGitSourceExec.test.ts; the older grace test's expectation changed accordingly.

Actual output (vitest run tests/electron/world*.test.ts with coverage on gitSource.ts, worldHost.ts, worldClient.ts):

```
 Test Files  21 passed (21)
      Tests  485 passed (485)
Statements   : 100% ( 655/655 )
Branches     : 100% ( 382/382 )
Functions    : 100% ( 142/142 )
Lines        : 100% ( 554/554 )
```
(Table rows are empty because every file is at 100%; the summary covers the three files together.) tsc and eslint clean.
