# Lumopolis — Plan 4: Any code, design ahead, watch AI build

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lumopolis opens worlds from any of three sources:
- any folder or git URL;
- a design an agent drafted ahead of time, refined by conversation;
- an empty folder an agent is building into, where planned buildings rise and turn solid as the code appears.

**Architecture:** A `WorldSource` registry sits in front of the Plan 1 compiler.
- **Folder** and **git** sources resolve to a local root. Git clones go into `userData/world/repos/<hash>` and are indexed with `reindexRepoGraph(root)` (`codeGraph.ts:340`), then compiled exactly as in Plan 1.
- **Design** sources are plan-only `WorldDoc`s, keyed `design:<id>`. They are drafted and patched by the default agent through the Plan 2 one-shot runner, using a design patch protocol.
- **Plan versus built** reconciles a design against a compiled world.
- A pure `diffWorlds` drives "rise" and "pulse" animations after each recompile.

**Tech Stack:** As Plans 1–2. Git runs via async `execFile('git', …)` inside `worldHost` only.

**Spec:** `docs/superpowers/specs/2026-11-15-world-view-design.md` §5.4, §5.12, and the Testing note in §8. **Depends on:** Plan 1 (types, compiler, host/client, viewer, pane, gateway) and Plan 2 (ask runner, Ask bar).

## Global Constraints

- All Plan 1 and 2 constraints apply, including the 100% per-folder coverage (Plan 1 Task 1).
- Git safety:
  - accept only URLs matching `^(https://|ssh://|git@)[^\s]+$`;
  - reject any argument starting with `-`;
  - run with `GIT_TERMINAL_PROMPT=0`, `GIT_ALLOW_PROTOCOL=https:ssh`, and `-c protocol.file.allow=never -c core.hooksPath=/dev/null` (`NUL` on Windows);
  - use `clone --depth 1 --filter=blob:none --single-branch [--branch <ref>] -- <url> <dir>`, with a 5-minute timeout and a clone size cap of 2 GB (abort and delete when exceeded);
  - never read credential files or stores. git's own helper is the user's business.
- A cloned repository is **never executed**: no install, no scripts, no hooks. Termpolis only reads files.
- Design drafting is read-only `runHeadless` (`write: false`, `noRemember: true`) with no repository `cwd`. It uses an empty `userData/world/designs/<id>/` folder as its cwd.
- "Build it" is the **only** write-enabled action. It opens a normal agent terminal (the existing launch path) in a folder the user picked, and it refuses non-empty folders unless the user confirms.

## Review Focus

1. **A hostile or broken git URL**: `--upload-pack=…`, `ext::sh -c …`, `file:///C:/Windows`, a 404, an auth failure, a 10 GB repository. The UI gets a clear refusal or error, no command injection, and no partial clone left behind. Test in Task 2.
2. **The agent's design patch references things that don't exist, or would orphan edges**: invalid ops are skipped and reported ("2 changes couldn't be applied"); the design stays valid. Test in Task 3.
3. **A design partly matching a built world**: e.g. the design says "Payments API" and the code has `src/payments/`. Matching uses names and member paths and is case- and separator-insensitive; an unmatched built building shows as "not in the design". Test in Task 4.
4. **An agent creating 300 files in a minute during "Build it"**: animations are batched per recompile, never more than one rise per building, and the frame rate is kept (rises are capped at 20 per batch; the rest simply appear). Test in Task 5.
5. **The user deletes a cloned repository or design, or the folder disappears**: recent worlds shows it as "missing" with Remove; nothing crashes on open. Test in Task 6.

---

### Task 1: World sources registry

**Files:**
- Create: `src/main/world/sources.ts`
- Test: `tests/electron/worldSources.test.ts`

**Interfaces:**
- Produces:
  - `WorldSource = { kind: 'project'; root: string } | { kind: 'folder'; root: string } | { kind: 'git'; url: string; ref?: string; root: string } | { kind: 'design'; id: string; title: string; linkedRoot?: string }`
  - `WorldEntry = { key: string; source: WorldSource; title: string; lastOpened: number; missing?: boolean }`
  - `createSourceRegistry(dir: string, deps: { exists(p: string): Promise<boolean>; now(): number }): { list(): Promise<WorldEntry[]>; upsert(s: WorldSource, title?: string): Promise<WorldEntry>; remove(key: string): Promise<void>; get(key: string): Promise<WorldEntry | null> }`. It is stored atomically at `<dir>/world/sources.json`.
  - `keyForSource(s: WorldSource): string`. For project, folder and git it returns `graphKeyForRoot(root)`; for design, `design:<id>`.

- [ ] **Step 1:** Write the tests:
  - `upsert then list newest first`
  - `same root twice → one entry, lastOpened updated`
  - `missing root flagged missing: true`
  - `remove deletes the entry only (never files)`
  - `corrupt sources.json → empty list + .bad backup`
  - `keyForSource table`
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS at 100%.
- [ ] **Step 5:** Commit with the message `lumopolis: world sources registry`.

### Task 2: Git source (safe shallow clone)

**Files:**
- Create: `src/main/world/gitSource.ts`
- Modify: `src/main/world/worldHost.ts` (host fn `cloneSource(url, ref?)`, with progress `{stage:'cloning', pct}`)
- Test: `tests/electron/worldGitSource.test.ts`

**Interfaces:**
- Produces:
  - `validateGitUrl(url: string): { ok: true } | { ok: false; reason: string }`
  - `cloneArgs(url: string, dir: string, ref?: string): string[]`
  - `cloneRepo(url: string, ref: string | undefined, deps: { execFile: (cmd: string, args: string[], opts: { env: Record<string, string>; timeout: number; signal?: AbortSignal }) => Promise<{ code: number; stderr: string }>; baseDir: string; dirSize(p: string): Promise<number>; rm(p: string): Promise<void>; isWindows: boolean }): Promise<{ ok: true; root: string } | { ok: false; error: string }>`. The root is `<baseDir>/world/repos/<sha1(url+ref).slice(0,16)>`; an existing clone does `fetch --depth 1` + `reset --hard FETCH_HEAD` instead.
  - Human error strings: `That doesn't look like a git URL (https://, ssh:// or git@ only).`, `Couldn't reach that repository: <first stderr line>`, `That repository is larger than 2 GB, so Lumopolis stopped cloning it.`
- Indexing after clone: the client calls `reindexRepoGraph(root)` on main before `compile`. This is already async; the plan does not change it.

- [ ] **Step 1:** Write the tests:
  - `rejects --upload-pack=x, ext::sh, file:///, C:\\x, '-oProxyCommand', empty, spaces`
  - `accepts https://github.com/a/b.git, git@github.com:a/b.git, ssh://git@host/a/b`
  - `cloneArgs puts -- before url and includes the -c safety flags and NUL/ /dev/null by platform`
  - `env has GIT_TERMINAL_PROMPT=0 and GIT_ALLOW_PROTOCOL=https:ssh`
  - `non-zero exit → rm(dir) and friendly error`
  - `size over cap → rm(dir) and size error`
  - `existing clone → fetch+reset path`
  - `abort signal → rm and {ok:false, error:'Cancelled'}`
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS at 100%.
- [ ] **Step 5:** Commit with the message `lumopolis: safe shallow git clone source`.

### Task 3: Design worlds: draft and patch

**Files:**
- Create: `src/shared/world/designPatch.ts`, `src/main/world/designer.ts`
- Modify: `src/main/world/ipc.ts`, preload, `TermpolisAPI`
- Test: `tests/shared/worldDesignPatch.test.ts`, `tests/electron/worldDesigner.test.ts`

**Interfaces:**
- Produces (shared):
  - `DesignOp = { op: 'addDistrict'; id: string; name: string; subtitle?: string } | { op: 'addBuilding'; id: string; districtId: string; name: string; techLabel?: string; stack?: string[]; does?: string } | { op: 'addEdge'; from: string; to: string; label: string; cargo?: string } | { op: 'rename'; id: string; name: string } | { op: 'remove'; id: string } | { op: 'move'; id: string; districtId: string } | { op: 'describe'; id: string; does: string }`
  - `applyDesignPatch(doc: WorldDoc, ops: DesignOp[]): { doc: WorldDoc; applied: number; skipped: { op: DesignOp; reason: string }[] }`. Every added building gets `status:'proposed'` and claims with `state:'proposed'` and evidence `{kind:'memory', ref:'design:<docId>'}`. Removing a building removes its edges. Positions come from `layoutWorld` (Plan 1 Task 5), keeping existing ones.
  - `parseDesignReply(raw: string): { text: string; ops: DesignOp[] }`, reading a fenced `design-patch` JSON block, tolerant like `parseAnswer`.
  - `DESIGN_PROTOCOL: string`, the instructions block listing the ops above, with the same "under 150 words, plain language" rule as `ANSWER_PROTOCOL`.
- Produces (main):
  - `createDesigner(deps: { exec: typeof runHeadless; execDeps: ExecDeps; store: WorldStore; registry: SourceRegistry; designsDir: string; newId(): string }): { draft(description: string): Promise<{ key: string; doc: WorldDoc; text: string }>; refine(key: string, message: string, summary: string): Promise<{ doc: WorldDoc; text: string; applied: number; skipped: number; summary: string }> }`. `draft` starts from an empty doc and asks for ops only.
  - IPC: `world:design-draft`, `world:design-refine`. In design mode the Ask bar calls `refine` instead of `ask`.

- [ ] **Step 1:** Write the tests:
  - `addBuilding into unknown district skipped with reason`
  - `remove building drops its edges`
  - `rename keeps id and position`
  - `added items are proposed with design evidence`
  - `result always passes validateWorld`
  - `parseDesignReply tolerant cases (none, malformed, two blocks)`
  - `draft: exec called with write:false, noRemember:true, cwd under designsDir; registry gets kind design`
  - `refine applies ops, saves, returns counts`
  - `exec failure → friendly error, doc unchanged`
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS at 100%.
- [ ] **Step 5:** Commit with the message `lumopolis: design worlds drafted and refined by conversation`.

### Task 4: Plan versus built and world_propose

**Files:**
- Create: `src/shared/world/reconcile.ts`
- Modify: `src/main/world/compile.ts` (when the source has a linked design, put it in `layers.plan` and reconcile), `src/main/world/worldGatewayTransport.ts` (add `world_propose`), `src/renderer/src/world/engine/sceneModel.ts` (render the plan overlay)
- Test: `tests/shared/worldReconcile.test.ts`, extend the gateway and sceneModel tests

**Interfaces:**
- Produces:
  - `reconcilePlan(plan: WorldDoc, built: WorldDoc): { matched: Record<string, string>; missing: string[]; extra: string[] }`. Keys are plan building ids; values are built building ids.
    - Match order: same id; then normalized name equality (lowercase, strip non-alphanumerics, drop the suffixes `service`, `api`, `app`); then any built member path containing the normalized plan name as a path segment.
  - `sceneModel` with `layers.planned=true` and a linked plan: matched plan buildings are drawn at the built position with no wireframe; missing ones as wireframes at their design position; extra built ones get the tag "not in the design" on their card.
  - Gateway `world_propose({ cwd?: string; designKey?: string; ops: DesignOp[] })` → `{ key, applied, skipped }`. With no `designKey` it creates or updates the design linked to `cwd`'s world. It is trusted built-in, and the only thing it writes is Lumopolis data under userData.
  - Primer line gains: `Agents can sketch planned parts with tool "world_propose".`

- [ ] **Step 1:** Write the tests:
  - `matches by id, by name ignoring case/separators/'Service' suffix, by member path segment`
  - `missing and extra lists`
  - `sceneModel draws matched as solid at built pos, missing as wire`
  - `world_propose creates a linked design and returns counts`
  - `world_propose skips bad ops`
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS at 100%.
- [ ] **Step 5:** Commit with the message `lumopolis: plan versus built + world_propose`.

### Task 5: Watch it grow

**Files:**
- Create: `src/shared/world/diff.ts`
- Modify: `src/renderer/src/world/engine/createWorldViewer.ts` (`load(doc, { animateFrom?: WorldDoc })`), `threeRenderer.ts` (rise and pulse)
- Test: `tests/shared/worldDiff.test.ts`, extend `e2e/world-engine.spec.ts`

**Interfaces:**
- Produces:
  - `diffWorlds(prev: WorldDoc | null, next: WorldDoc): { added: string[]; removed: string[]; changed: string[]; turnedSolid: string[] }`. `changed` means the same id with different members, floors or status. `turnedSolid` means plan-missing became plan-matched.
  - The viewer, on `load(doc, {animateFrom})`, plays a **rise** (scale y 0→1 over 900 ms) for at most 20 `added`/`turnedSolid` items, a **pulse** (emissive flash for 1.2 s) for `changed`, and a fade for `removed`. Reduced motion means no animation. A toast in the pane reads `+3 parts, 2 changed`.

- [ ] **Step 1:** Write the tests:
  - `diff detects added/removed/changed/turnedSolid`
  - `null prev → everything added`
  - e2e: load fixture A, then B with 2 added → after 1 s both visible and the toast text reads `+2 parts`
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit with the message `lumopolis: rise/pulse as the world changes`.

### Task 6: Lumopolis home, switcher and Build it

**Files:**
- Create in `src/renderer/src/components/World/`: `WorldHome.tsx`, `WorldSwitcher.tsx`, `BuildItDialog.tsx`, `CloneDialog.tsx`, `DesignStart.tsx`
- Modify: `WorldView.tsx` (home when no world is open), `src/main/world/ipc.ts` (`world:sources-list`, `world:open-folder` (native folder dialog), `world:clone`, `world:remove-source`, `world:build-it`)
- Test: component tests for each new file, plus `e2e/lumopolis-sources.spec.ts`

**Interfaces:**
- Home: title `Lumopolis`, tagline `Where AI Worlds Become Human Understanding.`, and four big choices:
  - `Map this project`
  - `Open a folder…`
  - `Open a git repository…`
  - `Design something new`

  Below them, a recent worlds list (title, kind icon, last opened, "missing" with Remove).
- Clone dialog: URL field with live `validateGitUrl` feedback, an optional branch, progress, and Cancel.
- Design start: a text area plus mic (the Plan 2 voice sink): "Describe the app you want…", then `world:design-draft`, then it opens the design world with the Ask bar in design mode (placeholder `Change the design…`).
- `Build it` (design worlds only) opens `BuildItDialog`: pick a folder (native dialog), warn if it's non-empty, choose an agent (default preselected), confirm. Main then:
  1. links the design to that folder (`registry.upsert({kind:'folder', root})` with `linkedDesign`);
  2. opens a normal agent terminal there via the existing launch path. The first prompt is: `Read the Lumopolis design first: call gateway_call with tool lumopolis/world_read and arguments {designKey: <key>}. Then build the app it describes in this folder. Design title: <title>.` (final-review fix I4: no quotes or parentheses, which the launcher's taskPromptArg drops, and the gateway's own `server/tool` call form; the title is cleaned and capped at 80 characters);
  3. switches the pane to that folder's world, where the plan overlay is on.
- **Ruling (final review I6, 2026-11-16): Build it is Claude Code only in 2.0.** Claude Code is the one agent that takes a first prompt on launch (`taskPromptArg`, applied in the renderer and again in main, only for `claude`). The dialog says so, offers the user's Claude Code profiles, and preselects the user's default among them (`defaultBuildAgent`: the active terminal's agent profile, else the newest terminal running one, else a profile the user added, else the built-in). Extending the first prompt to Codex and Gemini is post-2.0 work.
- **Folder rule (final review I3):** main accepts a Build it folder only when `world:pick-folder` returned it this session or it is already a world in the home, and never a drive or file-system root, the home folder or a folder above it, or anything under Termpolis's data folder. Removing the world stops the watch Build it started.
- `WorldSwitcher`: a toolbar dropdown of recent worlds plus "Home".

- [ ] **Step 1:** Write the component tests:
  - `home lists four actions and recents`
  - `missing entry shows Remove`
  - `clone dialog disables Clone for invalid URL with reason text`
  - `cancel during clone calls world:clone cancel`
  - `design start submits description`
  - `Build it refuses empty folder selection; warns on non-empty; confirm calls world:build-it with key, root, agent`
  - `switcher opens chosen world`
- [ ] **Step 2:** Write `e2e/lumopolis-sources.spec.ts` with the mock agent:
  - open a fixture folder → map visible;
  - Design something new → the mock agent returns a design-patch with 3 buildings → 3 wireframes;
  - refine "add Payments" → 4;
  - Build it into a temp folder → a terminal opens with the prompt text; create `src/payments/index.ts` in the test → the Payments building turns solid (plan matched) and the toast shows.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement. **Step 5:** Run all → PASS. `unset PROMPT_COMMAND && npm run test:coverage` → PASS (repo gate plus the 100% world folders).
- [ ] **Step 6:** Commit with the message `lumopolis: home, sources, design and Build it`.
