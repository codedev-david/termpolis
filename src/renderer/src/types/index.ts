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
  isSwarm?: boolean
  hidden?: boolean
  isConductor?: boolean
  /** Set when the terminal was seeded with project memory at launch (e.g. Claude
   *  via --append-system-prompt-file), so useAutoPrimer skips the typed pointer. */
  launchPrimed?: boolean
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

export interface PlatformInfo {
  /** process.platform of the host (e.g. 'win32', 'darwin', 'linux'). */
  platform: string
  /** xterm.js `windowsPty` option on Windows (backend + OS build) so the
   *  emulator's reflow/scrollback match ConPTY; null off Windows. */
  windowsPty: { backend: 'conpty' | 'winpty'; buildNumber: number } | null
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

export interface HeadroomSettingsView {
  enabled: boolean
  mode: 'conservative' | 'balanced' | 'aggressive' | 'max'
  steering: boolean
  /** Ceiling on extended-thinking budget, in tokens. 0 = off (default). */
  thinkingCap: number
  /** Let launch-time steering strength follow measured output volume. */
  adaptiveSteering: boolean
  /** Let the launch-time wire tier escalate when the measured 50% savings floor isn't holding. */
  floorControl: boolean
  /** Age the oldest half of a long conversation down to retrievable stubs. Off by default. */
  prefixDecay: boolean
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
  /** Per-request floor evidence: the worst single request, and how many missed the 50% floor. */
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
  avoided: number
  totalBillSavedPct: number
}

export interface TermpolisAPI {
  createTerminal: (id: string, shellType: ShellType, cwd: string, extraPaths?: string[], claudeHeadroom?: boolean) => Promise<IpcResponse>
  killTerminal: (id: string) => Promise<IpcResponse>
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
  writeToTerminal: (id: string, data: string) => void
  resizeTerminal: (id: string, cols: number, rows: number) => void
  onTerminalData: (cb: (id: string, data: string) => void) => () => void
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
    IpcResponse<{ output: string; length: number; nextOffset: number; missed: number }>
  >

  // Git operations
  gitFindRoot: (cwd: string) => Promise<IpcResponse<string | null>>
  gitStatusParsed: (cwd: string) => Promise<IpcResponse<{ branch: string; staged: { file: string; status: string }[]; unstaged: { file: string; status: string }[] }>>
  gitStage: (cwd: string, files: string[]) => Promise<IpcResponse>
  gitUnstage: (cwd: string, files: string[]) => Promise<IpcResponse>
  gitCommit: (cwd: string, message: string) => Promise<IpcResponse>
  gitPull: (cwd: string) => Promise<IpcResponse<string>>
  gitPush: (cwd: string) => Promise<IpcResponse<string>>
  gitFileDiff: (cwd: string, file: string) => Promise<IpcResponse<string>>

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
  memoryPreparePrimerFile: (query: string, cwd?: string) => Promise<IpcResponse<{ file: string | null; count: number }>>
  /** Codex parity: Codex takes no system-prompt flag, so the same instruction lands in the file
   *  it reads natively (`<cwd>/AGENTS.md`), and the memory tools are cleared of approval prompts. */
  memoryPrepareCodexContext: (cwd: string) => Promise<IpcResponse<{ file: string; changed: boolean; approvals: number }>>
  /** Token Headroom: compression settings + measured savings receipt. */
  tokenSavingsGetSettings: () => Promise<IpcResponse<HeadroomSettingsView>>
  tokenSavingsSetSettings: (p: Partial<HeadroomSettingsView>) => Promise<IpcResponse<HeadroomSettingsView>>
  tokenSavingsGetReceipt: () => Promise<IpcResponse<{ session: { netSaved: number; events: number; byTool: Record<string, number> }; cumulative: { netSaved: number; events: number; byTool: Record<string, number> } }>>
  tokenSavingsGetProxyReceipt: () => Promise<IpcResponse<{ session: ProxyTotalsView; cumulative: ProxyTotalsView }>>
  /** Both compression layers summed, give-backs subtracted once — the number the UI shows. */
  tokenSavingsGetUnifiedReceipt: () => Promise<IpcResponse<{ session: UnifiedTotalsView; cumulative: UnifiedTotalsView; depth?: DepthAdviceView | null }>>
  /** Where the memory store is running. Two in-memory reads in main — no work, no disk. Read on tab
   *  open and on Refresh; the ONLY timer allowed against it is the bounded re-probe that leaves the
   *  transitional 'starting' state, which stops itself as soon as the mode settles. */
  memoryHostStatus: () => Promise<IpcResponse<{ mode: 'host' | 'starting' | 'inproc' | 'unstarted'; pid: number | null }>>
  /** Vector count + what those vectors cost as float32 vs int8. One-shot: read on tab open and on
   *  Refresh, NEVER on a timer. Carries no process health — the instrument that did was the freeze. */
  memoryGetVectorRam: () => Promise<IpcResponse<VectorRamInfo>>
  /** Flip int8 quantization and rebuild the packed store. Lossless both ways. */
  memorySetVectorQuantize: (value: boolean) => Promise<IpcResponse<VectorRamInfo>>
  /** Primer size (memories injected per primer): the user-tunable Memory-panel control. */
  memoryGetPrimerLimit: () => Promise<IpcResponse<number>>
  memorySetPrimerLimit: (value: number) => Promise<IpcResponse<{ primerLimit: number }>>
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

  // Clipboard — native Electron clipboard (focus/permission-immune), used by the
  // terminal context menu where navigator.clipboard silently rejects.
  clipboardWriteText: (text: string) => Promise<IpcResponse>
  clipboardReadText: () => Promise<IpcResponse<string>>
  clipboardWriteRich: (text: string, html: string) => Promise<IpcResponse>

  // Voice (Groq cloud STT). The API key lives only in main (OS keychain); the
  // renderer can validate/set/clear it and read a masked status, and send PCM to
  // be transcribed — it never holds the raw key.
  groqValidateKey: (key: string) => Promise<IpcResponse<{ ok: boolean; status?: number; error?: string }>>
  groqSetApiKey: (key: string) => Promise<IpcResponse<{ connected: boolean; hint: string }>>
  groqGetKeyStatus: () => Promise<IpcResponse<{ connected: boolean; hint: string }>>
  groqClearApiKey: () => Promise<IpcResponse<{ connected: boolean; hint: string }>>
  voiceTranscribe: (pcm: Float32Array, model?: string) => Promise<IpcResponse<{ text: string }>>

  // Test-only seams (inert in production — main handlers registered only under
  // NODE_ENV=test). Used by e2e/compaction-reprime.spec.ts.
  __testTerminalData?: (id: string, data: string) => Promise<IpcResponse<boolean>>
  __testTerminalWrites?: () => Promise<IpcResponse<Array<{ id: string; data: string }>>>

  // Telemetry — opt-in mirror to main process
  setTelemetryOptIn: (value: boolean) => Promise<IpcResponse<{ optIn: boolean }>>
  getTelemetryOptIn: () => Promise<IpcResponse<boolean>>
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
}

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
  attachWatcher: (terminalId: string, cwd: string, agentType: string) => Promise<IpcResponse<{ attached: boolean }>>
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
      onTerminalCreated: (cb: (data: { id: string; name: string; shell: string; cwd: string }) => void) => () => void
      onTerminalClosed: (cb: (terminalId: string) => void) => () => void
    }
  }
}
