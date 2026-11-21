# Lumopolis Private Repositories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A private https repository opens in Lumopolis through the login the computer already keeps for git, or, as a fallback, a one-time token. Termpolis never stores the login.

**Architecture:**
- `gitSource` runs each git command with a login mode: `none`, `machine` (interactive or background) or `token`.
- The three login settings reach git through `GIT_CONFIG_COUNT` environment entries, never argv, so no git command line carries a login word.
- An https sign-in failure comes back as `needsLogin`. The renderer then offers "Sign in" (retry in `machine`, interaction allowed) and "Use a token" (retry in `token`, through a shipped one-shot askpass script fed by the environment).
- The registry remembers only the mode. A remembered `machine` repo is updated in the background, without interaction, each time it is opened. A failure shows a "Sign in needed" notice on the world.

**Tech Stack:** Electron 43 main, the world host process (`worldHost.ts`/`worldClient.ts`), React 18 renderer, git ≥ 2.31 (environment config), POSIX `sh` askpass (Git for Windows runs shebang scripts), Vitest 4, Playwright 1.58 e2e, and a Node `https` server in front of `git http-backend` as the test fixture.

**Spec:** `docs/superpowers/specs/2026-11-20-lumopolis-private-repos-design.md` (approved, commit aa015fc6).

## Global Constraints

- The renderer is ES2020: no `.at()`.
- Coverage is 100% on lines, functions, branches and statements for `src/main/world/**`, `src/shared/world/**`, `src/renderer/src/world/**` and `src/renderer/src/components/World/**`, which includes every new file here.
  - The repo gates stay at lines 97 / functions 96 / branches 95 / statements 96 and are never lowered.
- TDD on every task.
- `tsc` (node and web) and `eslint` must be clean before every commit.
- e2e runs locally with the `tw3.sh`/`tw4.sh` swap, restored before the commit.
- Never commit `postcss.config.js`, `src/renderer/src/index.css`, `tailwind.config.js` or `film-bugs-report.md`.
- Commits:
  - go straight to `main`, with the subject `lumopolis: <plain sentence>`;
  - are staged by explicit path;
  - use `git commit -F <file>`, with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  - start with `git pull --rebase --autostash`;
  - are never force-pushed.
- Never run `npm install`, and add no dependencies.
- Keep the `endpointActivityGuard` and installer-update CI gates. Add no MCP tools.
- CI must be green on Windows, macOS and Linux.
- Test-only hooks stay inert unless `NODE_ENV === 'test'`.
- User copy says "Lumopolis", in plain words with no git jargon. Code says `world`.
- **No token and no credential-signature string on any command line**: in product git argv, test argv, fixture argv, or a shell command run while building. A token travels only in memory and in the environment of the one git run that uses it. Every exec mock in this plan's tests asserts that argv contains neither the token nor `/credential|password|oauth|secret|token/i`.
- Spec rules, verbatim intent:
  - only the three login settings change per mode, and every other safety flag stays;
  - https only, ssh unchanged;
  - URLs keep `stripUrlUserinfo`;
  - a background run never opens a window;
  - the token is never written to disk or logs, and is dropped when the run ends, success or failure;
  - a token clone updates only by asking for a token again;
  - the helper check reads git config only, never a login store.

**Command shorthands:**
- **V:** `unset PROMPT_COMMAND TERMPOLIS_LIMIT_CHOOSER && export PATH="/c/Program Files/Git/cmd:$PATH" && npx vitest run <files>`
- **COV:** V plus `--coverage --coverage.include=<file>`. Expect 100/100/100/100.
- **TSC:** `npx tsc --noEmit -p tsconfig.node.json --composite false && npx tsc --noEmit -p tsconfig.web.json --composite false`
- **E2E:** `npx electron-vite build`, then `TERMPOLIS_E2E_PREBUILT=1 npx playwright test <spec>`.

## Review Focus

1. **The token never leaks:**
   - it never reaches the app log (`readAppLog`), any error string returned to the renderer, the sources registry file, or any argv;
   - this holds when git fails, when the world host times out or crashes mid-clone, and when git's stderr repeats what the askpass printed.

   Tests in Task 2 and Task 3.
2. **A pasted token with a leading or trailing space or line break** is trimmed and works. One with a space, tab or line break *inside* it, or empty after trimming, is refused in plain words before git runs. Tests in Task 2 and Task 4.
3. **A URL that already names a user** (`https://me@github.com/o/r.git`): the token run answers only git's second prompt. The saved URL and every message omit `me@`. Test in Task 2.
4. **A login helper that is configured but fails or is cancelled** (the person closes the browser sign-in, or the keychain is empty): the interactive run ends with `needsLogin` again and "Use a token" offered. It never retries on its own and never opens a second window. Tests in Task 1 and Task 4.
5. **A repo opened by token is never updated silently:** opening a remembered `token` entry starts no git run and shows no notice. A remembered `machine` entry whose background update fails keeps showing the saved copy with the notice. Tests in Task 3 and Task 4.

---

### Task 1: Login modes in gitSource, helper detection, and the sign-in result

**Files:**
- Create: `src/main/world/gitLogin.ts`, which holds the login run types, the config-environment builder, the git version gate and helper detection.
- Modify: `src/main/world/gitSource.ts`:
  - `safetyFlags` (56-65): drop the three login `-c` pairs and add `-c core.fsmonitor=false`;
  - `AUTH_MESSAGE` (29-30);
  - `ExecOpts` (102-110) gains `cwd?`;
  - `nodeExecFile` passes `cwd`;
  - `cloneArgs` (86-100);
  - `cloneRepo`'s env and its result.
- Test: `tests/electron/worldGitLogin.test.ts` (new), `tests/electron/worldGitSource.test.ts`, `tests/electron/worldGitSourceExec.test.ts`

**Interfaces:**
- Produces, in `gitLogin.ts`:
  - `export type LoginRun = { mode: 'none' } | { mode: 'machine'; interactive: boolean } | { mode: 'token' }`
  - `export function loginConfig(run: LoginRun): Array<[string, string]>`:
    - `none` gives `[['credential.helper', ''], ['credential.interactive', 'false'], ['core.askPass', '']]` (today's three);
    - `machine` background gives `[['credential.interactive', 'false']]`;
    - `machine` interactive gives `[['core.askPass', '']]`;
    - `token` gives `[['credential.helper', '']]`.
  - `export function configEnv(pairs: Array<[string, string]>): Record<string, string>` returns `GIT_CONFIG_COUNT`, plus `GIT_CONFIG_KEY_<i>` and `GIT_CONFIG_VALUE_<i>` for each pair.
  - `export function loginEnv(run: LoginRun): Record<string, string>`:
    - always `GIT_TERMINAL_PROMPT: '0'`;
    - `GCM_INTERACTIVE: 'never'` for `none` and for `machine` background;
    - nothing more for `machine` interactive (token additions come in Task 2).
  - `export const MIN_GIT = [2, 31] as const`, the first git that reads `GIT_CONFIG_COUNT`.
  - `export function parseGitVersion(out: string): [number, number] | null`
  - `export const OLD_GIT_MESSAGE = 'Lumopolis needs git 2.31 or newer to open a repository. Update git, then try again.'`
  - `export async function hasLoginHelper(deps: Pick<CloneDeps, 'execFile' | 'gitBin' | 'baseDir' | 'env'>, host: string): Promise<boolean>`:
    - runs `git config --list -z` (no login word in argv) with `cwd: baseDir`, `GIT_CEILING_DIRECTORIES: baseDir` and `stdoutMax: 1_048_576`;
    - true when any key matches `/^credential\.(?:(.+)\.)?helper$/i`, with a non-empty value, where the captured URL is absent or its host equals `host`;
    - a missing git, a non-zero exit or an over-long output gives false;
    - stdout is never logged or returned.
- Produces, in `gitSource.ts`:
  - `cloneArgs(url, dir, ref?, isWindows?)` is unchanged in shape and now carries no login flags.
  - `export interface NeedsLogin { host: string; helper: boolean }`
  - `cloneRepo(url: string, ref: string | undefined, deps: CloneDeps, run?: LoginRun)` returns `Promise<{ ok: true; root: string; changed: boolean } | { ok: false; error: string; needsLogin?: NeedsLogin }>`:
    - `run` defaults to `{ mode: 'none' }`;
    - `changed` is true for a new clone, and true for an update when `git rev-parse HEAD` differs before fetch and after reset;
    - `needsLogin` is set only when the URL is https and stderr matches `AUTH_RE`; `helper` comes from `hasLoginHelper`.
  - `export const AUTH_MESSAGE = 'That repository needs you to sign in. Sign in with the login this computer already uses for git, or use a token.'`
  - `export const SSH_AUTH_MESSAGE = "That repository needs you to sign in, and your ssh agent couldn't open it. Check that your ssh key is added, or clone it yourself and choose Open a folder."`
  - Every git run checks `git --version` once per `CloneDeps` object (cached in a `WeakMap`) and returns `OLD_GIT_MESSAGE` below `MIN_GIT`.

- [ ] **Step 1: Write the failing tests.** In `worldGitLogin.test.ts`:
  - `it('each mode changes only the three login settings')`: `safetyFlags(true)` and `safetyFlags(false)` contain `protocol.file.allow=never`, `core.hooksPath=NUL` or `core.hooksPath=/dev/null`, `core.symlinks=false` and `core.fsmonitor=false`, and nothing matching `/credential|askpass/i`. `loginConfig` returns exactly the four arrays above.
  - `it('configEnv numbers each pair from zero')`: `configEnv([['a.b','']])` equals `{ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '' }`.
  - `it('a background machine run can never prompt')`: `loginEnv({mode:'machine', interactive:false})` includes `GCM_INTERACTIVE: 'never'` and `GIT_TERMINAL_PROMPT: '0'`; the interactive run has no `GCM_INTERACTIVE`.
  - `hasLoginHelper`, with a fake `execFile`:
    - present (`credential.helper=manager`) gives true;
    - URL-scoped for the same host (`credential.https://github.com.helper=!gh auth git-credential`) gives true;
    - scoped to another host gives false;
    - an empty value only gives false;
    - absent gives false;
    - `missing: true` gives false;
    - exit 1 gives false;
    - the recorded call has `cwd === baseDir` and its argv equals `['config', '--list', '-z']` after the safety flags.
  - `parseGitVersion`:
    - `'git version 2.47.1.windows.2'` gives `[2,47]`;
    - `'git version 2.30.0'` gives `[2,30]`;
    - garbage gives `null`.

  In `worldGitSourceExec.test.ts`:
  - `it('clone env carries the mode's config and argv carries no login word')`, for each mode: `GIT_CONFIG_KEY_*` matches `loginConfig`, and `args.join(' ')` does not match `/credential|password|oauth|secret|token/i`.
  - `it('an https sign-in failure returns needsLogin with the helper answer')`: stderr `fatal: could not read Username for 'https://github.com': terminal prompts disabled` gives `{ ok:false, error: AUTH_MESSAGE, needsLogin: { host: 'github.com', helper: true } }`.
  - `it('ssh sign-in failures keep the ssh message and no needsLogin')`.
  - Review Focus 4: `it('an interactive machine run that still fails returns needsLogin once and runs git once')`: exactly one clone exec is recorded.
  - `it('old git is refused in plain words')`: a version of `2.30.0` gives `OLD_GIT_MESSAGE`, with no clone exec.
  - `it('an update reports changed only when HEAD moved')`.
  - `nodeExecFile` passes `cwd` to spawn.

- [ ] **Step 2: Run them and watch them fail.** Run V on the three files. Expected: FAIL, because `gitLogin.ts` is missing and the existing `safetyFlags` assertions differ.

- [ ] **Step 3: Implement it.**
  - `cloneRepo` merges `configEnv(loginConfig(run))` and `loginEnv(run)` over its current env (which still sets `GIT_ALLOW_PROTOCOL`, `GIT_CEILING_DIRECTORIES` and the rest).
  - `GIT_CONFIG_COUNT` and its keys from the inherited env are already in `DROPPED_ENV` (`GIT_CONFIG_COUNT`); add an inherited `GIT_CONFIG_KEY_*` and `GIT_CONFIG_VALUE_*` prefix drop.
  - Update the existing test expectations that listed the three login `-c` pairs.

- [ ] **Step 4: Run the tests and make sure they pass.** Run COV on `src/main/world/gitLogin.ts` and `src/main/world/gitSource.ts`, V on `tests/electron/worldGitSource*.test.ts` and `tests/electron/worldGitLogin.test.ts`, then TSC and eslint.

- [ ] **Step 5: Commit.** Subject: `lumopolis: git runs take a login mode, and a private https repository comes back as needing a sign-in`.

---

### Task 2: The one-shot token path, its askpass, and redaction

**Files:**
- Create: `src/shared/world/repoAccess.ts`
- Create: `resources/git-askpass/askpass.sh`. Commit it with mode 100755: `git add --chmod=+x resources/git-askpass/askpass.sh`.
- Modify:
  - `src/main/world/gitLogin.ts` (`loginEnv` token additions);
  - `src/main/world/gitSource.ts` (`CloneDeps.askpassPath?`, `DROPPED_ENV`, error redaction);
  - `package.json` `build.extraResources` (add `{ "from": "resources/git-askpass", "to": "git-askpass" }`, next to the grammars entry);
  - the packaged-resource list that `tests/electron/verifyPackagedResources.test.ts` covers.
- Test: `tests/shared/world/repoAccess.test.ts` (new), `tests/electron/worldGitLogin.test.ts`, `tests/electron/worldGitSourceExec.test.ts`, `tests/electron/verifyPackagedResources.test.ts`

**Interfaces:**
- Consumes: `LoginRun`, `loginEnv` and `cloneRepo` from Task 1.
- Produces:
  - `export type RepoAccess = { mode: 'machine' } | { mode: 'token'; value: string }`, which is what the renderer sends. A `machine` request from a person is always interactive.
  - `export type RepoLogin = 'machine' | 'token'`, which is what the registry keeps.
  - `export const TOKEN_FORMAT_MESSAGE = 'That token has a space or line break inside it. Copy it again and paste only the token.'`
  - `export const TOKEN_EMPTY_MESSAGE = 'Paste a token first.'`
  - `export const TOKEN_REJECTED_MESSAGE = "That token didn't open the repository. Check that it hasn't expired and can read this repository, then try again."`
  - `export function normalizeToken(raw: unknown): { ok: true; value: string } | { ok: false; error: string }`:
    - trims;
    - refuses empty, any `/[\s\x00-\x1f\x7f]/` left inside, and anything longer than 4096 characters.
  - `export function hideValue(text: string, value: string): string` replaces every occurrence of `value` with `[hidden]`, then applies `redactSecrets` (`src/shared/appLog.ts:72`).
  - `LoginRun` gains `{ mode: 'token'; value: string }`. `loginEnv` for token adds:
    - `GIT_ASKPASS: deps.askpassPath`
    - `TERMPOLIS_GIT_ASKPASS_USER: 'x-access-token'`
    - `TERMPOLIS_GIT_ASKPASS_REPLY: value`

    Its signature becomes `loginEnv(run: LoginRun, askpassPath?: string)`.
  - `DROPPED_ENV` gains `TERMPOLIS_GIT_ASKPASS_USER` and `TERMPOLIS_GIT_ASKPASS_REPLY`, so an inherited value can never feed git.
  - `cloneRepo` in token mode:
    - with no `askpassPath`, returns `TOKEN_REJECTED_MESSAGE` without running git;
    - an auth failure gives `{ ok:false, error: TOKEN_REJECTED_MESSAGE, needsLogin }`;
    - every returned `error` goes through `hideValue(…, value)`;
    - the env object built for the run is never stored or returned.
- Askpass script (exact; it never names the secret prompt):
  ```sh
  #!/bin/sh
  case "$1" in
    Username*) printf '%s\n' "$TERMPOLIS_GIT_ASKPASS_USER" ;;
    *) printf '%s\n' "$TERMPOLIS_GIT_ASKPASS_REPLY" ;;
  esac
  ```

- [ ] **Step 1: Write the failing tests.**
  - Review Focus 2, `normalizeToken`:
    - `'  ghp_abc\n'` gives `{ok:true, value:'ghp_abc'}`;
    - `'ghp_a bc'` and `'ghp_a\nbc'` give `TOKEN_FORMAT_MESSAGE`;
    - `''`, `'   '` and `42` give `TOKEN_EMPTY_MESSAGE`;
    - 4097 characters are refused.
  - `hideValue('x ' + v + ' y ' + v, v)` contains no `v`.
  - Review Focus 1, in `worldGitSourceExec.test.ts`:
    - `it('the token is only in the env of the one run, never in argv')`: the recorded args contain no token and no login word; `env.TERMPOLIS_GIT_ASKPASS_REPLY === token`; `env.GIT_ASKPASS === askpassPath`; `credential.helper` is present in the config env with an empty value.
    - `it('a token failure hides the token even when git repeats it')`: stderr containing the token returns an `error` without it.
    - `it('a later none-mode run after a token run carries no askpass variables')`: the same deps run twice, then the second env has no `TERMPOLIS_GIT_ASKPASS_*` and no `GIT_ASKPASS`.
    - `it('inherited askpass variables are dropped')`.
  - Review Focus 3: `it('a URL that names a user still clones by token, and no message shows the user')`: the URL is `https://me@host/o/r.git`, a failure's `error` does not contain `me@`, and origin is set to the stripped URL.
  - In `verifyPackagedResources.test.ts`: `git-askpass/askpass.sh` is in the required list. On non-Windows, a test reads the repo file mode through `git ls-files -s resources/git-askpass/askpass.sh` and expects `100755`.
  - Integration: run the real script with `execFileSync(shPath, [scriptPath, 'Username for x'], { env })`, then with `[scriptPath, 'Reply for x']`.
    - `shPath` is `C:\Program Files\Git\usr\bin\sh.exe` on Windows and `/bin/sh` elsewhere.
    - The value comes only from `env`.
    - The test's prompt strings avoid login words.
    - It prints the user, then the reply.

- [ ] **Step 2: Run them and watch them fail.** Run V on the four files. Expected: FAIL.

- [ ] **Step 3: Implement it.** Add the script, the extraResources entry and the token branch of `loginEnv` and `cloneRepo`, routing every `error` through `hideValue`.

- [ ] **Step 4: Run the tests and make sure they pass.** Run COV on `src/shared/world/repoAccess.ts`, `src/main/world/gitLogin.ts` and `src/main/world/gitSource.ts`, V on all four files, then TSC and eslint.

- [ ] **Step 5: Commit.** Subject: `lumopolis: a one-time token reaches git through the environment and a shipped askpass, never a command line or a file`.

---

### Task 3: Carry the access mode, the sign-in result and background updates through main

**Files:**
- Modify:
  - `src/main/world/worldHost.ts`: `cloneSource` (737-763) gains `access`; add `updateSource`; `WorldHostDeps.cloneDeps` (364-367) carries `askpassPath`.
  - `src/main/world/worldClient.ts`: `clone` (486) gains `access`; add `updateSource`.
  - `src/main/world/ipc.ts`:
    - `WorldSourcesDeps.clone` (136) gains `access`;
    - `world:clone` (397-412);
    - a new `world:update-source` next to `world:touch-source` (444).
  - `src/main/world/sources.ts`: `validSource` accepts `login?: 'machine' | 'token'` on git entries.
  - `src/shared/world/types.ts`: the git `WorldSource` (133) gains `login?: RepoLogin`.
  - `src/main/index.ts`:
    - `clone` (2820) and the new `updateSource` wiring;
    - the askpass path: `app.isPackaged ? join(process.resourcesPath, 'git-askpass', 'askpass.sh') : join(app.getAppPath(), 'resources', 'git-askpass', 'askpass.sh')`, handed to the world host in the same start options as `userDataPath`.
  - `src/preload/index.ts` (304-305) and `src/renderer/src/types/index.ts` (723).
- Test: `tests/electron/worldHost.test.ts`, `tests/electron/worldClient.test.ts`, `tests/electron/worldIpcSources.test.ts`, `tests/electron/worldSources.test.ts`, `tests/electron/preload.test.ts`

**Interfaces:**
- Consumes: `cloneRepo(url, ref, deps, run)`, `NeedsLogin`, `RepoAccess`, `RepoLogin`, `normalizeToken`, `hideValue`.
- Produces:
  - `worldHost.cloneSource(url: string, ref?: string, access?: RepoAccess)` maps access to a run:
    - `undefined` → `{mode:'none'}`;
    - `machine` → `{mode:'machine', interactive:true}`;
    - `token` → the normalized `{mode:'token', value}`, where a refused token returns its message with no git run.

    It returns the clone result without `changed`.
  - `worldHost.updateSource(url: string, ref: string | undefined, login: RepoLogin | undefined, access?: RepoAccess)` returns `{ ok:true; changed:boolean } | { ok:false; error:string; needsLogin?:NeedsLogin }`:
    - `login === 'token'` with no token access never reaches the host, because the IPC answers `skipped` first (below). The host still throws `Error('token update needs a token')` without running git, as a second guard;
    - no `access` runs `none`, or `machine` background when `login === 'machine'`.
  - `worldClient.clone(url, ref?, access?)` and `worldClient.updateSource(url, ref?, login?, access?)`, both through `call(...)`.
  - IPC:
    - `world:clone (url, ref?, access?)` returns one of:
      - `ok(WorldEntry)`, after `registry.upsert({ kind:'git', url, ref?, root, login? })`, where `login` is the access mode, and nothing is saved for `none`;
      - `ok({ needsLogin: { host, helper, message } })`;
      - `err(message)`.
    - `world:update-source ({ key, access? })` looks up the entry the way `world:touch-source` does. It returns:
      - `ok({ skipped: true })` for a non-git entry, or for a `token` entry asked without a token;
      - `ok({ changed })`;
      - `ok({ needsLogin: { host, helper, message } })`;
      - `err(message)`.

      A successful run with `access.mode === 'machine'` upserts `login: 'machine'`, and one with `token` upserts `login: 'token'`.
  - `export type CloneNeedsLogin = { needsLogin: NeedsLogin & { message: string } }` in `src/shared/world/repoAccess.ts`.
  - Preload and types:
    - `worldClone(url, ref?, access?: RepoAccess) => Promise<IpcResponse<WorldEntry | CloneNeedsLogin>>`
    - `worldUpdateSource(key: string, access?: RepoAccess) => Promise<IpcResponse<{ changed: boolean } | { skipped: true } | CloneNeedsLogin>>`

- [ ] **Step 1: Write the failing tests.**
  - `worldIpcSources`:
    - `it('a needsLogin clone answers ok with the actions data and saves nothing')`.
    - `it('a machine clone is remembered as machine, a token clone as token, and the token is never in the saved entry')`: `JSON.stringify(registry file)` does not contain the token.
    - `it('update-source never runs git for a token entry without a token')` (Review Focus 5).
    - `it('update-source runs a remembered machine entry in background mode')`: the host is called with `login:'machine'` and no access.
    - `it('a background failure that needs a sign-in answers needsLogin')`.
  - `worldHost`:
    - `it('maps each access to the right run')`.
    - `it('a refused token never reaches git')`.
    - `it('updateSource for login machine without access runs interactive:false')`.
  - `worldSources`: `validSource` accepts `login:'machine'` and `login:'token'`, and drops `login:'other'`.
  - Review Focus 1:
    - `it('no token in the app log after a failed, a timed-out and a crashed clone')` in `worldClient.test.ts`: drive `clone(url, ref, {mode:'token', value: T})` through each failure, then `readAppLog(1000)` and every returned error contain no `T`.
    - `worldHostTransport` error text does not include call arguments.
  - Preload: `worldClone` forwards `access` and `worldUpdateSource` invokes `world:update-source`.

- [ ] **Step 2: Run them and watch them fail.** Run V on the five files. Expected: FAIL.

- [ ] **Step 3: Implement it.** The `message` in `needsLogin` is `AUTH_MESSAGE` for `none` and `machine` and `TOKEN_REJECTED_MESSAGE` for `token`. A failure that is not a sign-in failure keeps today's `err(...)`.

- [ ] **Step 4: Run the tests and make sure they pass.** Run COV on `src/main/world/worldHost.ts`, `src/main/world/worldClient.ts`, `src/main/world/ipc.ts`, `src/main/world/sources.ts` and `src/shared/world/repoAccess.ts`, V on all five files plus `tests/electron/worldHostTransport.test.ts`, then TSC and eslint.

- [ ] **Step 5: Commit.** Subject: `lumopolis: opening a repository carries the chosen sign-in, remembers only how it was opened, and can update it in the background`.

---

### Task 4: Sign in, Use a token, and the Sign in needed notice

**Files:**
- Modify: `src/renderer/src/components/World/CloneDialog.tsx`, which gets the actions and a busy state while signing in.
- Create: `src/renderer/src/components/World/RepoAccessDialog.tsx`, the token dialog.
- Create: `src/renderer/src/components/World/SignInNeededNotice.tsx`
- Modify: `src/renderer/src/components/World/useOpenWorld.ts`. In `open()` (73-77), the `worldTouchSource` result decides on a background update; add `repoUpdate` state.
- Modify: `src/renderer/src/components/World/WorldView.tsx`. Render `SignInNeededNotice` from `useOpenWorld().repoUpdate`; after a changed update call `api.worldCompile(root)`, which already pushes the saved world through the existing listener at line 316.
- Test: `tests/renderer/world/WorldHome.test.tsx` (CloneDialog), `tests/renderer/world/RepoAccessDialog.test.tsx` (new), `tests/renderer/world/useOpenWorldUpdate.test.tsx` (new), `tests/renderer/world/WorldViewSources.test.tsx`

**Interfaces:**
- Consumes: `worldClone`, `worldUpdateSource`, `CloneNeedsLogin`, `RepoAccess`, `normalizeToken` and `TOKEN_*` messages (Tasks 2–3), `openExternal` (`types/index.ts:562`) and the `dialogCls`/`btnCls`/`primaryCls`/`fieldCls` classes from `worldTargets`.
- Produces:
  - `export function signInLabel(host: string): string` returns `'Sign in to GitHub'` for `github.com` and `'Sign in'` otherwise.
  - `export const TOKEN_PAGE_URL = 'https://github.com/settings/personal-access-tokens/new'`
  - `export function RepoAccessDialog(props: { host: string; busy: boolean; error: string | null; onSubmit(value: string): void; onCancel(): void }): JSX.Element`:
    - `data-testid="world-repo-access"`;
    - the input is `type="password"` with `autoComplete="off"`, `spellCheck={false}` and `data-testid="world-repo-access-input"`;
    - the copy reads: `A token is a key you make on GitHub that lets Lumopolis read this one repository. Lumopolis uses it once and doesn't keep it.`;
    - the GitHub link button is shown only for `github.com`;
    - the field is cleared on submit, on cancel and on unmount.
  - CloneDialog, on `needsLogin`:
    - shows `message` in its `role="alert"` paragraph;
    - shows `data-testid="world-clone-sign-in"` (`signInLabel(host)`) only when `helper`, and `data-testid="world-clone-use-token"` (`Use a token`) always;
    - Sign in retries `worldClone(url, ref, {mode:'machine'})`, with the busy text `Finish signing in in the window that opened…`;
    - Use a token opens `RepoAccessDialog`, which retries `worldClone(url, ref, {mode:'token', value})`.
  - `export type RepoUpdate = { key: string; host: string; helper: boolean; message: string } | null`. `useOpenWorld` returns `repoUpdate`, `signIn(): void`, `useToken(value: string): void` and `dismissRepoUpdate(): void` in addition to today's fields.
    - In `open(t)`: when the touched entry is `kind === 'git'` and `login !== 'token'`, it calls `worldUpdateSource(t.key)` once.
    - On `{changed:true}` it bumps a `repoChanged` counter that WorldView uses to call `worldCompile`.
    - On `needsLogin` it sets `repoUpdate`.
    - Errors and `skipped` change nothing.
  - `SignInNeededNotice`, `data-testid="world-sign-in-needed"`:
    - the text reads: `This repository needs you to sign in before Lumopolis can update it. You're seeing the saved copy.`;
    - the actions are Sign in (shown when `helper`), Use a token, and Dismiss;
    - it sits in the same top-of-world slot as WorldView's existing notice.

- [ ] **Step 1: Write the failing tests.**
  - CloneDialog:
    - `it('offers Sign in to GitHub and Use a token when a helper is set up')`.
    - `it('offers only Use a token when no helper is set up')`.
    - `it('Sign in retries in machine mode')`: the mock `worldClone` is called with `(url, undefined, {mode:'machine'})`.
    - Review Focus 4: `it('a second needsLogin after Sign in shows the actions again and does not retry on its own')`, with exactly two `worldClone` calls.
  - RepoAccessDialog:
    - Review Focus 2: submitting `'  ghp_x \n'` calls `onSubmit('ghp_x')`, and `'ghp_ x'` shows `TOKEN_FORMAT_MESSAGE` with no `onSubmit`.
    - The input is empty after submit and after cancel.
    - The GitHub link calls `openExternal(TOKEN_PAGE_URL)`.
    - The link is hidden for `gitlab.example.com`.
  - `useOpenWorldUpdate`:
    - `it('opening a remembered machine repo updates it in the background once')`.
    - Review Focus 5: `it('opening a remembered token repo runs no update and shows nothing')`.
    - `it('a changed update recompiles the world')`.
    - `it('a background needsLogin sets repoUpdate, and Sign in retries interactively and clears it on success')`.
    - `it('a failed background update keeps the saved world and shows no error')`.
  - `WorldViewSources`: the notice renders with its three actions, and Dismiss hides it.

- [ ] **Step 2: Run them and watch them fail.** Run V on the four files. Expected: FAIL.

- [ ] **Step 3: Implement it.** The token value lives only in RepoAccessDialog's input state and the one `worldClone`/`worldUpdateSource` call. It is never put in a React state outside the dialog, a ref that outlives the call, `localStorage` or a log.

- [ ] **Step 4: Run the tests and make sure they pass.** Run COV on the four component and hook files, V on the four test files plus `tests/renderer/world/WorldHome.test.tsx`, then TSC and eslint.

- [ ] **Step 5: Commit.** Subject: `lumopolis: a private repository offers Sign in or Use a token, and a remembered one shows Sign in needed instead of a window`.

---

### Task 5: A local signed-in git server, integration tests, and the real-app e2e on three platforms

**Files:**
- Create: `tests/fixtures/gitHttps/server.ts`, a Node `https` server that checks Basic auth, then pipes to `git http-backend` (CGI env) for a bare repo it creates.
- Create: `tests/fixtures/gitHttps/fake-helper.sh`, a git helper that logs `GCM_INTERACTIVE` and its operation to a file named by `FAKE_HELPER_LOG`, and on `get` prints the fixture user and reply from `FAKE_HELPER_USER` and `FAKE_HELPER_REPLY`. With `FAKE_HELPER_EMPTY=1` it prints nothing.
- Create: `tests/electron/worldGitHttps.test.ts`, which runs the real `cloneRepo` and real git against the fixture.
- Create: `e2e/lumopolis-private-repos.spec.ts`
- Modify: `.github/workflows/test.yml`, adding `npx playwright test e2e/lumopolis-private-repos.spec.ts` to the `e2e-smoke-macos` list next to line 534. `e2e-full` and `e2e-windows` run the whole directory.

**Interfaces:**
- Consumes: everything above, through the real app.
- Produces:
  - `export async function startGitHttps(opts: { user: string; reply: string; dir: string }): Promise<{ url: string; caFile: string; pushCommit(msg: string): Promise<void>; stop(): Promise<void> }>`
    - The certificate is self-signed for `127.0.0.1` and made at start with `openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1`.
      - On Windows the binary is `C:\Program Files\Git\usr\bin\openssl.exe`.
      - The key is never committed; GitHub push protection blocks committed private keys.
    - The fixture's user and reply are random per run, live only in memory and in the child env, and are never in argv.
  - The test env for git and the app:
    - `GIT_SSL_CAINFO=<caFile>`;
    - `GIT_CONFIG_NOSYSTEM=1`, so Git for Windows' system `manager` helper never runs in CI;
    - `GIT_CONFIG_GLOBAL=<tmp gitconfig>`, whose contents name the fake helper, or name nothing for the "no helper" cases.

    `GIT_SSL_CAINFO` and `GIT_CONFIG_*` are not in `DROPPED_ENV`, so the app's git inherits them.

- [ ] **Step 1: Write the failing tests.** In `worldGitHttps.test.ts` (node environment, real git):
  - `it('none mode cannot open the private repo and asks for a sign-in')`: `needsLogin.helper` follows the global config.
  - `it('machine interactive opens it through the helper')`: the clone succeeds, and the helper log shows `get` without `GCM_INTERACTIVE=never`.
  - `it('a background machine update never prompts')`: the helper log for the update shows `GCM_INTERACTIVE=never`. With `FAKE_HELPER_EMPTY=1` it returns `needsLogin` and the run finishes under 10 s (it did not wait on a prompt).
  - `it('token mode opens it, and leaves nothing behind')`:
    - the clone succeeds with no helper configured;
    - afterwards no file under the clone, under `baseDir` or in the temporary gitconfig contains the reply (scanned by reading files in Node);
    - `git config --list` in the clone has no entry with the reply.
  - `it('a wrong token gets TOKEN_REJECTED_MESSAGE without the token in it')`.
  - `it('a pushed commit makes the next update report changed')`.

  In `e2e/lumopolis-private-repos.spec.ts`, launch the app with the env above and a temporary userData:
  - `it('Sign in opens a private repository')`: Open repository, type the fixture URL, see `world-clone-sign-in`, click it, and the world opens.
  - `it('Use a token opens a private repository')`: with no helper, see only `world-clone-use-token`, paste the reply into `world-repo-access-input`, submit, and the world opens. The saved sources file (read in Node) does not contain it.
  - `it('a remembered repository whose login is gone shows Sign in needed, not a window')`: relaunch with `FAKE_HELPER_EMPTY=1`, open the remembered entry, and `world-sign-in-needed` appears while the saved world still renders.

- [ ] **Step 2: Run them and watch them fail.** Run V on `tests/electron/worldGitHttps.test.ts`, then E2E on `e2e/lumopolis-private-repos.spec.ts` (with the tw3/tw4 swap, restored afterwards). Expected: FAIL until the fixture exists, then PASS once the fixture alone is added. A failure after that is a product bug to fix in the owning task's files.

- [ ] **Step 3: Implement the fixture and the CI line.** The server passes `GIT_PROJECT_ROOT`, `GIT_HTTP_EXPORT_ALL=1`, `REQUEST_METHOD`, `PATH_INFO`, `QUERY_STRING`, `CONTENT_TYPE` and `REMOTE_USER` to `git http-backend`, and strips the CGI header block from its stdout. The helper and fixture files are added with `--chmod=+x`.

- [ ] **Step 4: Run them and make sure they pass.**
  - V and E2E locally.
  - Push, then confirm that the Windows unit job, the macOS and Linux unit jobs, `e2e-full`, `e2e-windows` and `e2e-smoke-macos` are green with `gh run view --json conclusion`.
  - Confirm that `endpointActivityGuard` and the installer-update gates still pass.

- [ ] **Step 5: Commit.** Subject: `lumopolis: private repositories are proven against a local signed-in git server on Windows, macOS and Linux`.

---

## Self-review

- **Spec coverage:**

  | Spec item | Task |
  |---|---|
  | Modes, other flags unchanged | 1 |
  | Interactive vs background `machine` | 1, 3 |
  | Token one-shot, never on disk, logs or argv | 2, 3 |
  | Flow actions | 4 |
  | Helper check from git config only | 1 |
  | Remember the mode per clone | 3 |
  | Background update and notice | 3, 4 |
  | Token clone updates only by asking | 3, 4 |
  | Copy rewritten | 1, 4 |
  | https only | 1 |
  | `stripUrlUserinfo` kept | 2 |
  | Unit tests | 1–4 |
  | Fixture, fake helper, token dialog e2e, three OSes | 5 |
  | Left to the builder: askpass, notice slot, fixture | 2, 4, 5 |

- **Step scan:** every step names its files, signatures, messages, assertions or commands. The only code body is the askpass script, which is a mechanism the signatures do not determine.
- **Types:** `LoginRun`, `RepoAccess`, `RepoLogin`, `NeedsLogin`, `CloneNeedsLogin`, `RepoUpdate`, `cloneRepo(…, run)`, `updateSource` and `worldUpdateSource` are used the same way across Tasks 1–5.
- **Review Focus:** tests are in Tasks 2 and 3, 2 and 4, 2, 1 and 4, and 3 and 4.
- **Proportion:** the plan holds signatures, messages and assertions, not bodies.
