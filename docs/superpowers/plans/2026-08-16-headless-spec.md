# Workstream A — headless composition root (v1.36.0 spec)

## Decision: A1.5, but WITHOUT index.ts surgery

Recon rejected both roadmap options (A1 hidden window, A2 full Node extraction) and proposed
extracting `bootCore()` + `registerIpc()` out of `src/main/index.ts`. That is correct long-term
and too risky for one night: 147 top-level `ipcMain` registrations and a ~700-line `whenReady`
closure, with the whole desktop app downstream of any mistake.

We take the same destination by a safer road. `src/main/headless.ts` becomes an INDEPENDENT
composition root: a fourth electron-vite entry that imports the subsystems it needs directly and
never imports `index.ts`. This is viable because only 12 of 140 files under `src/main` touch
`electron` at all, and `tests/electron/memoryHostImportGraph.test.ts` already keeps a 38-module
memory subgraph Electron-free.

The headless entry's import list IS the A2 boundary spec. When A2 is done later, `index.ts` is
refactored to import the same root. Nothing built here is thrown away.

## Verified environment (probed 2026-08-16, David's Windows 11 box)

| agent | profile command | version | non-interactive form |
|---|---|---|---|
| Claude Code | `claude` (aiProfiles.ts:15) | 2.1.233 | `claude -p <prompt>` (boolean `-p/--print`, prompt POSITIONAL) |
| OpenAI Codex | `codex` (aiProfiles.ts:16) | codex-cli 0.142.5 | `codex exec [OPTIONS] [PROMPT]` (positional, or `-` / piped stdin) |
| Gemini / Antigravity | `agy` (aiProfiles.ts:17) | agy.exe 1.0.16 | `agy --print <prompt>` (prompt is the flag VALUE, not positional) |

The three shapes are genuinely different. Do not write one argv builder with a shared
"append the prompt last" branch; build them separately and test each.

Flags confirmed by probing the real binaries:

- `claude --append-system-prompt-file <file>` EXISTS on 2.1.233 but is NOT in the documented
  option list. `claude --help` shows only `--append-system-prompt <prompt>` (help line 25); the
  `-file` variant appears once in another option's prose (help line 47). Presence proven by
  `claude --append-system-prompt-file` returning
  `error: option '--append-system-prompt-file <file>' argument missing`.
- `claude --output-format <text|json|stream-json>` (only works with `--print`).
- `claude --permission-mode <mode>`, allowed choices enumerated by the CLI itself:
  `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`.
- `claude --model <model>`, `--add-dir`, `--dangerously-skip-permissions`.
- `codex exec`: `-m/--model <MODEL>`, `-C/--cd <DIR>`, `--skip-git-repo-check`,
  `--json` (events to stdout as JSONL), `-o/--output-last-message <FILE>`,
  `--output-schema <FILE>`, `-c/--config <key=value>`,
  `-s/--sandbox <read-only|workspace-write|danger-full-access>`.
- `agy`: `-p/--print <prompt>`, `--print-timeout` (default `5m0s`), `--model`, `--add-dir`,
  `-c/--continue`, `--dangerously-skip-permissions`.
- NEITHER `codex` NOR `agy` has any `--append-system-prompt*` equivalent. Confirmed absent from
  both help outputs. Headless priming for those two can only go through `memory_primer` over MCP,
  which is model-compliance-dependent (see rec-7).

---

## 1. `src/main/agentLaunch.ts` (new)

Today the three facts needed to start an agent are split across three layers and disagree:

| fact | renderer path | main path |
|---|---|---|
| base command | `DEFAULT_AI_PROFILES` aiProfiles.ts:14-18 | `wfAgentLaunch` index.ts:3174 (a duplicate literal) |
| primer file | aiProfiles.ts:69-80, Claude only | none |
| `--model` | `claudeModelArg(profile.model)` aiProfiles.ts:97 | none |
| headroom env | `claudeHeadroom: true` on the IPC payload, applied at index.ts:599 | none |
| extra PATH | `getAgentExtraPaths()` index.ts:591 | index.ts:3171 via `wfCommandSpawn` |
| trust keys | aiProfiles.ts:130-136 | none |

So workflow Agent steps today get no model flag, no primer, and bypass the headroom proxy.
`agentLaunch.ts` is the single builder both paths adopt. **No `electron` import.** All I/O is
injected, so the whole module runs under plain Node in vitest.

```ts
export type AgentId = 'claude' | 'codex' | 'gemini'

/** Every environmental fact the builder needs, injected so the module never touches Electron. */
export interface AgentLaunchDeps {
  /** proxySupervisor.getProxyEnv — returns null when the proxy is unhealthy (launch direct). */
  getProxyEnv: () => Record<string, string> | null
  /** agentPaths.getAgentExtraPaths (agentPaths.ts:71). */
  getAgentExtraPaths: () => string[]
  /** testAgents.resolveAgentCommand (testAgents.ts:25) — swaps in e2e shims. */
  resolveCommand: (command: string) => string
  /** modelBroker.claudeModelArg (modelBroker.ts:130) returns ' --model <alias>' or ''. */
  claudeModelArg: (model: string | undefined | null) => string
  platform: NodeJS.Platform
}

export interface AgentLaunchSpec {
  agent: AgentId
  cwd: string
  /** Validated by claudeModelArg for Claude; passed through as `-m` / `--model` otherwise. */
  model?: string
  /** Absolute path to a primer file. Claude only — ignored (with a reason) for codex/gemini. */
  primerFile?: string | null
  /** Route Anthropic traffic through the Headroom proxy. Default true for `claude`. */
  headroom?: boolean
  /** Escape hatch appended verbatim after everything the builder generates. */
  extraArgs?: string[]
}
```

### 1a. INTERACTIVE launch (what aiProfiles.ts does today)

Types a command into a live shell PTY. Timing-based. Keep it exactly as-is behaviourally; this
function only moves the string construction into main so both callers share one source of truth.

```ts
export interface TrustKeystroke {
  /** ms after the shell spawns. aiProfiles.ts uses testDelay() to divide by 10 under e2e. */
  delayMs: number
  data: string
}

export interface InteractiveLaunch {
  /** The full line typed into the shell, WITHOUT the trailing \r. */
  typedCommand: string
  extraPaths: string[]
  /** undefined (not null) so it drops straight into spawnTerminal's optional param. */
  extraEnv: Record<string, string> | undefined
  /** Empty for gemini. See aiProfiles.ts:130-136. */
  trustKeystrokes: TrustKeystroke[]
  /** The no-op '\r' flush then the command, mirroring aiProfiles.ts:122-127. */
  flushDelayMs: number   // 4000
  commandDelayMs: number // 500 after the flush
}

export function buildInteractiveLaunch(
  spec: AgentLaunchSpec,
  deps: AgentLaunchDeps,
): InteractiveLaunch
```

Required behaviour, each line traceable to today's code:

- `typedCommand` starts as `deps.resolveCommand(baseCommand(spec.agent))`.
- Claude and `primerFile` set: append `` ` --append-system-prompt-file "${file.replace(/\\/g, '/')}"` ``
  (aiProfiles.ts:78-79 -- the backslash-to-forward-slash rewrite is load-bearing on Windows because
  the argument is double-quoted into a bash command line).
- Claude: append `deps.claudeModelArg(spec.model)` (aiProfiles.ts:97). Invalid alias yields `''`.
- `extraEnv` = `spec.headroom !== false && spec.agent === 'claude' ? (deps.getProxyEnv() ?? undefined) : undefined`.
  The proxy env is `{ ANTHROPIC_BASE_URL: 'http://127.0.0.1:<port>',
  CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: '1', ENABLE_TOOL_SEARCH: 'true' }`
  (proxySupervisor.ts:65-72). **`ANTHROPIC_BASE_URL` is the real variable name.**
- `trustKeystrokes`: claude `[{ delayMs: 9000, data: '\r' }]`; codex `[{ delayMs: 9000, data: '1\r' }]`;
  gemini `[]`. The caller (renderer today) still owns `testDelay()` and the
  `writeIfAlive` guard -- do not move timers into this module, it must stay pure.

Callers to migrate in the same PR:
1. `launchAgentProfile` (aiProfiles.ts:44-139) calls it over IPC and keeps only the timers/UI.
2. `makeAgentRunner`'s `launch` callback (index.ts:3178, `(agent) => wfAgentLaunch[agent]`)
   becomes `(agent) => buildInteractiveLaunch({ agent, cwd, model, headroom: true }, deps).typedCommand`.
   Deleting the `wfAgentLaunch` literal at index.ts:3174 is the point of the exercise.

### 1b. HEADLESS launch (new)

Spawns the binary directly with argv. No PTY, no shell, no timers, no trust keystrokes --
`--dangerously-skip-permissions` / `--sandbox` replace the keystroke dance, and the exit code
replaces the `detectAgentStatus` heuristic.

```ts
export interface HeadlessLaunch {
  executable: string
  argv: string[]
  cwd: string
  /** Full env for the child: process.env + PATH extension + proxy env. */
  env: NodeJS.ProcessEnv
  /** 'argv' for claude/codex, 'flag-value' for gemini. Drives how prompt was embedded. */
  promptVia: 'argv' | 'flag-value' | 'stdin'
  /** Parsed shape of stdout. Differs per agent; see the table below. */
  stdoutFormat: 'claude-json' | 'codex-jsonl' | 'text'
}

export interface HeadlessLaunchSpec extends AgentLaunchSpec {
  prompt: string
  /** Claude only. One of acceptEdits|auto|bypassPermissions|manual|dontAsk|plan. Never defaulted. */
  permissionMode?: string
  /** Codex only. read-only|workspace-write|danger-full-access. Never defaulted. */
  sandbox?: string
  /** Prompts above this many bytes go over stdin instead of argv (Windows ~32k cmdline cap). */
  argvPromptMaxBytes?: number // default 8192
}

export function buildHeadlessLaunch(
  spec: HeadlessLaunchSpec,
  deps: AgentLaunchDeps,
): HeadlessLaunch
```

Exact argv, one row per agent. Order is fixed so the unit tests can assert on the array literal.

**claude**
```
executable: deps.resolveCommand('claude')
argv:       ['-p', <prompt>]
          + (model  ? ['--model', model] : [])
          + (primer ? ['--append-system-prompt-file', primerFile] : [])
          + ['--output-format', 'json']
          + (permissionMode ? ['--permission-mode', permissionMode] : [])
          + ['--add-dir', cwd]
          + extraArgs
env:        { ...process.env, PATH: <extended>, ...(getProxyEnv() ?? {}) }
stdoutFormat: 'claude-json'
```
`-p` is a boolean flag and the prompt is positional, so `['-p', prompt]` is correct.
Do NOT pass `--append-system-prompt-file` with a forward-slash rewrite here -- that rewrite exists
only because the interactive path double-quotes into bash. In argv the raw path is correct.

**codex**
```
executable: deps.resolveCommand('codex')
argv:       ['exec', <prompt>]
          + (model   ? ['--model', model] : [])
          + ['--cd', cwd, '--skip-git-repo-check', '--json']
          + (sandbox ? ['--sandbox', sandbox] : [])
          + extraArgs
env:        { ...process.env, PATH: <extended> }   // no proxy env: codex is not Anthropic
stdoutFormat: 'codex-jsonl'
```
When `prompt.length > argvPromptMaxBytes`, drop the positional and emit `['exec', '-']`, set
`promptVia: 'stdin'`, and let the runner pipe the prompt. Verified from `codex exec --help`:
"If not provided as an argument (or if `-` is used), instructions are read from stdin."

**gemini (agy)**
```
executable: deps.resolveCommand('agy')
argv:       ['--print', <prompt>]
          + (model ? ['--model', model] : [])
          + ['--add-dir', cwd]
          + extraArgs
env:        { ...process.env, PATH: <extended> }
stdoutFormat: 'text'
```
`--print` takes the prompt as its VALUE (`agy --print` alone errors
`flag needs an argument: -print`). There is no stdin fallback and no `--output-format` on 1.0.16,
so a long gemini prompt has no escape hatch -- return an error rather than silently truncating.

### 1c. The runner

```ts
export interface AgentRunResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

/** Injected so the module never imports child_process. The real impl lives in headless.ts. */
export type AgentSpawn = (
  executable: string,
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; stdin?: string },
) => Promise<AgentRunResult>

export async function runAgentHeadless(
  spec: HeadlessLaunchSpec,
  deps: AgentLaunchDeps & { spawn: AgentSpawn; timeoutMs: number },
): Promise<AgentRunResult>
```

Capped output buffer of `32_768` bytes per stream, matching `CAP` at adapters.ts:17, so a chatty
agent cannot balloon main's heap. On timeout: kill the child, return
`{ exitCode: 124, timedOut: true }` -- 124 is the code adapters.ts:27 already uses for a timed-out
command step, so the two paths agree.

---

## 2. `src/main/headlessRun.ts` (new)

One run, start to finish. No Electron import; every dependency injected.

```ts
import type { AgentId, AgentRunResult } from './agentLaunch'
import type { ScanResult, AuditEntry } from './aiSecurity'

export interface HeadlessRunSpec {
  agent: AgentId
  prompt: string
  cwd: string
  model?: string
  /** Build and pass a primer file (Claude) / rely on memory_primer (others). Default true. */
  primer: boolean
  timeoutMs: number
  /** Emit a machine-readable envelope on stdout instead of the agent's raw text. */
  json: boolean
  /** Write the outcome back into the brain. Default true. */
  record: boolean
  permissionMode?: string
  sandbox?: string
}

export interface HeadlessRunDeps {
  /** Extracted from the memory:prepare-primer-file handler (index.ts:2040-2086). Returns the
   *  written file path and how many memories the digest carried; { file: null, count: 0 } when
   *  there is no relevant memory (index.ts:2044) -- that is the relevance gate, launch bare. */
  preparePrimerFile: (query: string, cwd: string) => Promise<{ file: string | null; count: number }>
  /** aiSecurity.scanText (aiSecurity.ts:500). */
  scanText: (input: string) => ScanResult
  /** aiSecurity.appendAudit (aiSecurity.ts:536). */
  appendAudit: (entry: Omit<AuditEntry, 'ts'>) => Promise<void>
  /** aiSecurity.getSettings (aiSecurity.ts:291) -- NOT getAiSecuritySettings, which does not exist. */
  getSecuritySettings: () => { auditEnabled: boolean; memoryScrub: boolean; egressGuard: boolean }
  /** agentLaunch.runAgentHeadless, pre-bound to its own deps. */
  runAgent: (spec: { agent: AgentId; prompt: string; cwd: string; model?: string
                     primerFile?: string | null; permissionMode?: string; sandbox?: string
                     timeoutMs: number }) => Promise<AgentRunResult>
  /** memoryClient.memoryWrite (memoryClient.ts:456). */
  memoryWrite: (input: { agentId: string; kind?: string; content: string
                         tags?: string[]; taskId?: string; project?: string }) => Promise<{ id: string }>
  /** mnemeCompetence.recordOutcome (mnemeCompetence.ts:75) -- NOT recordTaskOutcome. */
  recordOutcome: (domain: string, success: boolean, now: number) => unknown
  /** Attach the transcript watcher for this run (transcriptWatchers/index.ts:30). Optional:
   *  headless reads the agent's own stdout, so the watcher is for brain ingest, not completion. */
  attachWatcher?: (terminalId: string, cwd: string, agentType: string) => { stop(): void } | null
  now: () => number
  /** Everything human-facing. Never console.log directly -- the CLI needs stdout clean for --json. */
  log: (line: string) => void
}

export interface HeadlessRunResult {
  exitCode: number
  /** The agent's stdout, or the parsed `result` field for claude-json. */
  output: string
  /** How many memories the primer injected. 0 means the run had no recall -- surface it. */
  primerCount: number
  /** Set when the perimeter refused to launch. */
  blocked?: 'secret'
  memoryId?: string
  durationMs: number
}

export async function headlessRun(
  spec: HeadlessRunSpec,
  deps: HeadlessRunDeps,
): Promise<HeadlessRunResult>
```

Order of operations, and why each step is where it is:

1. **Screen the prompt FIRST, before any priming or spawning.** `deps.scanText(spec.prompt)`.
   If `hitCount > 0`: `appendAudit({ agent: spec.agent, event: 'prompt_secret_sent',
   hitCount, byteCount: prompt.length, notes: 'headless: refused' })` and return
   `{ exitCode: 65, blocked: 'secret', primerCount: 0 }` **without spawning anything.**

   This is a DELIBERATE divergence from the interactive contract. `processOutboundChunk`
   (aiSecurity.ts:383) is watch-only by design -- `OutboundDecision.writeChunk` is documented
   "ALWAYS identical to `data`. Never withheld, never rewritten. This is the contract."
   (aiSecurity.ts:363-364), and aiSecurity.ts:339 says "WATCH, BUT DO NOT TOUCH."
   That contract exists because a human is at the keyboard and a false positive that eats a
   keystroke is worse than the leak. Headless has no human, so it fails closed.
   **Do not touch `processOutboundChunk` to achieve this.** `headlessRun` calls `scanText`
   directly. The interactive path stays watch-only.

2. **Prime.** If `spec.primer`, `await deps.preparePrimerFile(query, spec.cwd)` where
   `query = 'recent work, decisions, conventions, and context for ' + basename(cwd)`
   -- the exact query aiProfiles.ts:73-75 builds, so headless and GUI recall identically.
   `file: null` means no relevant memory: launch bare, `primerCount = 0`, and log that fact.
   Only Claude consumes the file; for codex/gemini log that priming is pointer-only.

3. **Launch** via `deps.runAgent`. Headroom routing is decided inside `buildHeadlessLaunch`
   (proxy env for `claude`, nothing for the others). The proxy must already be healthy --
   `getProxyEnv()` returns null when it is not, and a direct launch is the correct safe fallback
   (proxySupervisor.ts:66).

4. **Record.** If `spec.record` and the run produced output:
   `deps.memoryWrite({ agentId: 'headless:' + spec.agent, kind: 'task', content: <digest>,
   tags: ['headless', spec.agent], project: spec.cwd })`, then
   `deps.recordOutcome(domain, result.exitCode === 0, deps.now())` where `domain` is the
   normalized project slug. The memory scrubber is already installed globally
   (`setMemoryScrubber`, memoryClient.ts:421, wired at index.ts:2926), so the write is redacted
   on the way in -- headlessRun must NOT scrub again.

5. **Return an exit code.**

| code | meaning | precedent |
|---|---|---|
| 0 | agent exited 0 | |
| 1 | agent exited non-zero | |
| 2 | usage error (bad argv) | |
| 65 | blocked by the perimeter (`EX_DATAERR`) | new |
| 69 | a required subsystem never came up (`EX_UNAVAILABLE`) | new |
| 124 | timed out | adapters.ts:27 |
| 130 | cancelled | adapters.ts:28 |

---

## 3. `src/main/headless.ts` (new, 4th electron-vite entry)

The only file in Workstream A that imports `electron`. It imports subsystems directly and
**never imports `src/main/index.ts`** -- enforced by a build-failing test (section 6).

```ts
export interface HeadlessArgs {
  verb: 'run' | 'help' | 'version'
  agent: AgentId
  prompt: string
  cwd: string
  model?: string
  primer: boolean
  json: boolean
  record: boolean
  timeoutMs: number
  permissionMode?: string
  sandbox?: string
  /** Force a mode instead of probing. Mostly for tests. */
  mode?: 'attach' | 'own'
}

/** PURE. No Electron, no fs, no process.argv read -- the array is passed in. Fully unit-tested. */
export function parseHeadlessArgs(argv: string[]): { ok: true; args: HeadlessArgs }
                                                 | { ok: false; error: string; exitCode: 2 }

/** The entry point. Called by the index.ts guard, or directly when run as the main module. */
export async function main(argv: string[]): Promise<void>
```

### 3a. Single-instance lock -- how headless avoids `app.quit()`

index.ts:2507 `const gotTheLock = app.requestSingleInstanceLock()` runs at module top level, and
index.ts:2511 calls `app.quit()` when it fails. Headless dodges this in two layers:

1. **`headless.ts` never calls `requestSingleInstanceLock()` at all.** Electron's lock is opt-in:
   a process that does not request it neither takes nor fails a lock, and -- critically -- it does
   NOT fire the running GUI's `second-instance` handler (index.ts:2514), because that event only
   fires for instances that *requested* the lock and lost. A headless run next to the desktop app
   is therefore invisible to it.

2. **A 6-line guard in `index.ts`, replacing lines 2507-2512.** This is the ONLY edit to
   `index.ts` in v1.36.0 and it is not the bootCore/registerIpc refactor -- nothing is extracted,
   nothing moves, and the entire `else` body stays byte-identical:

```ts
// Single instance lock — prevent multiple Termpolis windows from corrupting session data.
// --headless takes no lock: it creates no window, so there is nothing to collide, and
// requesting one would make a headless run next to the desktop app quit at :2511.
const HEADLESS = process.argv.includes('--headless')
const gotTheLock = HEADLESS ? true : app.requestSingleInstanceLock()

if (HEADLESS) {
  void import('./headless.js').then((m) => m.main(process.argv))
} else if (!gotTheLock) {
  app.quit()
} else {
  /* ...lines 2513-3512 completely unchanged... */
}
```

   Verified brace structure: `} else {` is index.ts:2512 and its closing `}` is index.ts:3513
   (the last line of the file). Everything the desktop app does -- `app.whenReady()` (:2523),
   `before-quit` (:3447), `window-all-closed` (:3476), `activate` (:3512) -- lives inside that
   `else`. The guard disables the whole desktop path with one branch.

   The 147 top-level `ipcMain.handle` registrations above line 2507 still execute in a headless
   process. They are inert (no renderer, no window) and cost microseconds. Accept that in v1.36.0;
   A2 removes it.

   The guard is required because **a packaged Electron app ignores a script path in argv** --
   `Termpolis.exe out/main/headless.js` will not work, and `ELECTRON_RUN_AS_NODE=1` would strip
   away `app`, `safeStorage`, and `utilityProcess`, all of which headless needs. So the packaged
   invocation is `Termpolis.exe --headless run ...` and it must route through index.ts.

   In dev and in CI the entry is reachable directly: `npx electron out/main/headless.js --headless run ...`.
   Support both with an `import.meta.url === pathToFileURL(process.argv[1]).href` self-run check,
   the ESM analogue of `if (require.main === module)` at stdio-adapter.cjs:211.

### 3b. Two modes: `attach` and `own`

Headless shares `app.getPath('userData')` with the GUI (it must, or it reaches a different brain).
Two processes must not both own the memory host or both write `mcp-port`.

Probe `GET http://127.0.0.1:<mcpPort()>/health` before booting anything:

- **200 -> `attach`.** A GUI (or another headless run) owns the brain. Skip `startMemoryHost`,
  skip `startMcpServer`, skip the headroom proxy, and **do not write `mcp-token` or `mcp-port`.**
  Memory deps are backed by HTTP `tools/call` against the live server -- the same JSON-RPC shape
  `termpolis-cli.cjs:35-64` already speaks (`memory_search`, `memory_write`, `memory_primer`).
- **anything else -> `own`.** Full boot below; write both files; tear everything down at the end.

### 3c. Boot order for `own` mode

Mirrors index.ts:2807-3146 with the window excluded. Order matters; each line is load-bearing.

1. `app.setName('termpolis')` BEFORE any `app.getPath('userData')` read. index.ts:16-20 documents
   why: without it userData lands in `.../Roaming/Electron` and every external caller reads a
   stale `mcp-token` from the wrong dir and 401s.
2. `app.disableHardwareAcceleration()`; on macOS `app.dock?.hide()`.
3. `await app.whenReady()` -- still required: `safeStorage` and `utilityProcess` are not usable
   before it.
4. `initAuditLog(app.getPath('userData'))` (mcpServer.ts:58) -- first, so every later step is audited.
5. `initEventBus(userData)`
6. `initContextPinStore(userData)`
7. `initAiSecurity()` (aiSecurity.ts:258)
8. **`setSafeStorage(safeStorage)`** -- MANDATORY, not optional. index.ts:2813. Skipping it makes
   `secureKeyStore` fall back to plaintext secrets on disk. That is a security regression, and it
   is silent.
9. `initAnomalyLog(userData)`
10. Headroom persistence: `loadSettingsFromDisk(hrDir)`, `loadLedgerBaseFromDisk(hrDir)`,
    `setCcrDir(join(hrDir, 'ccr'))`, `setLedgerFlush(...)` -- index.ts:2818-2831, `hrDir =
    join(userData, 'headroom')`. All inside try/catch: a bad file must never take the boot down.
11. Headroom proxy: `setProxySpawner(() => createProxyTransport(hrProxyEntry))` then
    `pickFreePort().then(p => p > 0 && startProxy({ port: p }))` (index.ts:2874-2892).
    `hrProxyEntry = fileURLToPath(new URL('./headroomProxy.js', import.meta.url))` works unchanged
    from `headless.js` because both emit into `out/main/`.
    Then `setProxyMode/setProxyThinkingCap/setProxyDecay` from `getHeadroomSettings()`
    (index.ts:2881-2891). **Await proxy health (bounded, ~2s) before launching Claude**, otherwise
    `getProxyEnv()` returns null and the very first headless run silently goes direct.
12. `setMemoryHostSpawner(() => createMemoryHostTransport())` then
    `await startMemoryHost({ userDataPath, syncDir, quantize })` (memoryClient.ts:324).
    Must be awaited -- headlessRun needs the brain synchronously afterwards.
13. `setMemoryScrubber(...)` -- the same closure as index.ts:2926. Install it BEFORE any write.
14. `initCodeGraph(userData)`, `initCompetence(userData)` (mnemeCompetence.ts:45),
    `initMetrics(userData)`, `initIdentity(userData)` (index.ts:2936-2950).
15. `initWorkspaceTrust()` (index.ts:2974).
16. `startMcpServer(mcpHandlers)` (mcpServer.ts:768, called at index.ts:3146) so the launched agent
    can call back in through the stdio adapter. Then `awaitMcpPortBound()` (mcpServer.ts:733) and
    write `mcp-token` + `mcp-port` with `writeSecureFile` (index.ts:3244-3262).
    A headless `mcpHandlers` implements the memory/code/git members of `McpToolHandlers`
    (mcpServer.ts:491-525) and returns a clear error from the terminal/swarm members -- there are
    no terminals in a headless process.

**Explicitly NOT booted:** `installApplicationMenu` (index.ts:2526), `createWindow` (:2527),
`repairWindowsShortcuts` (:2535), `initAutoUpdater`, `dailyLaunchPing`, `initCrashWatch` (:2962),
`startIndexer` (:2985), `runConversationIngest` (:2990) -- background ingest would make a CI run's
duration depend on how much history is on disk.

### 3d. Perimeter for headless

rec-4's finding is that every guard except the memory scrub hangs off renderer IPC, so a headless
run would have zero enforcement. Minimum for v1.36.0:

- Prompt screening: done in `headlessRun` step 1 (fail closed).
- Egress: after the agent child spawns, run the sweep on an interval against the CHILD's pid --
  `pollAgentEgress(pid)` (egressAudit.ts:133) -> `recordEgress(terminalId, endpoints)`
  (egressAudit.ts:158) -> `judgeEgress(endpoints)` (egressGuard.ts:212), appending an
  `egress_violation` AuditEntry per violation. Gate on `getSettings().egressGuard`
  (aiSecurity.ts:291/:317). `unref()` the timer so it can never hold the exit open --
  that is the v1.35.1 shutdown-watchdog lesson.
- Transcript ingest: `attachWatcher(runId, cwd, agentType)` (transcriptWatchers/index.ts:30) so
  the run's conversation reaches the brain, and `detachAllWatchers()` in teardown.

### 3e. Staged shutdown

Same shape as index.ts:3476-3513, but headless ends with `app.exit(code)` and there is no
`window-all-closed` to hang it off (no window is ever created, so that event never fires).

```
let stage = 'start'
const watchdog = setTimeout(() => {
  console.error(`[headless] shutdown stalled after "${stage}" — forcing exit`)
  process.exit(code)
}, 5000)
watchdog.unref?.()          // index.ts:3491 — must never delay a healthy exit
try { detachAllWatchers() } catch {}   ; stage = 'watchers'
try { clearInterval(egressTimer) } catch {}
try { shutdownEventBus() } catch {}    ; stage = 'bus'
try { stopMemoryHost() } catch {}      ; stage = 'memory'
try { stopProxy() } catch {}
try { saveProxyTotalsToDisk(join(userData, 'headroom')) } catch {}
if (mcpServer) { try { stopMcpServer(mcpServer) } catch {} ; mcpServer = null }
stage = 'mcp'
app.exit(code)
```

Arm the watchdog BEFORE the first teardown line -- that is exactly the v1.35.1 fix
(index.ts:3477-3484): every line between here and the exit can throw, and `stopMcpServer` is the
one that historically hung. `app.exit(code)` does NOT run `before-quit` handlers, which is what we
want: headless registers none and runs its teardown explicitly above.

---

## 4. `src/mcp-adapter/termpolis-cli.cjs` changes

### 4a. The `run` verb collision -- resolved

`run <id> <command>` already exists (termpolis-cli.cjs:119-125) and means "run a shell command in
an existing terminal" (it calls the `run_command` MCP tool). It is documented twice in the file --
the header comment at :7 and the help text at :77 -- and is a published CLI surface.

**Decision: do not touch `run`.** Silently changing a shipped verb breaks user scripts with no
error. The headless verb is **`agent`**:

```
termpolis-cli agent <claude|codex|gemini> <prompt...>   Run a headless agent turn
    --cwd <dir>           working directory (default: process.cwd())
    --model <alias>       model override
    --no-primer           skip memory priming
    --json                emit a machine-readable envelope
    --timeout <ms>        default 600000
```

`run-agent` is registered as a hidden alias (accepted, not listed in help) so the recon's
suggested name still works. Add both to the switch at :89-163 and `agent` to the help text at
:70-84 and the header comment at :5-12.

### 4b. Read the port file -- fix the hardcoded 9315

termpolis-cli.cjs:33 is `const PORT = 9315` and never reads the `mcp-port` file that
index.ts:3254 writes and stdio-adapter.cjs:44-51 honors. Any headless CLI work inherits the bug.

Do not copy `findPort()` into a third file. `dataDir.cjs` exists precisely so this logic cannot
drift (see termpolis-cli.cjs:17 and stdio-adapter.cjs:26-27). Move it there:

```js
// src/mcp-adapter/dataDir.cjs — append, then export
/** The port Termpolis's MCP server bound to, or the 9315 default when unknown. */
function mcpPort() {
  try {
    const port = parseInt(fs.readFileSync(dataFile('mcp-port'), 'utf-8').trim(), 10)
    if (port > 0 && port < 65536) return port
  } catch {}
  return 9315
}
module.exports = { termpolisDataDir, dataFile, mcpPort }
```

`dataDir.cjs` does not currently require `fs` (only `path` and `os`, lines 15-16) -- add it.
Then termpolis-cli.cjs:33 becomes `const PORT = mcpPort()`, and stdio-adapter.cjs:44-53 deletes
its local `findPort()` in favour of `const MCP_PORT = mcpPort()`. One implementation, two callers,
and `tests/electron/mcpAdapterDataDir.test.ts` already exists to cover it.

Also fix `findToken()` (termpolis-cli.cjs:21-30): it calls `process.exit(1)` at module load when
the token file is missing. That is wrong for the `agent` verb, which must work with the GUI down.
Make it lazy -- return `null`, and only exit for verbs that need a live server.

### 4c. New memory verbs

Pure additions to the switch at :89-163; each maps to an existing MCP tool (mcpServer.ts:527-654),
so no server change is needed:

| verb | MCP tool | notes |
|---|---|---|
| `memory-search <query> [limit]` | `memory_search` | `diversify` defaults true server-side (mcpServer.ts:583) |
| `memory-write <text> [--kind k] [--project p]` | `memory_write` | `agentId: 'cli'`; project defaults to `process.cwd()` the way the stdio adapter does (stdio-adapter.cjs:129-137) |
| `memory-primer [cwd]` | `memory_primer` | returns `{ project, primer }` (mcpServer.ts:509) |
| `memory-list [limit]` | `memory_list` | |
| `memory-related <id-or-query>` | `memory_related` | |

### 4d. Starting a headless run when the GUI is NOT running

The `agent` verb always spawns the headless Electron process; the *process* decides attach vs own
(section 3b). The CLI's only job is to find the binary:

1. `process.env.TERMPOLIS_EXE` if set.
2. Platform defaults:
   - win32: `%LOCALAPPDATA%\Programs\termpolis\Termpolis.exe`
   - darwin: `/Applications/Termpolis.app/Contents/MacOS/Termpolis`
   - linux: `/opt/Termpolis/termpolis`, then `/usr/bin/termpolis`
3. Dev fallback: if `out/main/headless.js` exists relative to the repo root, use
   `npx electron out/main/headless.js`.
4. None found: exit 69 with "Termpolis is not installed. Set TERMPOLIS_EXE or install from
   https://termpolis.com" -- the same degraded-mode tone stdio-adapter.cjs:90 uses.

Spawn `<exe> --headless run --agent <a> --cwd <d> --prompt <p> [flags]` with
`stdio: 'inherit'`, and `process.exit(child.status)` so exit codes propagate to CI.
The GUI does not need to be running, and if it IS running the headless process attaches instead of
booting a second brain.

---

## 5. `electron.vite.config.ts`

One addition, inside `main.build.rollupOptions.input`, after the `headroomProxy` entry
(config lines 28-31):

```ts
          // v1.36: the headless composition root — a FOURTH main-process entry, emitted next to
          // index.js so `Termpolis.exe --headless` can hand off to it. It imports subsystems
          // directly and never imports index.ts; headlessImportGraph.test.ts enforces that.
          headless: resolve(__dirname, 'src/main/headless.ts'),
```

Nothing else changes. `headless.js` inherits the same
`externalizeDepsPlugin({ exclude: ['pngjs'] })` (config line 40) and the
`process.env.SENTRY_DSN` define (config lines 33-35) as the other three entries, and lands in
`out/main/` alongside `index.js`, `embedWorker.js`, `memoryHost.js`, and `headroomProxy.js` --
which is what makes the `new URL('./headroomProxy.js', import.meta.url)` resolution in section 3c
work unchanged.

---

## 6. Test plan

### 6a. New unit tests (`tests/electron/`)

**`tests/electron/agentLaunch.test.ts`**
- `buildHeadlessLaunch` returns the exact argv array for each of the three agents (assert the
  literal array, not a substring match), for: bare, `+model`, `+primerFile`, `+permissionMode`,
  `+sandbox`, `+extraArgs`.
- Claude with `primerFile` gets the RAW path (no forward-slash rewrite); the interactive builder
  does rewrite it. Asserting both in one file is the point -- it is the easiest thing to get wrong.
- Codex with a prompt over `argvPromptMaxBytes` switches to `['exec','-']` and
  `promptVia: 'stdin'`. Gemini over the cap returns an error instead of truncating.
- `extraEnv` carries `ANTHROPIC_BASE_URL` for Claude only, and is `undefined` when the injected
  `getProxyEnv` returns null.
- `buildInteractiveLaunch` PARITY: the generated `typedCommand` for
  `{ agent:'claude', model:'opus', primerFile:'C:\\p\\x.txt' }` equals the string aiProfiles.ts
  builds today (assert against a literal, so a future aiProfiles change breaks this test loudly).
- Trust keystrokes: claude `\r`@9000, codex `1\r`@9000, gemini `[]`.
- `runAgentHeadless` with a fake `AgentSpawn`: exit 0, non-zero, timeout -> 124, output capped at
  32768 bytes per stream.

**`tests/electron/headlessRun.test.ts`**
- Prompt containing a secret -> `exitCode 65`, `blocked:'secret'`, `runAgent` NEVER called,
  one `prompt_secret_sent` audit entry. This is the fail-closed proof.
- Clean prompt -> primer prepared, agent launched, memory written, `recordOutcome` called with
  `success === (exitCode === 0)`.
- `preparePrimerFile` returning `{ file: null, count: 0 }` -> launches bare, `primerCount: 0`,
  a log line saying so (no silent empty digest).
- `preparePrimerFile` throwing -> run still proceeds, `primerCount: 0`, warning logged.
- `spec.primer === false` -> `preparePrimerFile` never called.
- Non-Claude agents never receive a `primerFile`.
- Exit-code mapping table covered end to end.

**`tests/electron/headlessArgs.test.ts`**
- `parseHeadlessArgs` over the full flag matrix; unknown flag -> `{ ok:false, exitCode:2 }`;
  missing `--prompt` -> error; `--cwd` defaults; `--timeout` non-numeric rejected;
  `--no-primer` and `--json` boolean handling; `run-agent` alias accepted.

**`tests/electron/headlessBoot.test.ts`**
- Boot order asserted as an array of spy call names, with every subsystem injected.
- `setSafeStorage` is called BEFORE `startMemoryHost` (the plaintext-downgrade regression).
- `setMemoryScrubber` is installed before any `memoryWrite`.
- `attach` mode (health probe 200): `startMemoryHost`, `startMcpServer`, `writeSecureFile` are
  all NOT called. `own` mode: all three ARE, and `mcp-port` is written after `awaitMcpPortBound`.
- Teardown runs in order and calls `app.exit(code)` exactly once; a throw in the middle still
  reaches the exit; the watchdog is `unref()`d.
- No `BrowserWindow` is ever constructed.

**`tests/electron/headlessImportGraph.test.ts`** -- the guard for the whole decision.
Modeled on the existing `tests/electron/memoryHostImportGraph.test.ts`, which already keeps a
38-module subgraph Electron-free. Walk `src/main/headless.ts`'s transitive import graph and fail
if `src/main/index.ts` appears anywhere in it. Also assert `agentLaunch.ts` and `headlessRun.ts`
import neither `electron` nor `child_process` (both are injected).

**`tests/electron/termpolisCli.test.ts`** -- siblings: `mcpAdapterDataDir.test.ts`,
`mcpAdapterProjectScope.test.ts`, `stdioAdapterContract.test.ts`.
- `mcpPort()` from `dataDir.cjs`: reads the file, rejects 0 and >=65536, falls back to 9315 when
  the file is missing or garbage.
- The verb table still contains `run` with its ORIGINAL `run_command` meaning (regression guard
  for the collision decision), and `agent` maps to the headless spawn.
- Binary resolution honours `TERMPOLIS_EXE`, then the platform defaults, then the dev fallback,
  then exits 69.
- **Prerequisite:** `termpolis-cli.cjs:170` currently calls `main()` unconditionally, so
  `require()`-ing it from a test executes the CLI. Add
  `if (require.main === module) main()` plus `module.exports = { ... }` -- the exact pattern
  stdio-adapter.cjs:211-213 already uses.

**`tests/electron/mcpAdapterPackaging.test.ts`** (extend the existing file, do not add a new one)
- Assert `electron.vite.config.ts` declares all four main inputs, including `headless`.
- Assert `out/main/headless.js` is included in the electron-builder `files` glob.

### 6b. Coverage

The gate is **lines 97 / functions 96 / branches 95 / statements 96** (vitest.config.ts:106-109),
Windows CI only. **It does not move.** Backfill tests on the offending file instead.

`src/main/**/*.ts` is in `coverage.include` (vitest.config.ts:57) and the only excluded main
files are `types.ts`, `sentry.ts`, `autoUpdater.ts`, and `embedWorker.ts`
(vitest.config.ts:64-68). **Do not add `headless.ts` to that list.** Instead:

- `agentLaunch.ts` and `headlessRun.ts` are pure with injected deps -- take them to 100%. They are
  the buffer that pays for `headless.ts`.
- In `headless.ts`, wrap only the irreducible Electron glue (the real `createProxyTransport` /
  `createMemoryHostTransport` spawners, the `child_process` spawn impl, `app.exit`) in
  `/* v8 ignore start -- thin Electron wrapper; needs a real Electron runtime */ ... /* v8 ignore stop */`.
  That is the exact precedent at proxySupervisor.ts:122-135. Everything else in the file --
  argv parsing, mode selection, boot sequencing, teardown, exit-code mapping -- must be exported
  and unit-tested.

### 6c. e2e acceptance: `e2e/headless-run.spec.ts`

Uses `e2eUserDataDir` / `e2eLaunchArgs` / `e2eShimEnv` (e2e/helpers/launch.ts:42, :51, :69) and the
existing mock agents (`e2e/mocks/mock-claude.cjs`, `e2e/test-shims/`). Every case runs against an
isolated `--user-data-dir` so it cannot touch a developer's real brain.

1. **GUI down, run succeeds.** Spawn `electron out/main/headless.js --headless run --agent claude
   --cwd <tmp> --prompt "say ok" --json` with `TERMPOLIS_TEST_SHIM_DIR` on PATH. Assert exit 0,
   stdout parses as JSON, and the envelope's `primerCount` is a number.
2. **Memory round-trip, headless -> GUI.** The headless run writes a memory; then launch the GUI
   on the SAME user-data-dir and assert the memory is recalled. Mirrors the existing
   `e2e/memory-cross-agent-recall.spec.ts`. Assert a NON-ZERO recall count -- a silent empty
   digest must fail the build.
3. **Fail closed on a secret.** Prompt carrying a synthetic secret. Build the fixture with
   `'a'.repeat(N)` so it fails entropy heuristics while still matching the regex -- GitHub push
   protection blocks realistic secret samples in committed tests. Assert exit **65**, assert the
   mock agent NEVER ran (the mock writes a sentinel file on start; assert it is absent), and
   assert one `prompt_secret_sent` row in the audit JSONL.
4. **Clean exit, no window.** Assert the process exits within 5s (proving the shutdown watchdog
   and the `unref`d timers), and that no window was created.
5. **Coexistence with a running GUI.** Launch the GUI, capture `mcp-port`, then run a headless
   turn. Assert: the GUI window is still alive (no `app.quit()` from the instance lock), the
   headless run exits 0, and `mcp-port` is byte-identical afterwards (proving `attach` mode did
   not rewrite it).
6. **CLI end to end.** `node src/mcp-adapter/termpolis-cli.cjs agent claude "say ok"` with
   `TERMPOLIS_EXE` pointed at the test Electron binary. Assert the child's exit code propagates.

The whole `e2e/` dir runs sharded and BLOCKING in CI (test.yml:176 `shard: [1,2,3,4]`, :200).
This spec must be deterministic and fit the shard budget -- no real network, mock agents only.

---

## 7. Unverified / risky

- **`--append-system-prompt-file` is undocumented.** It works on claude 2.1.233 (proven by the
  argument-missing error), but it is absent from the documented option list in `--help`. A future
  Claude Code release could drop it without a deprecation notice, which would silently un-prime
  every launch. Mitigation: probe once at boot and fall back to
  `--append-system-prompt "<file contents>"`, which IS documented.
- **No system-prompt injection exists for codex or agy.** Verified absent from both help outputs.
  Headless priming for those two is pointer-only over `memory_primer`, i.e. compliance-dependent
  (rec-7 calls this the single largest gap against "Codex must have the same memory as Claude").
  Do not claim parity in release notes.
- **Output formats do not unify.** Claude `--output-format json`, codex `--json` (JSONL events),
  agy plain text only (no `--output-format` on 1.0.16). The `--json` envelope must be built by
  Termpolis per agent, not passed through.
- **`agy` is what is installed here.** `aiProfiles.ts:17` ships `command: 'agy'`, and agy.exe
  1.0.16 is present on this machine. Whether `agy` resolves on a clean install of the Gemini CLI
  was not verified.
- **Line numbers.** This spec uses ripgrep/`Get-Content` numbering, which matches the recon files
  (index.ts:2507 lock, :3174 wfAgentLaunch, :3476 window-all-closed, :3146 startMcpServer).
  A parallel recon pass reported some later anchors three lines higher (:3149, :3479). Re-grep
  before editing rather than trusting either number.
- **rec-4 names two functions that do not exist.** `getAiSecuritySettings()` is really
  `getSettings()` (aiSecurity.ts:291), and there is no `listTerminalIds()` in terminalManager.ts
  (its full export list is spawnTerminal, killTerminal, writeToTerminal, resizeTerminal, killAll,
  getTerminalPid, getTerminalCwd, getTerminalCwdAsync, computeWindowsPty). Read-output buffering
  lives in index.ts, not terminalManager. `resolveShellExecutable` is in shellDetector.ts:82.
- **`recordTaskOutcome` does not exist.** The recorder is
  `recordOutcome(domain, success, now)` (mnemeCompetence.ts:75).
- **There is no `preparePrimerFile()` to reuse.** The logic is inline in the
  `memory:prepare-primer-file` IPC handler (index.ts:2040-2086): it calls `buildContextPrimer`
  (contextPrimer.ts:202), writes `primer-<uuid>.txt`, sweeps files older than 5 minutes, and
  counts digest lines starting with `- [`. Extracting those ~46 lines into a reusable function is
  the recommendation, but it IS a second edit to index.ts beyond the section-3a guard. Flag it
  before starting; duplicating the logic instead would let the GUI and headless primers drift.
- **`attach` mode is new code with no in-main precedent.** An HTTP-backed memory dep object is
  proven only from the CLI/adapter side. If it slips, ship `own` mode only and have the CLI refuse
  to start when a GUI is already running -- a clear error beats two processes appending to one JSONL.
- **A GUI starting mid-run is not handled.** The health probe is a point-in-time decision.
- **Headless completion is `exitCode`, not the `detectAgentStatus` heuristic** that
  `makeAgentRunner` polls (adapters.ts:100-108). That is an improvement, but headless and
  workflow Agent steps will disagree about "done" until adapters.ts migrates.
- **The 147 inert `ipcMain.handle` registrations** still run in a headless process under the
  section-3a guard. Harmless but untidy, and it means `headless.ts` shares a process with a fully
  registered IPC surface that nothing can reach. A2 removes it.
- **Bounded proxy-health wait is a guess.** If the headroom proxy has not reported `ready` before
  the first Claude launch, `getProxyEnv()` returns null and the run silently goes direct -- correct
  but unmeasured. The ~2s figure in section 3c was not benchmarked.
- **Egress attribution inherits DNS shared fate** (egressAttribute.ts:34-37) and `sentry.io` sits
  on the anthropic allowlist rule (egressGuard.ts:82). Headless does not make this worse, but it
  does not fix it either.
