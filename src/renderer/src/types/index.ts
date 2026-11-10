import type { AppLogEntry, AppLogLevel } from '../../../shared/appLog'
import type {
  AgentIntegrationSetRequest, AgentIntegrationSetResult, AgentIntegrationStatus, CodexLaunchContext,
} from '../../../shared/agentIntegration'
import type {
  AccountAgent, AccountChangesResult, AccountPatch, AccountRowView, AccountsView, AddAccountRequest,
  AddAccountResult, ImportPreview, ImportResult, LaunchLineRequest, LaunchLineResult, NoteLimitRequest,
  PickFolderResult, ProfileAgent, RecopyView, 
  TerminalAccountEvent,
} from '../../../shared/agentAccounts'
import type { AgyStepOutcome, AgyStepRequest, ModelHold, ModelHoldRequest, SwitchOutcome, SwitchProgress, SwitchRequest } from '../../../shared/accountSwitch'
import type { SignInInput, SignInStartRequest, SignInState } from '../../../shared/signInScreens'
import type { LimitLook } from '../../../shared/accountLimits'
import type { RouteDecision } from '../../../shared/taskRouter'
import type { ModelCatalog } from '../lib/modelCatalog'

export type ShellType = 'bash' | 'zsh' | 'cmd' | 'powershell' | 'gitbash'

export type ViewMode = 'tabs' | 'split'

export type PaneNode =
  | { type: 'terminal'; terminalId: string }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; ratio: number; children: [PaneNode, PaneNode] }

export interface ShellInfo {
  type: ShellType
  label: string
  executable: string
}

export interface TerminalSession {
  id: string
  name: string
  color: string
  shellType: ShellType
  cwd: string
  fontSize: number
  theme: string
  fontFamily: string
  agentCommand?: string
  /** The account Termpolis launched or switched this terminal's agent on, as main answered it
   *  (accounts:launch-line): kept in workspaces, so a restored one launches on the same account.
   *  `agentCommand` stays the bare CLI line, which is how the agent is known. */
  agentAccountId?: string
  /** Claude Code: the session Termpolis started it with (--session-id) or resumed, which a switch
   *  resumes when the agent printed no exit hint. */
  agentSessionId?: string
  /** A swarm worker's agent, as main recorded the command run_command started it with: a worker
   *  has no agentCommand, and its terminal's name is the conductor's choice. */
  swarmAgent?: AccountAgent
  isSwarm?: boolean
  hidden?: boolean
  isConductor?: boolean
  /** Set when the terminal was seeded with project memory at launch (e.g. Claude
   *  via --append-system-prompt-file), so useAutoPrimer skips the typed pointer. */
  launchPrimed?: boolean
  /** v1.55.0 Auto: the model and effort the task router picked at launch (the header chip). */
  routed?: RouteDecision
  /** Set once the launch memory pointer has been pasted into THIS terminal. Lives
   *  on the terminal rather than in the pane's React state because the pane
   *  remounts — on a view-mode toggle, a hide/unhide, a workspace switch — and a
   *  per-mount guard let every remount paste the pointer again. */
  primerPointed?: boolean
}

export interface Workspace {
  id: string
  name: string
  terminals: Omit<TerminalSession, 'id'>[]
}

export interface AIProfile {
  id: string
  name: string
  icon: string
  iconImage?: string
  command: string
  shell: string
  color: string
  /** Optional Claude model alias (opus/sonnet/haiku), appended as --model on launch. */
  model?: string
}

export interface PromptTemplate {
  id: string
  name: string
  text: string
  icon: string
  isCustom?: boolean
}

/**
 * A user-defined keyboard shortcut that types a snippet (or runs a command)
 * into the active terminal. Distinct from the fixed KeybindingMap actions:
 * these are open-ended macros the user adds themselves.
 */
export interface CustomKeybinding {
  id: string
  /** Human label shown in Settings and used for conflict messages. */
  label: string
  /** Key combo string, e.g. "Ctrl+Alt+G" (same grammar as KeybindingMap values). */
  combo: string
  /** Text sent to the active terminal when the combo fires. */
  text: string
  /** When true, a carriage return is appended so the command executes. */
  runOnSend: boolean
}

export interface WorkflowTerminal {
  name: string
  command: string
  shell: string
  color: string
}

export type WorkflowLayout = 'vertical' | 'quad'

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  icon: string
  terminals: WorkflowTerminal[]
  layout: WorkflowLayout
  isCustom?: boolean
}

export interface SessionData {
  terminals: TerminalSession[]
  workspaces: Workspace[]
  defaultShell: ShellType
  viewMode: ViewMode
  keybindings?: Record<string, string>
  customKeybindings?: CustomKeybinding[]
  voiceSettings?: unknown // persisted blob; renderer sanitizes via sanitizeVoiceSettings on load
  aiProfiles?: AIProfile[]
  promptTemplates?: PromptTemplate[]
  userWorkflows?: WorkflowTemplate[]
  agentRatingOverrides?: Record<string, Record<string, number>>
  allowAppMouseControl?: boolean
}

export interface HistoryEntry {
  terminalId: string
  terminalName: string
  command: string
  timestamp: number
}

/** A DISCRIMINATED union, not `{success: boolean; data?: T}`. With the old shape `if (res.success)`
 *  narrowed nothing — `data` stayed `T | undefined` — so every call site was free to write
 *  `setStats(res.data)` and ship a silent `undefined` into state. TS only tells you that if `success`
 *  discriminates. (It was telling us: 15 errors across two files, in a project nothing typechecked.) */
export type IpcResponse<T = undefined> =
  | { success: true; data: T; error?: undefined }
  | { success: false; error: string; data?: undefined }

/** Telemetry consent as main holds it (telemetry:get-consent / telemetry:set-consent). */
export interface TelemetryConsentView {
  /** Crash reports: errors and stack traces, scrubbed of the user's paths and name. */
  crash: boolean
  /** Usage statistics: the once-a-day launch ping and feature events. */
  usage: boolean
  /** The consent version the answer was given under; 0 when never asked. */
  consentVersion: number
  /** The user has not answered under the current consent version and should be asked. */
  needsReview: boolean
}

export interface PlatformInfo {
  /** process.platform of the host (e.g. 'win32', 'darwin', 'linux'). */
  platform: string
  /** xterm.js `windowsPty` option on Windows (backend + OS build) so the
   *  emulator's reflow/scrollback match ConPTY; null off Windows. */
  windowsPty: { backend: 'conpty' | 'winpty'; buildNumber: number } | null
  /** The host's home directory, so the renderer can expand a leading `~`.
   *  A Git Bash prompt reports `~/repos/x`, and the renderer has no `process`
   *  to resolve it with: without this, `normalizeShellPath` leaves the tilde
   *  verbatim, the store holds a path git cannot chdir to, and every consumer
   *  (git dot, Changes panel, status bar) reads it as "not a repository". */
  homedir: string
}

export interface CodeGraphStats {
  files: number
  symbols: number
  edges: number
}
export interface CodeSymbolHit {
  id: string
  name: string
  kind: string
  file: string
  startLine: number
  endLine: number
  lang: string
}
export interface CodeExploreResult {
  symbol: CodeSymbolHit
  source: string
  callers: CodeSymbolHit[]
  callees: CodeSymbolHit[]
}

export interface ProxyTotalsView {
  requests: number
  textOrigTokens: number
  textSavedTokens: number
  savedPct: number
  images: number
  imageOrigBytes: number
  imageSavedBytes: number
  cacheReadTokens: number
  cacheCreationTokens: number
  inputTokens: number
  outputTokens: number
  retrieves: number
  givebackTokens: number
  toolUseOrigTokens: number
  toolUseSavedTokens: number
  worstSavedPct: number
  belowFloorRequests: number
  floorEligibleRequests: number
}

/** What the wire proxy is really doing, as opposed to what Settings asked for. */
export interface ProxyStatusView {
  enabled: boolean
  running: boolean
  healthy: boolean
  /** The variable that made the proxy step aside for the user's own routing, or null. */
  bypassVar: string | null
  selectedMode: HeadroomSettingsView['mode']
  /** The tier actually in force — floor control can raise it above selectedMode. */
  effectiveMode: HeadroomSettingsView['mode']
  /** The first-sight policy Settings holds now, and the one the proxy froze at launch and runs. They
   *  differ between a change in Settings and the next start. Absent from a main process that predates it. */
  selectedFirstSight?: HeadroomSettingsView['firstSightElision']
  effectiveFirstSight?: HeadroomSettingsView['firstSightElision']
}
export interface HeadroomSettingsView {
  enabled: boolean
  /** Route new Claude Code launches through the local compression proxy. On by default. */
  wireProxy: boolean
  mode: 'conservative' | 'balanced' | 'aggressive' | 'max'
  steering: boolean
  /** Ceiling on extended-thinking budget, in tokens. 0 = off (default). */
  thinkingCap: number
  /** Let launch-time steering strength follow measured output volume. */
  adaptiveSteering: boolean
  /** Under the Legacy first-sight policy only: let the launch-time wire tier escalate when the measured
   *  50% savings floor isn't holding. The default Late policy removes less tool text on purpose and ignores it. */
  floorControl: boolean
  /** Age the oldest half of a long conversation down to retrievable stubs. On by default since v1.36.0. */
  prefixDecay: boolean
  /** When a tool result may be shortened the first time the model sees it: `late` leaves it whole
   *  until 40,000 characters (the default since v1.55), `legacy` shortens from the tier's own size.
   *  Takes effect when Termpolis next starts. */
  firstSightElision: 'late' | 'legacy'
  /** A smaller window for Claude Code's own auto-compaction, in tokens (100,000 to 1,000,000); 0 = Off, the
   *  default. Opt-in: a long conversation then compacts sooner. Reaches new Claude terminals only. Absent
   *  from a main process that predates it, which is Off. */
  contextCap?: number
}

/** What a conversation costs per turn at its current depth, against what the same user's own
 *  shallow sessions cost. Mirrors main's `DepthAdvice`; null until both bands have enough
 *  samples to be this user's curve rather than one session's accident. */
export interface DepthAdviceView {
  messages: number
  bandIndex: number
  unitsPerTurnNow: number
  unitsPerTurnFresh: number
  savingPerTurn: number
  savingPct: number
  requestsNow: number
  requestsFresh: number
}

/** Both Token Headroom layers summed, with retrieve_full give-backs subtracted exactly once. */
export interface UnifiedTotalsView {
  requests: number
  wireOrigTokens: number
  wireSavedTokens: number
  images: number
  imageOrigBytes: number
  imageSavedBytes: number
  toolOrigTokens: number
  toolSavedTokens: number
  toolEvents: number
  byTool: Record<string, number>
  retrieves: number
  givebackTokens: number
  /** Turns whose only tool calls were `retrieve_full`, and what they cost in effective units. The
   *  headline nets these; `givebackTokens` prices the text that came back, not the turn. */
  retrievalTurns: number
  retrievalTurnUnits: number
  /** Responses whose shape was read for retrieval turns. Counted from v1.55, while `requests` has counted
   *  every response since v1.29, so the share of the history the headline has netted is this over `requests`. */
  turnRequests: number
  /** Tokens a request kept off the wire that its own conversation had already fetched back: the credit
   *  is withdrawn for them, since the text was on the wire again. Already out of `netSavedTokens`. */
  askedBackTokens: number
  /** What the tool results in forwarded requests were, by what was done to them, summed over requests. */
  stubKinds: {
    plain: number
    compact: number
    dedup: number
    diff: number
    aged: number
    /** Aged-out stubs in a body too short for the decay pass to have made them. */
    agedEarly: number
    /** Requests that carried at least one of those. */
    agedEarlyRequests: number
  }
  grossSavedTokens: number
  netSavedTokens: number
  savedPct: number
  cacheReadTokens: number
  cacheCreationTokens: number
  inputTokens: number
  outputTokens: number
  /** The tool_use (agent's own output, re-read from the prefix) half of the wire figures. */
  toolUseOrigTokens: number
  toolUseSavedTokens: number
  /** Per-request floor evidence: the worst single request, and how many missed the 50% floor. Counted over
   *  the requests that ran the Legacy behaviour (the Settings kill switch and the holdout); Late is not held to a floor. */
  worstSavedPct: number
  belowFloorRequests: number
  floorEligibleRequests: number
  bill: BillBreakdownView
  /** `retrieve_full` calls that found nothing. Any value above 0 means an elision was not
   *  reversible after all — surfaced as an alarm, never rounded away. */
  retrieveMisses: number
  /** `retrieve_full` calls for a token shape the app never mints — a mistyped or invented handle.
   *  Separate from `retrieveMisses`: it says nothing about whether content survived. */
  retrieveBadTokens: number
  /** `retrieve_full` calls for a well-shaped token the app has no record of ever holding. Tokens
   *  are content hashes, so a typo of a live one is indistinguishable by shape from the real one —
   *  which is why this is reported separately and never as lost content. */
  retrieveUnknownTokens: number
  /** `retrieve_full` calls for content the 200 MB disk cap aged out. Really gone, but working as
   *  designed — the answer is a bigger cap, not a bug report. */
  retrieveExpired: number
  /** Records dropped by the LRU with no durable copy behind them — content the app destroyed. */
  unbackedEvictions: number
  /** Prefix head (system prompt + tool schemas), per request, in tokens — the slice no
   *  compression layer touches. Shown so the receipt states its own limits. */
  sysTokensPerRequest: number
  toolsTokensPerRequest: number
  tpToolsTokensPerRequest: number
  toolCount: number
  /** Output steering, observed. Two means, never presented as a saving. */
  steeredRequests: number
  unsteeredRequests: number
  steeredAvgOutput: number
  unsteeredAvgOutput: number
}

/** Mirror of the main-process `BillBreakdown` — the same activity priced in effective units
 *  (cache-read 0.1x, cache-write 1.25x, input 1x, output 5x) so the dashboard can quote a share
 *  of the invoice rather than a share of the text the compressor was allowed to touch. */
export interface BillBreakdownView {
  cacheRead: number
  cacheCreation: number
  input: number
  output: number
  total: number
  cacheReadPct: number
  cacheCreationPct: number
  inputPct: number
  outputPct: number
  prefixTokenWeight: number
  /** Units kept off the bill before the cost of the retrieval turns. */
  grossAvoided: number
  /** Units the turns that only fetched elided text cost. */
  retrievalTurnUnits: number
  /** `grossAvoided - retrievalTurnUnits`: the headline. Negative when the turns cost more. */
  avoided: number
  totalBillSavedPct: number
}

/** One class of elided result: how it was replaced, which tool, how big, and how often the model asked
 *  for the text back. Mirrors the main-process `ElisionClassView`. */
export interface ElisionClassView {
  key: string
  kind: 'compact' | 'dedup' | 'diff' | 'decay'
  tool: 'Read' | 'Bash' | 'Grep' | 'Glob' | 'PowerShell' | 'WebFetch' | 'WebSearch' | 'mcp' | 'other'
  band: '<1.6k' | '1.6-4k' | '4-10k' | '10-40k' | '40k+'
  /** The first-sight policy a compaction was made under: `late`, or `legacy` for the old behaviour (the
   *  holdout, the Legacy setting, a ledger from before). Every other kind reports `legacy`. */
  policy: 'late' | 'legacy'
  elided: number
  redeemed: number
  ratePct: number | null
  recentElided: number
  recentRedeemed: number
  recentRatePct: number | null
  /** The redemption rate above which eliding this class at first sight loses; first-sight classes only. */
  breakEvenPct: number | null
  netUnitsPer1000: number | null
  verdict: 'pays' | 'costs' | 'unknown'
  basis: 'recent' | 'all-time' | null
}

/** One arm of the late-against-holdout comparison. Mirrors the main-process `ArmSummary`. */
export interface ArmSummaryView {
  requests: number
  working: number
  turns: number
  groups: number
  sharePct: number | null
  /** The share of billed units that went on retrieval turns, percent. */
  turnUnitSharePct: number | null
  unitsPerRequest: number | null
  unitsPerWorking: number | null
  turnUnitsPerWorking: number | null
}

/** Late against the conversations held out on the old behaviour, with a plain verdict. Mirrors the
 *  main-process `ArmComparison`. */
export interface ArmComparisonView {
  minRequests: number
  late: ArmSummaryView
  holdout: ArmSummaryView
  legacy: ArmSummaryView
  verdict: 'not-enough-data' | 'late-cheaper' | 'late-costlier' | 'no-clear-difference'
  costDeltaPct: number | null
  /** Half the width of the 99% interval round the cost gap, in points. */
  costMarginPct: number | null
  /** How many times as much data as so far would settle a gap the data cannot yet; null when clear, absent or too large to quote. */
  moreDataFactor: number | null
  turnVerdict: 'fewer' | 'more' | 'no-clear-difference' | null
  shareDeltaPts: number | null
  shareMarginPts: number | null
}

/** First-sight compaction as a whole, for the compactions of one policy. */
export interface FirstSightSummaryView {
  verdict: 'pays' | 'costs' | 'unknown'
  basis: 'recent' | 'all-time' | null
  elided: number
  ratePct: number | null
  breakEvenPct: number | null
  netUnits: number
}

/** The Elision health card's data: redemption by class, the break-even verdict and the retrieval
 *  turns. Mirrors the main-process `ElisionHealthView`. */
export interface ElisionHealthView {
  windowSize: number
  classes: ElisionClassView[]
  elided: number
  redeemed: number
  legacyRedeemed: number
  recentElided: number
  recentRedeemed: number
  /** First-sight compaction under the policy in force. */
  firstSight: FirstSightSummaryView & { policy: 'late' | 'legacy' }
  /** The same for the old behaviour (the holdout) when the policy in force is Late; null under Legacy. */
  oldBehaviour: FirstSightSummaryView | null
  regime: 'rising' | 'falling' | 'steady' | 'unknown'
  turns: {
    /** Asks for elided text back (a ToolSearch turn and the retrieve_full turn after it are one ask). */
    count: number
    units: number
    unitsPerTurn: number
    costBasis: 'measured' | 'assumed'
    /** Of the asks, how many took two turns because retrieve_full had to be loaded first. */
    hops: number
    observed: number
    /** Responses to requests on which the model could ask (retrieve_full listed, or loadable) and could not. */
    askable: number
    unaskable: number
    shareBasis: 'could-ask' | 'responses'
    sharePct: number | null
  }
  arms: ArmComparisonView
  /** Aged-out stubs found in conversations too short for the decay pass to have made them. */
  agedEarly: { requests: number; stubs: number }
}

export interface TermpolisAPI {
  /** `accountId`: the account a launch runs on (Settings ▸ Accounts), for the proxy's step-aside. */
  /** `limitWatch`: the terminal is created to launch an agent Termpolis watches for usage limits (the
   *  agent, or true for one not known yet): main marks it so for its whole life (§8.6, R6). */
  /** `codexRoute` (v1.58.0): a Codex launch whose effort may be routed per message; the reply's
   *  `codexBaseUrl`, when main allows it, goes on the command as `-c openai_base_url=…`. */
  createTerminal: (id: string, shellType: ShellType, cwd: string, extraPaths?: string[], claudeHeadroom?: boolean, accountId?: string, limitWatch?: AccountAgent | true, autoModel?: boolean, codexRoute?: boolean) => Promise<IpcResponse<{ codexBaseUrl?: string } | undefined>>
  killTerminal: (id: string) => Promise<IpcResponse>
  /** Whether nothing runs in the terminal but its shell, as the OS tells: true once an agent that
   *  was running there has exited, false while something still runs, null where main cannot tell
   *  (WSL, a shell it does not know, a failed query). The model switcher polls it. */
  terminalShellAlone: (id: string) => Promise<IpcResponse<boolean | null>>
  /** Both stores in one call — global workflows first, then this project's. */
  listWorkflows: (cwd: string) => Promise<IpcResponse<WorkflowListItem[]>>
  readWorkflow: (cwd: string, id: string, scope?: WorkflowScope) => Promise<IpcResponse<Workflow>>
  /** `fromScope` is the scope the workflow was loaded with; passing it lets the
   *  main process MOVE the file when the user changes scope in the designer. */
  saveWorkflow: (cwd: string, workflow: Workflow, fromScope?: WorkflowScope) => Promise<IpcResponse<void>>
  deleteWorkflow: (cwd: string, id: string, scope?: WorkflowScope) => Promise<IpcResponse<void>>
  runWorkflow: (cwd: string, id: string, scope?: WorkflowScope, inputs?: Record<string, string>) => Promise<IpcResponse<{ runId: string }>>
  cancelWorkflow: (runId: string) => Promise<IpcResponse<void>>
  /** Tell main which project the sidebar is showing so its automatic triggers arm. */
  watchWorkflowProject: (cwd: string) => Promise<IpcResponse<void>>
  onWorkflowRunEvent: (cb: (event: WorkflowRunEvent) => void) => () => void
  /** `t` is the echo trace's wall-clock stamp for a sampled key; omitted for every other write.
   *  `key`: the model picker's hold on the terminal (§7.5), which lets its own writes through
   *  while main holds the terminal for it. */
  writeToTerminal: (id: string, data: string, t?: number, key?: string) => void
  resizeTerminal: (id: string, cols: number, rows: number) => void
  /** `end` is where the chunk ends in the terminal's output stream — absent for output main
   *  never buffered (a Strict-Mode banner). Comparable with readTerminalBuffer's `nextOffset`. */
  onTerminalData: (cb: (id: string, data: string, end?: number) => void) => () => void
  /** One terminal's output only, as `onTerminalData` (the callback keeps its three arguments). Every pane shares ONE
   *  listener, and main sends terminal:data for an id only while something listens for it (see terminalDataRouting.ts). */
  onTerminalDataFor: (id: string, cb: (id: string, data: string, end?: number) => void) => () => void
  /** A Claude session's first prompt, or (afterCompact) its last prompt right after a compaction. */
  onAgentFirstPrompt?: (cb: (p: { terminalId: string; prompt: string; afterCompact?: boolean }) => void) => () => void
  /** v1.59.0: the terminal's conversation is deep enough that a fresh session costs savingPct less per turn. */
  onAgentDepthOffer?: (cb: (p: { terminalId: string; messages: number; savingPct: number }) => void) => () => void
  /** v1.56.0 per-message routing (lib/messageRoute.ts). */
  onRouterMessage?: (cb: (e: import('../../../shared/smartRoute').RouteEvent) => void) => () => void
  routerConfigure?: (opts: { mode?: string; tuning?: unknown }) => Promise<IpcResponse<string>>
  routerPin?: (opts: { terminalId: string; pinned?: boolean }) => Promise<IpcResponse>
  routerLearn?: (opts: { prompt: string; label: string }) => Promise<IpcResponse<boolean>>
  /** Counters of that routing, numbers and one boolean only: for an e2e spec to read what the real bridge did. */
  terminalDataStats: () => { shared: boolean; ids: number; panes: number; all: number; delivered: number; dropped: number }
  getAvailableShells: () => Promise<IpcResponse<ShellInfo[]>>
  readConfigFile: (filePath: string) => Promise<IpcResponse<string>>
  writeConfigFile: (filePath: string, content: string) => Promise<IpcResponse>
  appendHistory: (terminalId: string, terminalName: string, command: string) => void
  searchHistory: (query: string) => Promise<IpcResponse<HistoryEntry[]>>
  getHomedir: () => Promise<IpcResponse<string>>
  getMcpConfigPath: () => Promise<IpcResponse<string>>
  loadSession: () => Promise<IpcResponse<SessionData>>
  saveSession: (data: SessionData) => void
  completionPathEntries: (dirPath: string) => Promise<IpcResponse<{ name: string; isDir: boolean }[]>>
  completionPathCommands: () => Promise<IpcResponse<string[]>>
  completionEnvVars: () => Promise<IpcResponse<Record<string, string>>>
  exportTerminal: (opts: { content: string; defaultFilename: string }) => Promise<IpcResponse<{ filePath: string }>>
  detectAgents: () => Promise<IpcResponse<Record<string, boolean>>>
  secondOpinion: (opts: { agent: string; model?: string; content: string }) => Promise<IpcResponse<{ feedback: string }>>
  /** Current per-provider model catalog. Resolves immediately — the main process seeds a
   *  builtin (Claude-only) catalog at startup, so this never blocks on discovery. */
  getModelCatalog: () => Promise<IpcResponse<ModelCatalog>>
  /** Force a re-discovery now, bypassing the cache TTL. */
  refreshModelCatalog: () => Promise<IpcResponse<ModelCatalog>>
  /** Fires when the launch-time (or forced) refresh lands. Returns an unsubscribe fn. */
  onModelCatalogUpdated: (cb: (catalog: ModelCatalog) => void) => () => void
  pickDirectory: (defaultPath?: string) => Promise<IpcResponse<string | null>>
  openPath: (path: string) => Promise<IpcResponse>
  openExternal: (url: string) => Promise<IpcResponse>
  collectDiagnostics: () => Promise<IpcResponse<{
    appVersion: string
    platform: string
    osRelease: string
    arch: string
    electronVersion: string
    nodeVersion: string
    chromeVersion: string
    /** The main-process typing trace (numbers only). Absent from older builds. */
    typing?: unknown
  }>>
  getTerminalStatus: (terminalId: string, fallbackCwd: string) => Promise<IpcResponse<{ cwd: string; gitBranch: string }>>
  getGitInfo: (cwd: string) => Promise<IpcResponse<{ status: string; recentCommits: string }>>
  getGitDiff: (cwd: string) => Promise<IpcResponse<string>>
  /** Reads forward from an absolute offset in the terminal's output stream. Pass
   *  `nextOffset` back on the following call; `missed` is how many chars were evicted
   *  before this read reached them. */
  readTerminalBuffer: (
    terminalId: string,
    fromOffset?: number,
  ) => Promise<
    IpcResponse<{
      output: string
      length: number
      nextOffset: number
      missed: number
      /** Only on a read from the window's start (a replay). Escape sequences that put a fresh
       *  xterm into the mode state the evicted output left — write them before `output`. */
      preamble?: string
      /** Only on a replay: chars at the start of `output` that finish a sequence the eviction
       *  cut in half (the preamble already holds its effect). Replay `output.slice(skip)`. */
      skip?: number
      /** The geometry the pty is drawing for, when it has one: on a replay, what `output` was
       *  drawn for. A poller reading on from its own offset gets it too, to see a resize by. */
      cols?: number
      rows?: number
      /** The screen main keeps for a terminal an agent runs in, as all its output has drawn it: the
       *  window above holds only the last 32 KB, and an agent that paints its input box once has none
       *  in it after a minute of work. Absent for any other terminal. */
      screen?: { lines: string[]; title: string }
    }>
  >
  /** Drops the main-process copy of a terminal's output so a cleared terminal stays
   *  cleared across remounts. The renderer wipes its own xterm separately. `preamble` is
   *  the terminal-mode state the cleared output left (computed in the same step as the
   *  clear): write it after resetting xterm, so the running app keeps its modes. */
  clearTerminalBuffer: (terminalId: string) => Promise<IpcResponse<{ preamble: string }>>

  // App log -- what Termpolis itself printed, kept so users can see behind the scenes
  readAppLog: (limit?: number) => Promise<IpcResponse<{ entries: AppLogEntry[]; path: string | null }>>
  clearAppLog: () => Promise<IpcResponse>
  appLogPath: () => Promise<IpcResponse<string | null>>
  /** Fire-and-forget: pushes one renderer-side line into the same log as main's. */
  writeAppLog: (level: AppLogLevel, message: string) => void

  // Git operations
  gitFindRoot: (cwd: string) => Promise<IpcResponse<string | null>>
  gitStatusParsed: (cwd: string) => Promise<IpcResponse<{ branch: string; staged: { file: string; status: string }[]; unstaged: { file: string; status: string }[] }>>
  gitStage: (cwd: string, files: string[]) => Promise<IpcResponse>
  gitUnstage: (cwd: string, files: string[]) => Promise<IpcResponse>
  gitCommit: (cwd: string, message: string) => Promise<IpcResponse>
  gitPull: (cwd: string) => Promise<IpcResponse<string>>
  gitPush: (cwd: string) => Promise<IpcResponse<string>>
  gitFileDiff: (cwd: string, file: string) => Promise<IpcResponse<string>>

  // Changes rail — separate from gitStatusParsed above, which cannot represent a
  // rename's old path or a filename with a trailing space (it splits on newlines
  // and trims). These read the -z forms instead. See src/main/gitChanges.ts.
  gitChanges: (cwd: string) => Promise<IpcResponse<GitChangesResult>>
  gitChangeCounts: (cwd: string) => Promise<IpcResponse<GitChangeCounts | null>>
  /** Ask main to watch this directory's repo. Resolves to the repo ROOT it is watching, or null
   *  when `cwd` is not in a repo. Ref-counted in main — every watch needs its unwatch. */
  gitWatch: (cwd: string) => Promise<IpcResponse<string | null>>
  gitUnwatch: (cwd: string) => Promise<IpcResponse<string | null>>
  /** Fires when anything under a watched repo changes on disk. `root` is the repo root, which is at
   *  or above the cwd that asked for the watch. Returns an unsubscribe. */
  onGitTreeChanged: (cb: (data: { root: string }) => void) => () => void
  gitChangeDiff: (cwd: string, file: string, mode: GitChangeMode) => Promise<IpcResponse<string>>
  /** Commits `@{upstream}..HEAD` — the unpushed work the dot counts as outstanding. */
  gitUnpushed: (cwd: string) => Promise<IpcResponse<GitUnpushedCommit[]>>
  gitCommitDiff: (cwd: string, sha: string) => Promise<IpcResponse<string>>
  /**
   * Per-hunk test coverage for the diff view, read from whatever format the project's own
   * test run produced (lcov, Cobertura, JaCoCo, Clover, Go coverprofile). Null when the
   * repo has no coverage artifact at all — the common case, and not an error.
   */
  coverageForFile: (cwd: string, file: string) => Promise<IpcResponse<{ source: string; format: string; lines: Record<number, number>; stale: boolean } | null>>

  // Swarm Review
  gitRevParseHead: (cwd: string) => Promise<IpcResponse<string | null>>
  gitDiffRange: (cwd: string, from: string, to?: string) => Promise<IpcResponse<string>>
  gitFilesInRange: (cwd: string, from: string, to?: string) => Promise<IpcResponse<{ file: string; status: string }[]>>
  gitApplyPatch: (cwd: string, patch: string, reverse?: boolean) => Promise<IpcResponse>
  gitCheckoutFile: (cwd: string, sha: string, files: string[]) => Promise<IpcResponse>
  gitResetHard: (cwd: string, sha: string) => Promise<IpcResponse>
  gitCommitAll: (cwd: string, message: string) => Promise<IpcResponse>
  swarmRunCommand: (cwd: string, command: string) => Promise<IpcResponse<{ output: string; exitCode: number }>>

  // Workspace trust
  workspaceIsTrusted: (cwd: string) => Promise<IpcResponse<boolean>>
  workspaceTrust: (cwd: string) => Promise<IpcResponse>
  workspaceRevokeTrust: (cwd: string) => Promise<IpcResponse>
  workspaceListTrusted: () => Promise<IpcResponse<string[]>>
  /** Pre-approve a folder in Claude Code's ~/.claude.json so its trust dialog never opens. */
  /** `accountId`: trust the folder in that account's profile; refused for one not connected. */
  claudeTrustWorkspace: (cwd: string, accountId?: string) => Promise<IpcResponse<{ changed: boolean; keys: string[]; skipped?: string }>>

  // Shared swarm memory (RAG)
  memoryWrite: (input: MemoryWriteInput) => Promise<IpcResponse<MemoryEntry>>
  memorySearch: (opts: MemorySearchOptions) => Promise<IpcResponse<MemorySearchResult[]>>
  memoryList: (opts?: MemoryListOptions) => Promise<IpcResponse<MemoryEntry[]>>
  memoryCount: () => Promise<IpcResponse<number>>
  memoryClear: () => Promise<IpcResponse>
  memoryStats: () => Promise<IpcResponse<{ count: number; capacity: number }>>
  /** Memory & Learning dashboard proof numbers — computed locally/offline. */
  memoryMetrics: () => Promise<IpcResponse<MemoryMetrics>>
  /** A sampled subgraph of the live knowledge graph for the connections view. */
  memoryGraphSample: (limit?: number) => Promise<IpcResponse<GraphSample>>
  memoryIngestConversations: () => Promise<IpcResponse<{ filesScanned: number; chunksWritten: number; chunksSkipped: number }>>
  memoryIngestCode: (repoRoot: string) => Promise<IpcResponse<{ filesScanned: number; filesSkipped: number; chunksWritten: number; chunksSkipped: number }>>
  // Native code graph (structural) — powers the in-app Code Graph browser + the code_* MCP tools.
  codeGraphStats: () => Promise<IpcResponse<CodeGraphStats>>
  codeGraphSearch: (query: string, limit?: number) => Promise<IpcResponse<CodeSymbolHit[]>>
  codeGraphExplore: (query: string) => Promise<IpcResponse<CodeExploreResult | null>>
  codeGraphImpact: (name: string) => Promise<IpcResponse<CodeSymbolHit[]>>
  codeGraphCallers: (name: string) => Promise<IpcResponse<CodeSymbolHit[]>>
  codeGraphBuild: (repoRoot: string) => Promise<IpcResponse<CodeGraphStats>>
  /** Export the full brain (memories + graph + learning stores + code graph) to a chosen .zip. */
  brainExport: () => Promise<IpcResponse<{ canceled: boolean; path?: string; bytes?: number }>>
  /** Integrity-verify + MERGE a brain .zip into this machine (additive; never destructive). */
  brainImport: () => Promise<IpcResponse<{ canceled: boolean; memoriesImported?: number; edgesImported?: number; restored?: string[] }>>
  memoryBuildPrimer: (query: string, limit?: number, cwd?: string) => Promise<IpcResponse<string | null>>
  /** Claude launch primer: writes the recall instruction to a temp file (only
   *  when relevant memory exists) and returns its path for --append-system-prompt-file. */
  memoryPreparePrimerFile: (query: string, cwd?: string, accountId?: string) => Promise<IpcResponse<{ file: string | null; count: number }>>
  /** Codex parity: the memory instruction Codex gets at launch via `-c developer_instructions=…`
   *  (never written into the repo), plus pre-approval of any memory tools not yet decided. */
  memoryPrepareCodexContext: (cwd: string, accountId?: string) => Promise<IpcResponse<CodexLaunchContext>>
  /** Agent integration: what Termpolis writes into agent configs, and the consent gating it. */
  agentIntegrationStatus: () => Promise<IpcResponse<AgentIntegrationStatus>>
  agentIntegrationSet: (req: AgentIntegrationSetRequest) => Promise<IpcResponse<AgentIntegrationSetResult>>
  /**
   * Whether Termpolis may answer an agent's folder-trust prompt in this terminal's live
   * directory (`fallbackCwd` when it can't be probed): consent given, and not home, above
   * home, or a root.
   */
  agentFolderTrustAllowed: (terminalId: string, fallbackCwd: string) => Promise<IpcResponse<boolean>>
  /** `accountId`: an account's own CODEX_HOME instead of the default one. */
  agentRemoveCodexHomeTrust: (accountId?: string) => Promise<IpcResponse<{ changed: boolean; error?: string }>>
  /** Token Headroom: compression settings + measured savings receipt. */
  tokenSavingsGetSettings: () => Promise<IpcResponse<HeadroomSettingsView>>
  tokenSavingsSetSettings: (p: Partial<HeadroomSettingsView>) => Promise<IpcResponse<HeadroomSettingsView>>
  tokenSavingsGetReceipt: () => Promise<IpcResponse<{ session: { netSaved: number; events: number; byTool: Record<string, number> }; cumulative: { netSaved: number; events: number; byTool: Record<string, number> } }>>
  tokenSavingsGetProxyReceipt: () => Promise<IpcResponse<{ session: ProxyTotalsView; cumulative: ProxyTotalsView }>>
  tokenSavingsGetProxyStatus: () => Promise<IpcResponse<ProxyStatusView>>
  /** Both compression layers summed, give-backs subtracted once — the number the UI shows. */
  tokenSavingsGetUnifiedReceipt: () => Promise<IpcResponse<{ session: UnifiedTotalsView; cumulative: UnifiedTotalsView; depth?: DepthAdviceView | null }>>
  tokenSavingsGetElisionHealth: () => Promise<IpcResponse<ElisionHealthView>>
  /** Where the memory store is running. Two in-memory reads in main — no work, no disk. Read on tab
   *  open and on Refresh; the ONLY timer allowed against it is the bounded re-probe that leaves the
   *  transitional 'starting' state, which stops itself as soon as the mode settles. */
  memoryHostStatus: () => Promise<IpcResponse<{
    mode: 'host' | 'starting' | 'inproc' | 'unstarted' | 'unavailable'
    pid: number | null
    /** Only while mode is 'unavailable' (v1.54.5): the store is too big to load on the main thread, the
     *  host is down, and a retry is pending or running. All of these are optional: an older main sends none. */
    attempt?: number
    retrying?: boolean
    retryInMs?: number | null
    storeMB?: number | null
    limitMB?: number
    reason?: string
  }>>
  /** Vector count + what those vectors cost as float32 vs int8. One-shot: read on tab open and on
   *  Refresh, NEVER on a timer. Carries no process health — the instrument that did was the freeze. */
  memoryGetVectorRam: () => Promise<IpcResponse<VectorRamInfo>>
  /** Flip int8 quantization and rebuild the packed store. Lossless both ways. */
  memorySetVectorQuantize: (value: boolean) => Promise<IpcResponse<VectorRamInfo>>
  /** Primer size (memories injected per primer): the user-tunable Memory-panel control. */
  memoryGetPrimerLimit: () => Promise<IpcResponse<number>>
  memorySetPrimerLimit: (value: number) => Promise<IpcResponse<{ primerLimit: number }>>
  /** "Learn from conversations": whether conversation ingest and the indexer passes run (default true). */
  memoryGetLearnConversations: () => Promise<IpcResponse<boolean>>
  memorySetLearnConversations: (value: boolean) => Promise<IpcResponse<{ learnFromConversations: boolean }>>
  /** Claude Code's saved notes in memory: the two switches, what was imported, whether the agents are connected. */
  memoryGetNotesSettings: () => Promise<IpcResponse<ClaudeNotesSettings>>
  /** Change either switch (only a real boolean counts). Answers with the new state. */
  memorySetNotesSettings: (p: { indexClaudeNotes?: boolean; shareNotesAcrossProjects?: boolean }) => Promise<IpcResponse<ClaudeNotesSettings>>
  /** Take every imported note out of memory and turn the import off. */
  memoryRemoveImportedNotes: () => Promise<IpcResponse<{ removed: number; failed: number; unchecked?: boolean; settings: ClaudeNotesSettings }>>
  /** The record of what memory did, in the app-data folder: how many of its files exist and their size together. */
  memoryAuditSize: () => Promise<IpcResponse<{ files: number; bytes: number }>>
  /** Forget the record. `failed` counts files that exist and could not be removed. */
  memoryClearAudit: () => Promise<IpcResponse<{ removed: number; failed: number }>>
  /** Reflect a solo agent session's transcript delta into the learning brain (idle-settle / on close). */
  memoryReflectSession: (terminalId: string, cwd: string, agent: string) => Promise<IpcResponse<{ fired: boolean; lessons: number }>>
  memorySyncStatus: () => Promise<IpcResponse<MemorySyncStatus>>
  memorySetSyncDir: (dir: string | null) => Promise<IpcResponse<MemorySyncStatus>>
  memoryChooseSyncDir: () => Promise<IpcResponse<MemorySyncStatus>>
  memorySetSyncPassphrase: (passphrase: string) => Promise<IpcResponse<MemorySyncStatus>>
  memoryDisableSyncEncryption: () => Promise<IpcResponse<MemorySyncStatus>>
  // WP-F, at-rest encryption. Exposed on the bridge since v1.24 but never declared here, so the
  // preload's own object literal failed to typecheck — silently, because nothing typechecked.
  memoryEnableLocalEncryption: () => Promise<IpcResponse<MemorySyncStatus>>
  memoryDisableEncryption: () => Promise<IpcResponse<MemorySyncStatus>>
  /** Retire the memory key and start a new one: the only way past a LOCKED brain. Never automatic. */
  memoryStartNewKey: () => Promise<IpcResponse<MemorySyncStatus>>

  // Clipboard — native Electron clipboard (focus/permission-immune), used by the
  // terminal context menu where navigator.clipboard silently rejects.
  clipboardWriteText: (text: string) => Promise<IpcResponse>
  clipboardReadText: () => Promise<IpcResponse<string>>
  clipboardWriteRich: (text: string, html: string) => Promise<IpcResponse>

  // The on-disk path of a dropped File, '' when it has none (Electron's webUtils; `File.path`
  // is gone since Electron 32).
  getPathForFile: (file: File) => string

  // Voice (Groq cloud STT). The API key lives only in main (OS keychain); the
  // renderer can validate/set/clear it and read a masked status, and send PCM to
  // be transcribed — it never holds the raw key.
  groqValidateKey: (key: string) => Promise<IpcResponse<{ ok: boolean; status?: number; error?: string }>>
  groqSetApiKey: (key: string) => Promise<IpcResponse<{ connected: boolean; hint: string }>>
  groqGetKeyStatus: () => Promise<IpcResponse<{ connected: boolean; hint: string }>>
  groqClearApiKey: () => Promise<IpcResponse<{ connected: boolean; hint: string }>>
  voiceTranscribe: (pcm: Float32Array, model?: string) => Promise<IpcResponse<{ text: string }>>

  // MCP. Every `env` value that crosses this bridge is already masked in main —
  // see src/main/mcpIpc.ts. The renderer never holds an upstream credential.
  mcpInventory: () => Promise<IpcResponse<McpInventoryView>>
  mcpGatewayServers: () => Promise<IpcResponse<McpServerSpecView[]>>
  mcpGatewayAddServer: (spec: McpServerSpecView) => Promise<IpcResponse<McpServerSpecView[]>>
  mcpGatewayRemoveServer: (id: string) => Promise<IpcResponse<McpServerSpecView[]>>
  mcpGatewayPolicy: () => Promise<IpcResponse<McpGatewayPolicyView>>
  mcpGatewaySetPolicy: (policy: McpGatewayPolicyView) => Promise<IpcResponse<McpGatewayPolicyView>>
  mcpGatewayTest: (id: string) => Promise<IpcResponse<McpGatewayTestView>>

  // Settings ▸ Processes — headless agents, frozen git and orphaned leftovers.
  processesScanStuck: () => Promise<IpcResponse<StuckScanView>>
  /** `stuckOnly` ("Kill all stuck") also skips any target that is no longer stuck. */
  processesKillStuck: (targets: StuckKillTarget[], opts?: { stuckOnly?: boolean }) => Promise<IpcResponse<StuckKillResultView>>

  // Test-only seams (inert in production — main handlers registered only under
  // NODE_ENV=test). Used by e2e/compaction-reprime.spec.ts.
  __testTerminalData?: (id: string, data: string) => Promise<IpcResponse<boolean>>
  __testTerminalWrites?: () => Promise<IpcResponse<Array<{ id: string; data: string }>>>

  // Telemetry consent, owned by main. A tier left out of telemetrySetConsent keeps its value.
  telemetryGetConsent: () => Promise<IpcResponse<TelemetryConsentView>>
  telemetrySetConsent: (choice: { crash?: boolean; usage?: boolean }) => Promise<IpcResponse<TelemetryConsentView>>
  recordTelemetryEvent: (name: string, props?: Record<string, unknown>) => Promise<IpcResponse>

  /** Static platform facts read synchronously at preload load. windowsPty tells
   *  xterm.js how the Windows ConPTY wraps/scrolls so a TUI's redraws don't
   *  overlap the prompt (null off Windows). */
  platformInfo: PlatformInfo
  getAppVersion: () => Promise<IpcResponse<{ version: string }>>

  listAISessions: () => Promise<IpcResponse<AISessionSummary[]>>
  digestAISession: (filePath: string) => Promise<IpcResponse<{ digest: AISessionDigest; prompt: string }>>
  readActiveConversation: (cwd: string, agentType: string) => Promise<IpcResponse<{ role: 'user' | 'assistant'; text: string; ts: number }[]>>
}

/** Which config a server was found in. `gateway` is Termpolis's own list — the only
 *  one this app writes; the other four are read-only mirrors of the agents' configs. */
export type McpSourceId = 'claude' | 'globalMcp' | 'codex' | 'gemini' | 'gateway'

export interface McpSourceView {
  id: McpSourceId
  label: string
  path: string
  status: 'ok' | 'missing' | 'corrupt'
  error?: string
}

export interface McpServerView {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  /** Keys as written; every value already masked in main. */
  env?: Record<string, string>
  sources: Record<McpSourceId, boolean>
  /** Configured in some agents but not all. */
  drift: boolean
}

export interface McpInventoryView {
  sources: McpSourceView[]
  servers: McpServerView[]
}

export interface McpServerSpecView {
  id: string
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}

export interface McpToolRuleView {
  server: string
  tool: string
  decision: 'allow' | 'deny' | 'ask'
}

export interface McpGatewayPolicyView {
  enabled: boolean
  defaultDecision: 'allow' | 'deny' | 'ask'
  strict: boolean
  rules: McpToolRuleView[]
}

export interface McpGatewayTestView {
  ok: boolean
  tools?: number
  error?: string
}

/** One process tree the Processes tab lists (mirrors StuckProcess in src/main/stuckProcesses.ts). */
export interface StuckProcessView {
  pid: number
  /** Start time, epoch ms. Sent back with a kill so main can tell a reused pid apart. */
  created: number
  name: string
  category: 'agent' | 'git' | 'leftover'
  agent?: 'claude' | 'codex' | 'gemini'
  mcp?: boolean
  reasons: ('headless' | 'orphaned' | 'suspended' | 'long-running')[]
  owner: 'termpolis' | 'external' | 'orphaned'
  parentName?: string
  /** Frozen, or orphaned and serving no port: what "Kill all stuck" ends. */
  stuck: boolean
  serving: number[]
  ageMs: number
  cpuSec: number
  memBytes: number
  command: string
  detail?: string
  treeSize: number
}

export interface StuckScanView {
  processes: StuckProcessView[]
  scannedAt: number
  platform: string
  totalProcesses: number
  warnings: string[]
}

export interface StuckKillTarget {
  pid: number
  created: number
}

export interface StuckKillResultView {
  killed: number[]
  failed: { pid: number; error: string }[]
  skipped: { pid: number; reason: string }[]
}

export interface AISessionSummary {
  id: string
  filePath: string
  projectFolder: string
  cwd: string
  gitBranch?: string
  version?: string
  firstUserMessage?: string
  startTime?: string
  lastModified: number
  sizeBytes: number
}

export interface AISessionDigest {
  id: string
  filePath: string
  cwd: string
  gitBranch?: string
  version?: string
  firstUserMessage?: string
  recentUserMessages: string[]
  lastAssistantText?: string
  totalUserTurns: number
  totalAssistantTurns: number
}

export interface MemoryEntry {
  id: string
  ts: number
  agentId: string
  kind: 'message' | 'result' | 'decision' | 'fact' | 'note'
  content: string
  tags?: string[]
  taskId?: string
  source?: string
  hash?: string
  // Mneme learning layer (see docs/learning-architecture.md) — optional, additive.
  memoryType?: 'episodic' | 'semantic' | 'procedural' | 'entity' | 'summary'
  importance?: number
  originEpisode?: string
}

export interface MemorySearchResult extends MemoryEntry { score: number }

export interface MemorySyncStatus {
  syncing: boolean
  dir: string | null
  deviceId: string
  devices: number // shard files in the sync folder (≈ machines sharing this brain)
  count: number
  encrypted: boolean // this device holds the key and writes ciphertext at rest
  locked: boolean    // encrypted shards present that we can't read yet (passphrase needed)
  /** LOCKED: nothing new is being saved — the memory key can't be used, or doesn't match the memories
   *  on disk. Optional because builds before this one never sent it. */
  ownLocked?: boolean
  lockReason?: MemoryLockReason | null
}

/** Why memory is LOCKED (see swarmMemory.LockReason). */
export type MemoryLockReason = 'keychain-unavailable' | 'key-unreadable' | 'key-invalid' | 'key-mismatch'

export interface MemoryWriteInput {
  agentId: string
  kind?: MemoryEntry['kind']
  content: string
  tags?: string[]
  taskId?: string
  memoryType?: MemoryEntry['memoryType']
  importance?: number
  originEpisode?: string
}

export interface MemorySearchOptions {
  query: string
  limit?: number
  agentId?: string
  kind?: MemoryEntry['kind']
  taskId?: string
}

export interface MemoryListOptions {
  limit?: number
  agentId?: string
  kind?: MemoryEntry['kind']
  since?: number
}

/** Memory & Learning dashboard payload — all computed locally/offline. `ledger` is
 *  the live event roll-up (recall/write/inject/feedback/reflect/embed), `store` is
 *  the current composition, `graph` the connection counts, `competence` the
 *  self-assessed per-domain confidence. */
export interface MemoryMetrics {
  ledger: {
    generatedTs: number
    recalls: number
    recallFiredRate: number
    avgHits: number
    avgTopScore: number
    avgLatencyMs: number
    byPath: { vector: number; keyword: number; cache: number }
    // Status vs history — see embeddingTile(). embedUp answers "is semantic recall working now";
    // embedAvailability is the lifetime rate and must never be graded as if it were the status.
    embedUp: boolean | null
    embedRecentUp: number
    embedRecentTotal: number
    embedAvailability: number
    writes: number
    writeDurability: number
    injects: number
    tokensInjected: number
    reusedSolutions: number
    tokensSavedEstimate: number
    feedbackCount: number
    feedbackHelpfulRate: number
    lessonsLearned: number
    /** Lessons the distiller produced that the substance gate refused to store (1.55.0). Optional so a
     *  main process that predates the field still deserialises; absent is read as 0. */
    lessonsSkipped?: number
    crossAgentRecalls: number
    teachingMatrix: Record<string, Record<string, number>>
  }
  store: {
    total: number
    capacity: number
    byType: Record<string, number>
    bySource: Record<string, number>
    lessons: number
    timeline: Array<{ t: number; total: number; lessons: number }>
    /** F31: shard files the last reload could not read AT ALL. Non-zero means every number in
     *  `store` is a FLOOR, not the truth — memories exist on disk that never made it into RAM.
     *  Optional so a main process that predates the field (stale utility process mid-upgrade)
     *  still deserialises; absent is read as 0. */
    unreadableShards?: number
    /** LOCKED: the memory key can't open the store, so these numbers cover only what it could.
     *  Optional for the same reason as unreadableShards; absent is read as false. */
    locked?: boolean
  }
  graph: { nodes: number; edges: number; byRelation: Record<string, number> }
  competence: Array<{ domain: string; attempts: number; confidence: number }>
  recentActivity: Array<{ ts: number; op: string; type: string; detail: string }>
  /** Native structural code-graph totals across ALL indexed repos (symbols + call/reference
   *  edges). Optional: absent until a repo is indexed, so the dashboard shows nothing rather
   *  than a fake 0 — surfacing this is what makes "index a repo -> see connections" true. */
  codeGraph?: { files: number; symbols: number; edges: number }
}

/** A sampled, legible slice of the live knowledge graph for the connections view. */
export interface GraphSampleNode { id: string; label: string; type: string; degree: number }
export interface GraphSampleEdge { from: string; to: string; relation: string }
export interface GraphSample { nodes: GraphSampleNode[]; edges: GraphSampleEdge[]; totalNodes: number; totalEdges: number }

export interface SwarmMessage {
  id: string
  from: string
  to: string
  type: 'task' | 'result' | 'question' | 'info' | 'review'
  content: string
  timestamp: number
  read: boolean
}

export interface SwarmTask {
  id: string
  title: string
  description: string
  assignedTo: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  createdBy: string
  result?: string
  createdAt: number
  completedAt?: number
}

export interface SwarmAPI {
  getMessages: () => Promise<IpcResponse<SwarmMessage[]>>
  getTasks: () => Promise<IpcResponse<SwarmTask[]>>
  sendMessage: (from: string, to: string, type: string, content: string) => Promise<IpcResponse<SwarmMessage>>
  createTask: (title: string, description: string, createdBy: string, assignTo?: string) => Promise<IpcResponse<SwarmTask>>
  updateTask: (taskId: string, status: string, result?: string) => Promise<IpcResponse<SwarmTask>>
  clear: () => Promise<IpcResponse>
}

export type AgentActivityKind =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'token_update'
  | 'compaction'
  | 'error'
  | 'status_change'
  | 'mcp_audit'

export type AgentActivityType = 'claude' | 'codex' | 'gemini' | 'unknown'

export interface AgentActivityEvent {
  id: string
  ts: number
  terminalId: string
  agentType: AgentActivityType
  kind: AgentActivityKind
  taskId?: string
  summary: string
  payload: Record<string, unknown>
}

export interface AgentActivityFilter {
  terminalId?: string
  agentType?: AgentActivityType
  kind?: AgentActivityKind | AgentActivityKind[]
  since?: number
  until?: number
  limit?: number
  search?: string
}

export interface ContextPin {
  id: string
  createdAt: number
  label: string
  body: string
  source?: string
  tags?: string[]
}

export interface ContextPinsAPI {
  list: (cwd: string) => Promise<IpcResponse<ContextPin[]>>
  add: (cwd: string, input: { label: string; body: string; source?: string; tags?: string[] }) => Promise<IpcResponse<ContextPin>>
  update: (cwd: string, id: string, patch: { label?: string; body?: string; source?: string; tags?: string[] }) => Promise<IpcResponse<ContextPin>>
  remove: (cwd: string, id: string) => Promise<IpcResponse<{ removed: boolean }>>
  clear: (cwd: string) => Promise<IpcResponse>
}

export interface AgentActivityAPI {
  query: (filter?: AgentActivityFilter) => Promise<IpcResponse<AgentActivityEvent[]>>
  stats: () => Promise<IpcResponse<{ ringSize: number; dropped: number }>>
  /** `sessionId`: follow that Claude Code session's transcript (`claude --session-id`), from its
   *  first line, rather than the newest in `cwd` from now on. */
  attachWatcher: (terminalId: string, cwd: string, agentType: string, sessionId?: string) => Promise<IpcResponse<{ attached: boolean }>>
  detachWatcher: (terminalId: string) => Promise<IpcResponse>
  onEvent: (cb: (event: AgentActivityEvent) => void) => () => void
}

/**
 * What the packed vector store holds, and what it would hold in the other precision.
 *
 * Pure arithmetic on the row count — no process health of any kind. The version of this that
 * carried live RSS/heap/GC/event-loop numbers was polled every 2 s off the thread that echoes
 * keystrokes, and it was part of what made the app freeze (v1.25.16).
 */
export interface VectorRamInfo {
  vectors: number
  dim: number
  /** What the LIVE store is doing right now. */
  quantized: boolean
  /** Vector RAM in the current mode. */
  ramBytes: number
  /** What the same vectors cost as exact float32 (4 B/component) … */
  ramBytesFloat: number
  /** … and as int8 (1 B/component). */
  ramBytesInt8: number
  /** The persisted choice — what will be applied at the next launch. */
  persisted: boolean
}

/** Settings > Memory > Claude Code's saved notes (main: claudeNotesIpc.ts). */
export interface ClaudeNotesSettings {
  /** Bring the notes into memory. On by default, and only acted on while the agents are connected. */
  indexClaudeNotes: boolean
  /** Lend reference / feedback / user notes to other projects' searches. Off by default. */
  shareNotesAcrossProjects: boolean
  /** The user's agents are connected: until they are, no note is read. */
  connected: boolean
  /** Memory is locked: the import and every removal wait until it opens. */
  locked: boolean
  status: {
    notes: number
    chunks: number
    projects: number
    /** When the last pass finished, or null before the first. */
    lastAt: number | null
    /** Notes left alone because no session says which project their folder belongs to. */
    noProject: number
    /** Secrets redacted out of notes as they were stored. */
    secretsRedacted: number
    /** Removals waiting to be retried. */
    pending: number
  }
}

// ─── Workflow Orchestrator ───────────────────────────────────────────────
// Deterministic local automation: command/agent/skill/control step pipeline.
export type WorkflowStepType = 'command' | 'agent' | 'skill' | 'control'
// Trigger config is a flat string map so it round-trips through YAML unchanged.
// Per-type keys the supervisor understands:
//   schedule  → { cron: '0 2 * * *', catchUp?: '1' }   (5-field or @daily alias)
//   gitCommit → { branch?: 'main' }                    (empty = whatever HEAD points at)
//   gitPush   → { remote?: 'origin', branch?: 'main' } (empty branch = any)
//   fileWatch → { paths?: 'src/,docs/', debounceMs?: '2000' }
export type WorkflowTriggerType = 'manual' | 'schedule' | 'gitCommit' | 'gitPush' | 'fileWatch'
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
export type RunStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface WorkflowTrigger { type: WorkflowTriggerType; config?: Record<string, string> }

export interface CommandStep {
  id: string; type: 'command'; name: string; when?: string
  source: 'inline' | 'file'; command?: string; scriptPath?: string
  shell?: ShellType; cwd?: string; timeoutMs?: number; visible?: boolean; continueOnError?: boolean
}
export interface AgentStep {
  id: string; type: 'agent'; name: string; when?: string
  agent: 'claude' | 'codex' | 'gemini'; prompt: string; cwd?: string
  idleMs?: number; timeoutMs?: number; doneMarker?: string; continueOnError?: boolean
}
export interface SkillStep {
  id: string; type: 'skill'; name: string; when?: string
  tool: string; args?: Record<string, unknown>; timeoutMs?: number; continueOnError?: boolean
}
export interface ControlStep {
  id: string; type: 'control'; name: string; when?: string
  action: 'wait' | 'branch' | 'loop' | 'notify'; config: Record<string, string | number>
}
export type WorkflowStep = CommandStep | AgentStep | SkillStep | ControlStep

/** Where a workflow is stored — and therefore where it shows up.
 *  'project' lives in <cwd>/.termpolis/workflows and belongs to that repo.
 *  'global'  lives in the user-data dir and is offered in every project. */
export type WorkflowScope = 'project' | 'global'

/** A value the user supplies when the workflow runs, so one workflow can be
 *  reused with different arguments. Referenced as `${inputs.<name>}` in any
 *  step field, and in `when` / branch / loop conditions. */
export interface WorkflowInput {
  name: string
  label?: string
  description?: string
  default?: string
  required?: boolean
}

/** Sidebar row: enough to group and label without reading every file. */
export interface WorkflowListItem { id: string; name: string; category?: string; scope?: WorkflowScope }

export interface Workflow {
  id: string; name: string; description?: string; version: 1
  trigger: WorkflowTrigger; steps: WorkflowStep[]
  /** Free-text grouping label for the sidebar, e.g. 'Build' or 'Release/Nightly'. */
  category?: string
  inputs?: WorkflowInput[]
  /** Derived from the store the workflow was read out of — never persisted in
   *  the YAML, so moving a file between stores changes its scope. */
  scope?: WorkflowScope
}

export interface StepResult {
  stepId: string; status: StepStatus; exitCode?: number; output: string
  startedAt?: number; endedAt?: number; iteration?: number; error?: string
}
export interface WorkflowRun {
  runId: string; workflowId: string; status: RunStatus
  steps: StepResult[]; startedAt: number; endedAt?: number
  /** Which project this run happened in. A global workflow keeps one shared
   *  history, so each entry has to say where it ran. */
  cwd?: string
  /** The `${inputs.*}` values this run was given, so history is reproducible. */
  inputs?: Record<string, string>
}

export type WorkflowRunEvent =
  | { type: 'run:started'; runId: string; workflowId: string; at: number }
  | { type: 'step:started'; runId: string; stepId: string; at: number }
  | { type: 'step:output'; runId: string; stepId: string; chunk: string }
  | { type: 'step:status'; runId: string; stepId: string; status: StepStatus }
  | { type: 'step:finished'; runId: string; stepId: string; result: StepResult }
  | { type: 'run:finished'; runId: string; status: RunStatus; at: number }

/** One paired phone as the Settings pane sees it.
 *
 *  Deliberately missing `sessionRoomId`: it decrypts nothing, but it names this
 *  desktop's seat on the relay, and a seat is exclusive -- knowing it is enough
 *  to keep the real phone out. Main rebuilds this view rather than forwarding the
 *  stored record, so a field added there later is excluded by default. */
export interface RemoteDeviceView {
  id: string
  label: string
  publicKey: string
  capabilities: RemoteCapabilities
  pairedAt: number
  lastSeenAt: number
  /** Reachable right now. Distinct from paired, which survives a tunnel. */
  attached: boolean
}

export interface RemoteCapabilities {
  read: boolean
  createTerminal: boolean
  writeToTerminal: boolean
  closeTerminal: boolean
}

export interface RemotePairingView {
  /** The QR text, verbatim. Encode it as-is: it carries the desktop's public key
   *  and the one-time pairing secret, and re-formatting it breaks the scan. */
  qrPayload: string
  expiresAt: number
}

/** Where the keys that identify this computer to its phones and linked computers stand. One set of
 *  facts for both panes: Remote and Linked machines stand on the same identity. */
export interface KeyStorageView {
  /** 'keychain': sealed by the OS keychain. 'plaintext': there is none, so they are saved
   *  unencrypted. 'locked': a key file is there but can't be opened now -- nothing that needs it
   *  starts, and nothing is written over it. */
  keyStorage: 'keychain' | 'plaintext' | 'locked'
  /** Why, while 'locked'. */
  keyLockReason?: 'no-keychain' | 'unwrap-failed' | 'unreadable'
  /** Linked machines only, while 'locked': the identity opens, and only the file of links can't be.
   *  Start over then sets aside that file alone, and the phones keep working. */
  keyLockLinksOnly?: boolean
  /** A key file saved in the clear before a keychain was there to seal it: what "Encrypt keys now"
   *  is for. Only ever true with a keychain. */
  keysUnencrypted: boolean
  /** Electron's own name for its key store (Linux), shown as small print beside the warning. */
  keyBackend?: string
}

export interface RemoteStatusView extends KeyStorageView {
  enabled: boolean
  running: boolean
  /** Seated (`online`), dialling/redialling (`connecting`), or no room because
   *  nothing is paired and no QR is open (`idle`). Meaningful while `running`. */
  relay: 'idle' | 'connecting' | 'online'
  /** The supervisor gave up after a crash loop. The switch says on; nothing is. */
  disabled: boolean
  relayUrl: string
  /** `relayUrl` is plain ws:// to another computer, saved by an older version.
   *  Kept but never dialled, and the pane says so until it changes. */
  relayInsecure: boolean
  /** Null while the keys are locked: there is no identity to show. */
  publicKey: string | null
  pairing: RemotePairingView | null
  devices: RemoteDeviceView[]
}

/** One thing that just happened, for a toast or to close a modal. Device detail
 *  arrives through the status push instead, which is scrubbed in one place. */
export interface RemoteEvent {
  kind: string
  deviceId?: string
  label?: string
  phrase?: string
  message?: string
}

export interface RemoteAPI {
  status: () => Promise<IpcResponse<RemoteStatusView>>
  setEnabled: (enabled: boolean) => Promise<IpcResponse<RemoteStatusView>>
  setRelayUrl: (relayUrl: string) => Promise<IpcResponse<RemoteStatusView>>
  /** `capabilities` is what the device is granted the moment it pairs. Omitted
   *  means nothing is granted -- the phone then attaches and is refused, which
   *  is what it looked like before the Settings pane let the user choose. */
  beginPairing: (
    label: string,
    capabilities?: RemoteCapabilities,
  ) => Promise<IpcResponse<RemoteStatusView>>
  cancelPairing: () => Promise<IpcResponse<RemoteStatusView>>
  revokeDevice: (deviceId: string) => Promise<IpcResponse<RemoteStatusView>>
  setCapabilities: (deviceId: string, capabilities: RemoteCapabilities) => Promise<IpcResponse<RemoteStatusView>>
  verificationPhrase: (deviceId: string) => Promise<IpcResponse<{ deviceId: string; phrase: string }>>
  /** Seal the key files saved in the clear, now that a keychain can (`keysUnencrypted`). */
  encryptKeys: () => Promise<IpcResponse<RemoteStatusView>>
  /** Only while `keyStorage` is 'locked': a new identity, and no phone or linked computer. */
  startOver: () => Promise<IpcResponse<RemoteStatusView>>
  onStatus: (cb: (status: RemoteStatusView) => void) => () => void
  onEvent: (cb: (event: RemoteEvent) => void) => () => void
}

/** What a linked computer may do on THIS one. Each side stores and enforces its
 *  own copy, so the two directions of a link are granted independently.
 *  `write` implies `run`; main forces `run` on whenever `write` is set. */
export interface LinkedGrants {
  run: boolean
  write: boolean
}

/** One linked computer as Settings ▸ Linked machines sees it. Like
 *  `RemoteDeviceView`, it is rebuilt field by field in main, so no key, secret
 *  or relay room id can reach the renderer. */
export interface LinkedMachineView {
  /** 'device:<id>' (that computer entered our code) or 'link:<id>' (we entered its code). */
  ref: string
  name: string
  online: boolean
  /** The safety words have been checked on THIS side. Nothing is served before that. */
  confirmed: boolean
  /** The 8 safety words, kept only while the link is unconfirmed. */
  phrase?: string
  grants: LinkedGrants
  linkedAt: number
  lastActivityAt?: number
}

/** One delegated job, in either direction. */
export interface LinkedActivityView {
  id: string
  /** 'in': that computer asked this one; 'out': this one asked that computer. */
  direction: 'in' | 'out'
  machine: string
  agent: string
  /** The first line of the prompt. */
  summary: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  startedAt: number
  durationMs?: number
}

/** One line of the job history on this computer (`linked-jobs.jsonl` in userData): a job another
 *  computer started here, the same job ending, or one it was refused. Main rebuilds each line field
 *  by field as it reads it back. */
export interface LinkedJobRecord {
  ts: number
  event: 'started' | 'finished' | 'refused'
  /** The job, on `started` and `finished`. */
  jobId?: string
  /** The linked computer's ref, or '' when a refused request couldn't say which it was. */
  ref: string
  /** That computer's name on this one, at the time: 'unknown computer' when it had none. */
  machine: string
  agent?: 'claude' | 'codex' | 'gemini'
  /** Edit was asked for: granted on `started`, the reason for some refusals. */
  write?: boolean
  /** The folder it ran in, on `started`. */
  cwd?: string
  /** The first line of the screened prompt, at most 80 characters, on `started`. */
  summary?: string
  /** How it ended, on `finished`. */
  status?: 'done' | 'failed' | 'cancelled'
  durationMs?: number
  /** Why it was refused, at most 200 characters. */
  reason?: string
  /** On a refusal written as a minute of them ends: how many more there were. */
  count?: number
  /** The credential rules screening matched: the prompt's on `started`, the answer's on `finished`. */
  secretRules?: string[]
}

/** `keyStorage` is 'locked' when the identity is, or when the file holding the links this computer
 *  joined can't be opened -- then nothing about them can change until it opens or the user starts
 *  over. */
export interface LinkedStatusView extends KeyStorageView {
  enabled: boolean
  running: boolean
  /** This machine's rooms on its relay, as the bridge reports them (see
   *  RemoteStatusView.relay). A link this machine joined is not counted. */
  relay: 'idle' | 'connecting' | 'online'
  /** The Remote relay. Shown read-only here; it is set under Settings ▸ Remote. */
  relayUrl: string
  /** That relay is plain ws:// to another computer (see RemoteStatusView). No
   *  room of this machine's is dialled on it, so computers that entered a code
   *  from this one stay offline and no code can be made. */
  relayInsecure: boolean
  /** This computer's own name, which the other side is offered as a suggestion. */
  thisMachine: string
  /** The live link code, while one is being offered. */
  code: { code: string; expiresAt: number } | null
  /** A code from another computer is being redeemed right now. */
  joining: boolean
  machines: LinkedMachineView[]
  activity: LinkedActivityView[]
  /** A notification for each job another computer starts here. On unless switched off. */
  notifyJobs: boolean
  /** Bumped with every line written to the job history, so the pane reads it again only then. */
  jobLogVersion: number
}

export type LinkedEvent =
  | { kind: 'pending'; ref: string; phrase: string; suggestedName: string }
  | { kind: 'error'; message: string }
  | { kind: 'linked'; ref: string; name: string }

/** `window.linked`. Every mutating call answers with the whole status view, so
 *  the pane adopts it rather than patching its own copy. */
export interface LinkedAPI {
  status(): Promise<IpcResponse<LinkedStatusView>>
  setEnabled(enabled: boolean): Promise<IpcResponse<LinkedStatusView>>
  createCode(grants: LinkedGrants): Promise<IpcResponse<LinkedStatusView>>
  cancelCode(): Promise<IpcResponse<LinkedStatusView>>
  join(code: string, grants: LinkedGrants): Promise<IpcResponse<LinkedStatusView>>
  cancelJoin(): Promise<IpcResponse<LinkedStatusView>>
  confirm(ref: string, name: string): Promise<IpcResponse<LinkedStatusView>>
  rename(ref: string, name: string): Promise<IpcResponse<LinkedStatusView>>
  /** `confirmWrite` only from the pane's confirm panel: main refuses to turn edit on without it,
   *  or for a computer whose words are not confirmed yet. */
  setGrants(ref: string, grants: LinkedGrants, confirmWrite?: boolean): Promise<IpcResponse<LinkedStatusView>>
  unlink(ref: string): Promise<IpcResponse<LinkedStatusView>>
  /** The Remote pane's two key actions, on the same keys (see RemoteAPI). */
  encryptKeys(): Promise<IpcResponse<LinkedStatusView>>
  startOver(): Promise<IpcResponse<LinkedStatusView>>
  /** Notifications for jobs another computer starts here: anything but `false` leaves them on. */
  setNotify(enabled: boolean): Promise<IpcResponse<LinkedStatusView>>
  /** Stop a job another computer is running here. */
  stopJob(id: string): Promise<IpcResponse<LinkedStatusView>>
  /** The job history on this computer, newest first. */
  jobLog(limit?: number): Promise<IpcResponse<LinkedJobRecord[]>>
  onStatus(cb: (s: LinkedStatusView) => void): () => void
  onEvent(cb: (e: LinkedEvent) => void): () => void
  /** A job notification was clicked: open Settings ▸ Linked machines. */
  onShow(cb: () => void): () => void
}

/** `window.accounts`: Settings ▸ Accounts, more than one sign-in per agent. Main owns the
 *  registry; the renderer never passes a path (a folder is picked with main's own dialog) and is
 *  shown labels, emails, folders and states, never a config file. */
export interface AccountsAPI {
  list(): Promise<IpcResponse<AccountsView>>
  /** Main's own folder dialog, on hidden folders; main remembers the folder for the next add. */
  pickFolder(agent: ProfileAgent): Promise<IpcResponse<PickFolderResult>>
  add(req: AddAccountRequest): Promise<IpcResponse<AddAccountResult>>
  update(id: string, patch: AccountPatch): Promise<IpcResponse<AccountRowView | undefined>>
  move(id: string, by: -1 | 1): Promise<IpcResponse<AccountsView>>
  /** Forget the account and take Termpolis's entries out of its profile; the folder stays. */
  remove(id: string): Promise<IpcResponse<AccountChangesResult>>
  setConnect(id: string, connect: boolean): Promise<IpcResponse<AccountChangesResult>>
  /** Take out the Termpolis entries a copied settings.json carries. */
  stripCopied(id: string): Promise<IpcResponse<AccountChangesResult>>
  /** Fresh stripped copies of the main profile's settings over the profile's own. */
  recopy(id: string): Promise<IpcResponse<RecopyView>>
  setPreferred(agent: AccountAgent, id: string | null): Promise<IpcResponse<AccountsView>>
  setChooser(on: boolean): Promise<IpcResponse<AccountsView>>
  hideAdvice(which: 'hookAdvice' | 'authEnvAdvice' | 'limitBanner'): Promise<IpcResponse<AccountsView>>
  importPreview(): Promise<IpcResponse<ImportPreview>>
  /** `keys`: the accounts.sh keys to import, null for all; `connect`: per key, Connect ticked. */
  import(keys: string[] | null, connect: Record<string, boolean>): Promise<IpcResponse<ImportResult>>
  /** "Signed in now": the agent's own status command, on demand. */
  check(id: string): Promise<IpcResponse<AccountRowView | undefined>>
  noteLimit(id: string, limit: NoteLimitRequest): Promise<IpcResponse<AccountRowView | undefined>>
  /** "Mark available": forget the account's recorded limit. */
  clearLimit(id: string): Promise<IpcResponse<AccountRowView | undefined>>
  /** The account a launch of `agent` goes on: `accountId` while it is registered, else the
   *  agent's preferred one; null for an agent with no accounts. */
  launchAccount(agent: AccountAgent, accountId?: string | null): Promise<IpcResponse<{ accountId: string | null }>>
  /** The line a launch types: main builds it (the renderer never builds a path or an env value)
   *  and remembers it, so the terminal's account is main's own record. */
  launchLine(req: LaunchLineRequest): Promise<IpcResponse<LaunchLineResult>>
  /** A terminal's account as main now knows it: after a switch, or changed by hand. */
  onTerminalAccount(cb: (e: TerminalAccountEvent) => void): () => void
  /** Move the terminal's running agent to another account, in place: main exits it, types the
   *  account line, resumes the conversation, and says how it went. */
  switchAccount(req: SwitchRequest): Promise<IpcResponse<SwitchOutcome>>
  /** The step a switch is at. */
  onSwitchProgress(cb: (p: SwitchProgress) => void): () => void
  /** One step of agy's guided switch: one Google sign-in for the computer user, so a sign-out,
   *  the user's own sign-in, and the conversation resumed by its id. */
  agySwitch(req: AgyStepRequest): Promise<IpcResponse<AgyStepOutcome>>
  /** The model picker's half of the terminal's relaunch lock in main (§7.5): the key its writes
   *  carry while it relaunches the agent. Refused while anything holds the terminal. */
  modelHold(req: ModelHoldRequest): Promise<IpcResponse<ModelHold>>
  /** Lets the model picker's hold go. */
  modelRelease(terminalId: string, key: string): Promise<IpcResponse<boolean>>
  /** The usage-limit chooser's look at an agent terminal whose screen changed (§8.1): judged in
   *  main, beside its buffer, with main's record of the agent started there (R5). */
  limitLook(terminalId: string): Promise<IpcResponse<LimitLook>>
  /** Starts the CLI's own sign-in in main's hidden session: never a terminal. Its steps follow
   *  onSignInState. */
  signInStart(req: SignInStartRequest): Promise<IpcResponse<{ sessionId: string }>>
  /** The user's own input to a sign-in: a pick, a code, Open again, the fallback's keys, cancel. */
  signInInput(sessionId: string, input: SignInInput): Promise<IpcResponse<{ ok: true } | { ok: false; why: string }>>
  onSignInState(cb: (s: SignInState) => void): () => void
}

/** Which of the three diffs a Changes-rail row refers to. */
export type GitChangeMode = 'staged' | 'unstaged' | 'untracked'

export interface GitChangeEntry {
  file: string
  /** Pre-rename path, present only on an R/C entry. */
  oldFile?: string
  /** Porcelain shorthand: M, A, D, R, C, T, U (unmerged) or ?? (untracked). */
  status: string
  added: number
  removed: number
  binary: boolean
}

export interface GitChangesResult {
  branch: string
  /** Commits HEAD has that the upstream does not — i.e. "needs pushing". */
  ahead: number
  behind: number
  staged: GitChangeEntry[]
  unstaged: GitChangeEntry[]
  untracked: GitChangeEntry[]
}

/**
 * One commit HEAD has that the upstream does not — a row in the rail's Unpushed section.
 * These exist because the dot counts `ahead` as outstanding work, so the rail has to be
 * able to show what that work actually is.
 */
export interface GitUnpushedCommit {
  sha: string
  shortSha: string
  subject: string
  /** git's own `%ar`, e.g. "2 hours ago". */
  relativeDate: string
}

/** The per-terminal dot's payload: counts only, from one status spawn. */
export interface GitChangeCounts {
  branch: string
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
}

declare global {
  interface Window {
    termpolis: TermpolisAPI
    swarmAPI: SwarmAPI
    agentActivity: AgentActivityAPI
    contextPins: ContextPinsAPI
    windowControls: {
      minimize: () => void
      maximize: () => void
      close: () => void
    }
    globalEvents: {
      onNewTerminal: (cb: () => void) => () => void
      onToggleSwarm: (cb: () => void) => () => void
      onConfirmClose: (cb: () => void) => () => void
    }
    mcpEvents: {
      /** `remote`: a paired phone opened it, so it is the user's own terminal, not a swarm
       *  worker. `agentCommand`: the agent the phone launched in it. */
      onTerminalCreated: (cb: (data: { id: string; name: string; shell: string; cwd: string; remote?: boolean; agentCommand?: string }) => void) => () => void
      onTerminalClosed: (cb: (terminalId: string) => void) => () => void
    }
    remote: RemoteAPI
    /** Optional: only a preload that ships Linked machines defines it, so every
     *  reader has to cope with it being absent. */
    linked?: LinkedAPI
    /** Optional for the same reason: Settings ▸ Accounts (v1.54.0). */
    accounts?: AccountsAPI
  }
}
