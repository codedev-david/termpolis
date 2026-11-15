// MEMORY A/B BENCHMARK — does Termpolis shared memory make a coding agent finish real tasks better?
//
// Same model, same tasks, same fresh repo copy; the ONLY difference between the arms is memory:
//   ON  — the real Termpolis MCP server (src/main/mcpServer.ts) on a private port, backed by a fresh
//         store seeded from tests/fixtures/memory-ab/memories.json with the real bge embedder, given
//         to Claude Code over http with a bearer header; plus the launch instruction Termpolis appends
//         to the system prompt (buildInjectedInstruction) and the SessionStart / first-prompt primer
//         its hook injects (tests/fixtures/memory-ab/primer-hook.cjs mirrors that hook).
//   OFF — no MCP servers at all (--strict-mcp-config and no --mcp-config), no instruction, no hook.
// Both arms are cut off from the user's own hooks, CLAUDE.md files, auto-memory, MCP servers, slash
// commands and skills (see ISOLATION below), so the user's real Termpolis memory never leaks in.
//
// Each run: `claude -p --output-format json` in a fresh temp copy of tests/fixtures/memory-ab/repo,
// then a deterministic node check (tests/fixtures/memory-ab/checks/*.cjs). Writeup: docs/MEMORY_AB.md.
//
// It spends real model quota, so it is SKIPPED unless TERMPOLIS_AB=1 and `claude` is on PATH:
//   TERMPOLIS_AB=1 npm run bench:ab
// Knobs: TERMPOLIS_AB_MODEL (sonnet), TERMPOLIS_AB_REPS (2), TERMPOLIS_AB_TASKS (comma list of task
// ids or prefixes, e.g. t1,t3), TERMPOLIS_AB_EFFORT (passed as --effort), TERMPOLIS_AB_OUT (raw JSON
// path), TERMPOLIS_AB_KEEP=1 (keep run dirs), TERMPOLIS_AB_DRY=1 (seed + print the primers, no claude),
// TERMPOLIS_AB_PROBE=1 (one cheap canary run per arm that prints what the session was given).
import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as http from 'http'
import { spawn, spawnSync } from 'child_process'
import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  memoryList,
  memoryRelated,
  memoryGraphQuery,
  memoryLink,
  memoryFeedback,
  memorySupersedePass,
  normalizeProjectSlug,
  _resetForTests,
  _setEmbeddingsAvailable,
  type MemoryEntry,
} from '../../src/main/swarmMemory'
import { buildContextPrimer } from '../../src/main/contextPrimer'
import { createPrimerRecent } from '../../src/main/primerLane'
import { PRIMER_LIMIT } from '../../src/main/primerSessionGuard'
import { buildInjectedInstruction } from '../../src/main/headroom/injectedInstruction'
import {
  startMcpServer,
  awaitMcpPortBound,
  getMcpAuthToken,
  _resetPortStateForTest,
  resetRateLimits,
  type McpToolHandlers,
} from '../../src/main/mcpServer'
import { embedText } from '../../src/main/localEmbedder'
import { hasBundledModel } from './_modelFixture'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

const AB_DIR = path.resolve(__dirname, '../fixtures/memory-ab')
const FIXTURE = path.join(AB_DIR, 'repo')
const HOOK = path.join(AB_DIR, 'primer-hook.cjs')

const ENABLED = process.env.TERMPOLIS_AB === '1'
const DRY = process.env.TERMPOLIS_AB_DRY === '1'
const PROBE = process.env.TERMPOLIS_AB_PROBE === '1'
const MODEL = process.env.TERMPOLIS_AB_MODEL || 'sonnet'
const REPS = Math.max(1, Number(process.env.TERMPOLIS_AB_REPS) || 2)
const EFFORT = process.env.TERMPOLIS_AB_EFFORT || ''
const KEEP = process.env.TERMPOLIS_AB_KEEP === '1'
const RUN_TIMEOUT_MS = 20 * 60_000

// Only probe for the CLI when the benchmark was asked for: the normal suite must not spawn anything.
const claudeOnPath = ENABLED && !DRY && (() => {
  try { return spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 60_000 }).status === 0 } catch { return false }
})()
const RUNNABLE = ENABLED && hasBundledModel && (DRY || claudeOnPath)

// ── ISOLATION ──────────────────────────────────────────────────────────────────────────────────
// Flags: --setting-sources project drops the user's settings.json (its hooks, including the
// SessionStart memory primer, its plugins and permissions); --strict-mcp-config ignores every MCP
// server not given by --mcp-config; --disable-slash-commands drops skills and commands;
// --no-session-persistence keeps the runs out of the user's transcripts. The --settings file below
// (one per arm) adds autoMemoryEnabled:false and, for ON only, the benchmark's own primer hook.
// Env: --setting-sources does NOT stop the user CLAUDE.md loading (the canary probe proved it), so
// CLAUDE_CODE_DISABLE_CLAUDE_MDS / _AUTO_MEMORY / _ORG_MEMORY are set. Variables that tie a child to
// the parent session or to Termpolis (its headroom proxy among them) are removed. CLAUDE_CONFIG_DIR is
// kept: the run signs in as whatever account the shell already uses; no credentials are read or copied.
const STRIP_ENV = new Set([
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDECODE', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_EFFORT', 'CLAUDE_PID',
  'CLAUDE_SWITCH_REQUEST', 'CLAUDE_CODE_EFFORT_LEVEL', 'NODE_ENV', 'NODE_OPTIONS',
])
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (STRIP_ENV.has(k) || k.startsWith('TERMPOLIS_') || k.startsWith('VITEST') || k === 'TEST') continue
    env[k] = v
  }
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1'
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  env.CLAUDE_CODE_DISABLE_ORG_MEMORY = '1'
  return env
}
const ISOLATION_FLAGS = ['--setting-sources', 'project', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']

// Memory tools the ON arm offers. The rest of Termpolis's MCP surface (terminals, swarm, code graph,
// gateway, linked machines) is hidden with --disallowedTools: this measures memory, not those features.
const ON_TOOLS = new Set(['memory_primer', 'memory_search', 'memory_list', 'memory_related', 'memory_write', 'memory_graph', 'memory_link', 'memory_feedback'])

interface Task { id: string; check: string; preFix: boolean; prompt: string }
interface Seed { project: string; kind: MemoryEntry['kind']; ts: string; tags?: string[]; content: string }
type Arm = 'on' | 'off'
interface RunResult {
  task: string; arm: Arm; rep: number; ok: boolean; reasons: string[]; suite: unknown
  isError: boolean; exit: number | null; timedOut: boolean
  input: number; output: number; cacheRead: number; cacheCreation: number; tokens: number
  cost: number; turns: number; ms: number; wallMs: number
  memoryCalls?: Record<string, number>; primer?: { sessionStart: number; prompt: number }; supersedeMinted?: number
  changed: string; resultText: string
}

const TASKS: Task[] = (JSON.parse(fs.readFileSync(path.join(AB_DIR, 'tasks.json'), 'utf8')).tasks as Task[]).filter((t) => {
  const want = (process.env.TERMPOLIS_AB_TASKS || '').split(',').map((s) => s.trim()).filter(Boolean)
  return want.length === 0 || want.some((w) => t.id === w || t.id.startsWith(w))
})
const SEEDS: Seed[] = JSON.parse(fs.readFileSync(path.join(AB_DIR, 'memories.json'), 'utf8')).memories

// T1's fix, applied to every other task's copy so they start from a green suite.
const PREFIX_FROM = "const { freshStore, seedCustomers } = require('./helpers/fixtures')\n"
const PREFIX_TO = PREFIX_FROM + "const { useFrozenClock } = require('./helpers/clock')\n\nuseFrozenClock()\n"

const real = (p: string): string => fs.realpathSync.native(p)
const fwd = (p: string): string => p.replace(/\\/g, '/')

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=ledgerly', '-c', 'user.email=dev@ledgerly.test', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' })
  return (r.stdout || '') + (r.stderr || '')
}

function prepareRun(task: Task | null): { root: string; dir: string } {
  const root = real(fs.mkdtempSync(path.join(os.tmpdir(), 'memab-')))
  const dir = path.join(root, 'ledgerly')
  fs.cpSync(FIXTURE, dir, { recursive: true })
  if (task?.preFix) {
    const f = path.join(dir, 'test/reminders.unit.js')
    const s = fs.readFileSync(f, 'utf8')
    if (!s.includes(PREFIX_FROM)) throw new Error('T1 pre-fix anchor missing')
    fs.writeFileSync(f, s.replace(PREFIX_FROM, PREFIX_TO))
  }
  git(dir, ['init', '-q'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'baseline'])
  return { root, dir }
}

// ── The ON arm's memory: a fresh store per run, seeded, with the supersession pass run ──────────
const calls: Record<string, number> = {}
const count = (name: string): void => { calls[name] = (calls[name] ?? 0) + 1 }

async function seedStore(root: string, runDir: string): Promise<{ minted: number; oldDecisionHidden: boolean }> {
  _resetForTests()
  _setEmbeddingsAvailable(null) // the real bge embedder
  initSwarmMemory(path.join(root, 'store'))
  for (const s of SEEDS) {
    await memoryWrite({ agentId: 'claude-code', kind: s.kind, content: s.content, tags: s.tags, project: s.project === 'RUN' ? runDir : s.project, ts: Date.parse(s.ts) })
  }
  const { minted } = await memorySupersedePass({})
  const hits = await memorySearch({ query: 'invoice number format', limit: 10, project: runDir })
  const oldDecision = SEEDS.find((x) => x.kind === 'decision' && x.tags?.includes('invoice-numbers'))?.content
  const oldDecisionHidden = !hits.some((h) => h.content === oldDecision)
  return { minted, oldDecisionHidden }
}

// The app's handlers (src/main/index.ts) for the memory tools, minus the parts a fresh store makes
// no-ops (the correction overlay, metrics, the metacognition lines appended to a full primer).
const CODE_TOOLS_LINE = /^For questions about code STRUCTURE[^\n]*\n?/m
const primerRecent = createPrimerRecent({ list: async (o) => memoryList(o), correct: (rows) => rows })
const notInBenchmark = (name: string) => (): never => { throw new Error(`${name} is not available in the memory benchmark`) }
function handlers(): McpToolHandlers {
  const h: Record<string, unknown> = {}
  for (const name of ['listTerminals', 'createTerminal', 'runCommand', 'runAndWait', 'testCoverage', 'readOutput', 'closeTerminal', 'writeToTerminal',
    'getFileTree', 'getGitStatus', 'swarmSendMessage', 'swarmReadMessages', 'swarmCreateTask', 'swarmListTasks', 'swarmUpdateTask', 'swarmListAgents',
    'memorySelfcheck', 'memoryPool', 'memoryAnticipate', 'memoryConflicts', 'memoryCorrect', 'codeExplore', 'codeCallers', 'codeCallees', 'codeImpact',
    'codeSearch', 'codeLocate', 'gatewayListTools', 'gatewayCall', 'retrieveFull', 'linkedMachines', 'agentExec', 'savingsReceipt', 'recallBench']) {
    h[name] = notInBenchmark(name)
  }
  const mem: Partial<McpToolHandlers> = {
    memoryWrite: async (input) => { count('memory_write'); return memoryWrite({ agentId: input.agentId || 'agent', kind: (input.kind as MemoryEntry['kind']) || 'note', content: input.content, tags: input.tags, taskId: input.taskId, project: input.project }) },
    memorySearch: async (o) => { count('memory_search'); return memorySearch({ query: o.query, limit: o.limit, agentId: o.agentId, kind: o.kind as MemoryEntry['kind'] | undefined, taskId: o.taskId, project: o.project, diversify: o.diversify, fuseGraph: o.fuseGraph }) },
    memoryList: (o) => { count('memory_list'); return memoryList({ limit: o.limit, agentId: o.agentId, kind: o.kind as MemoryEntry['kind'] | undefined, since: o.since, project: o.project, active: true }) },
    memoryRelated: async (o) => { count('memory_related'); return memoryRelated({ id: o.id, query: o.query, limit: o.limit }) },
    memoryGraph: async (o) => { count('memory_graph'); return memoryGraphQuery({ id: o.id, query: o.query, relation: o.relation as never, depth: o.depth, limit: o.limit }) },
    memoryLink: (o) => { count('memory_link'); return memoryLink({ from: o.from, to: o.to, relation: o.relation, createdBy: 'agent' }) },
    memoryFeedback: (o) => { count('memory_feedback'); return memoryFeedback({ id: o.id, helpful: o.helpful, query: o.query }) },
    memoryPrimer: async (opts) => {
      count(opts.focused ? 'memory_primer(prompt)' : 'memory_primer')
      const project = opts.cwd ? normalizeProjectSlug(opts.cwd) : ''
      const query = (opts.query || '').trim() || (project ? `recent work, decisions, conventions, and context for ${project}` : 'recent work, key decisions, and conventions')
      const primer = await buildContextPrimer(memorySearch, {
        query,
        limit: opts.limit ?? PRIMER_LIMIT,
        maxSnippetChars: 600,
        project: project || undefined,
        projectPath: opts.cwd || undefined,
        ...(opts.focused ? {} : { recent: primerRecent }),
        ...(opts.excludeIds ? { excludeIds: opts.excludeIds } : {}),
      })
      // The app's primer ends with a paragraph steering the agent to the code-graph tools. This arm hides
      // those tools, so the paragraph is cut rather than left pointing at tools the agent cannot call.
      return { project: project || null, primer: primer ? primer.replace(CODE_TOOLS_LINE, '') : primer }
    },
  }
  return { ...h, ...mem } as unknown as McpToolHandlers
}

function rpc(port: number, auth: string, method: string, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    const req = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}`, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
    })
    req.on('error', reject)
    req.end(body)
  })
}

// ── One claude run. Async spawn: the MCP server lives in this process, so a sync spawn would starve it. ──
interface ArmConfig { args: string[] }
function onArmConfig(root: string, runDir: string, port: number, auth: string, hiddenTools: string[]): ArmConfig {
  const bearerFile = path.join(root, 'bearer.txt')
  fs.writeFileSync(bearerFile, auth)
  const mcpFile = path.join(root, 'mcp.json')
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { termpolis: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${auth}` } } } }))
  const hookCmd = `"${fwd(process.execPath)}" "${fwd(HOOK)}" ${port} "${fwd(bearerFile)}" "${fwd(path.join(root, 'hook.log'))}"`
  const hook = [{ hooks: [{ type: 'command', command: hookCmd, timeout: 30 }] }]
  const settingsFile = path.join(root, 'settings.json')
  fs.writeFileSync(settingsFile, JSON.stringify({ autoMemoryEnabled: false, hooks: { SessionStart: hook, UserPromptSubmit: hook } }))
  // The launch instruction exactly as the app builds it with its hook installed; steering (an output-length
  // directive from Token Headroom, not memory) off. Its code_locate / code_explore line names tools this arm
  // does not offer, so that one sentence is dropped.
  const instruction = buildInjectedInstruction({ cwd: runDir, steering: false, sudoAskpass: false, hookInstalled: true })
    .replace(/For code questions use the termpolis code_locate \/ code_explore tools before reading whole files\. ?/, '')
  const instructionFile = path.join(root, 'instruction.txt')
  fs.writeFileSync(instructionFile, instruction)
  return { args: ['--mcp-config', mcpFile, '--settings', settingsFile, '--append-system-prompt-file', instructionFile, '--disallowedTools', hiddenTools.join(',')] }
}
function offArmConfig(root: string): ArmConfig {
  const settingsFile = path.join(root, 'settings.json')
  fs.writeFileSync(settingsFile, JSON.stringify({ autoMemoryEnabled: false }))
  return { args: ['--settings', settingsFile] }
}

function runClaude(cwd: string, prompt: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exit: number | null; timedOut: boolean; wallMs: number }> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('claude', args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { child.kill() } catch { /* gone */ } }, timeoutMs)
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', (e) => { stderr += String(e) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, exit: code, timedOut, wallMs: Date.now() - started }) })
    child.stdin.end(prompt) // the prompt goes on stdin, so no variadic flag can swallow it
  })
}

function baseArgs(format: string): string[] {
  return ['-p', '--output-format', format, '--model', MODEL, '--dangerously-skip-permissions', ...(EFFORT ? ['--effort', EFFORT] : []), ...ISOLATION_FLAGS]
}

function lastJson(text: string): any {
  const lines = text.trim().split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]) } catch { /* keep looking */ }
  }
  return null
}

function hookLog(root: string): Array<{ event: string; chars?: number; primer?: string; skipped?: string }> {
  try { return fs.readFileSync(path.join(root, 'hook.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}

// ── Reporting ──────────────────────────────────────────────────────────────────────────────────
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const pct = (on: number, off: number): string => (off ? `${on >= off ? '+' : ''}${(((on - off) / off) * 100).toFixed(1)}%` : 'n/a')
interface Agg { n: number; success: number; tokens: number; input: number; output: number; cacheRead: number; cacheCreation: number; cost: number; turns: number; ms: number }
function agg(rows: RunResult[]): Agg {
  return {
    n: rows.length,
    success: rows.filter((r) => r.ok).length,
    tokens: mean(rows.map((r) => r.tokens)),
    input: mean(rows.map((r) => r.input)),
    output: mean(rows.map((r) => r.output)),
    cacheRead: mean(rows.map((r) => r.cacheRead)),
    cacheCreation: mean(rows.map((r) => r.cacheCreation)),
    cost: mean(rows.map((r) => r.cost)),
    turns: mean(rows.map((r) => r.turns)),
    ms: mean(rows.map((r) => r.ms)),
  }
}
function table(results: RunResult[]): string {
  const pad = (s: string, n: number): string => s.padEnd(n)
  const lines = [
    `${pad('task', 16)}${pad('arm', 5)}${pad('success', 9)}${pad('tokens', 11)}${pad('output', 8)}${pad('cost $', 9)}${pad('turns', 7)}time s`,
  ]
  const groups = [...TASKS.map((t) => t.id), 'TOTAL']
  for (const g of groups) {
    const rows = g === 'TOTAL' ? results : results.filter((r) => r.task === g)
    const on = agg(rows.filter((r) => r.arm === 'on'))
    const off = agg(rows.filter((r) => r.arm === 'off'))
    for (const [name, a] of [['on', on], ['off', off]] as const) {
      lines.push(`${pad(g, 16)}${pad(name, 5)}${pad(`${a.success}/${a.n}`, 9)}${pad(Math.round(a.tokens).toString(), 11)}${pad(Math.round(a.output).toString(), 8)}${pad(a.cost.toFixed(4), 9)}${pad(a.turns.toFixed(1), 7)}${(a.ms / 1000).toFixed(1)}`)
    }
    lines.push(`${pad(g, 16)}${pad('Δ', 5)}${pad(`${on.success - off.success >= 0 ? '+' : ''}${on.success - off.success}`, 9)}${pad(pct(on.tokens, off.tokens), 11)}${pad(pct(on.output, off.output), 8)}${pad(pct(on.cost, off.cost), 9)}${pad(pct(on.turns, off.turns), 7)}${pct(on.ms, off.ms)}`)
  }
  return lines.join('\n')
}

describe.skipIf(!RUNNABLE)('MEMORY A/B — Claude Code with vs without Termpolis memory on real tasks', () => {
  it('runs every task in both arms and reports success, tokens, cost, turns and time', async () => {
    process.env.TERMPOLIS_MCP_BASE_PORT = String(27000 + Math.floor(Math.random() * 20000))
    _resetPortStateForTest()
    const server = startMcpServer(handlers())
    try {
      const port = await awaitMcpPortBound()
      const auth = getMcpAuthToken()
      const listed = await rpc(port, auth, 'tools/list', {})
      const hiddenTools = (listed.result.tools as Array<{ name: string }>).map((t) => t.name).filter((n) => !ON_TOOLS.has(n)).map((n) => `mcp__termpolis__${n}`)

      if (DRY) {
        for (const task of TASKS) {
          const { root, dir } = prepareRun(task)
          const seeded = await seedStore(root, dir)
          const start = await rpc(port, auth, 'tools/call', { name: 'memory_primer', arguments: { cwd: dir, limit: 12, source: 'session-start' } })
          const first = await rpc(port, auth, 'tools/call', { name: 'memory_primer', arguments: { cwd: dir, query: task.prompt.slice(0, 400), limit: 6, source: 'prompt', sessionId: `dry-${task.id}-${Date.now()}` } })
          console.log(`\n===== ${task.id}  supersede minted=${seeded.minted} oldDecisionHidden=${seeded.oldDecisionHidden}\n--- session-start primer ---\n${JSON.parse(start.result.content[0].text).primer}\n--- first-prompt primer ---\n${JSON.parse(first.result.content[0].text).primer}`)
          fs.rmSync(root, { recursive: true, force: true })
        }
        const decisions = SEEDS.filter((x) => x.kind === 'decision' && x.tags?.includes('invoice-numbers')).map((x) => x.content)
        const [va, vb] = await Promise.all(decisions.map((d) => embedText(d)))
        if (va && vb) console.log(`\ncosine(old decision, new decision) = ${va.reduce((acc, x, i) => acc + x * vb[i], 0).toFixed(4)} (explicit supersession needs >= 0.85)`)
        console.log(`hidden tools (${hiddenTools.length}): ${hiddenTools.join(',')}`)
        return
      }

      if (PROBE) {
        // One cheap canary per arm: what tools, servers, plugins and hooks did the session get, and does
        // anything from the user's own CLAUDE.md / memory reach it?
        const canary = 'Without using any tools, answer in one JSON object with these keys: "user_name" (the human user\'s name if anything in your instructions or context gives it, else null), "security_vendor" (any endpoint-security or EDR product named in your instructions, else null), "desktop_app" (any desktop application named in your instructions other than this repo, else null), "memory_digest" (the first 100 characters of any project-memory digest in your context, else null), "invoice_format" (the invoice-number format your context says is current, else null).'
        for (const arm of ['off', 'on'] as Arm[]) {
          const { root, dir } = prepareRun(null)
          if (arm === 'on') await seedStore(root, dir)
          const cfg = arm === 'on' ? onArmConfig(root, dir, port, auth, hiddenTools) : offArmConfig(root)
          const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--model', 'haiku', '--dangerously-skip-permissions', ...ISOLATION_FLAGS, ...cfg.args]
          const r = await runClaude(dir, canary, args, 5 * 60_000)
          const events = r.stdout.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
          const init = events.find((e: any) => e.type === 'system' && e.subtype === 'init') || {}
          const hookEvents = events.filter((e: any) => /hook/i.test(String(e.subtype || e.type))).map((e: any) => `${e.subtype || e.type}:${e.hook_event || e.hook_name || e.hookEventName || ''}`)
          const result = events.find((e: any) => e.type === 'result') || {}
          console.log(`\n===== PROBE ${arm}\nmcp_servers: ${JSON.stringify(init.mcp_servers)}\ntools (${(init.tools || []).length}): ${(init.tools || []).join(', ')}\nplugins: ${JSON.stringify(init.plugins)}\nskills: ${JSON.stringify(init.skills)} slash_commands: ${JSON.stringify(init.slash_commands)}\nhook events: ${JSON.stringify(hookEvents)}\nhook log: ${JSON.stringify(hookLog(root).map((h) => ({ event: h.event, chars: h.chars, skipped: h.skipped })))}\nusage: ${JSON.stringify(result.usage)} cost: ${result.total_cost_usd}\nanswer: ${result.result}\nstderr: ${r.stderr.slice(0, 500)}`)
          fs.rmSync(root, { recursive: true, force: true })
        }
        return
      }

      const results: RunResult[] = []
      const total = TASKS.length * 2 * REPS
      for (let rep = 1; rep <= REPS; rep++) {
        for (const [ti, task] of TASKS.entries()) {
          // Alternate which arm goes first, so neither always runs on a warmer prompt cache.
          const order: Arm[] = (rep + ti) % 2 === 0 ? ['on', 'off'] : ['off', 'on']
          for (const arm of order) {
            const { root, dir } = prepareRun(task)
            for (const k of Object.keys(calls)) delete calls[k]
            resetRateLimits()
            let minted: number | undefined
            let cfg: ArmConfig
            if (arm === 'on') {
              minted = (await seedStore(root, dir)).minted
              cfg = onArmConfig(root, dir, port, auth, hiddenTools)
            } else {
              cfg = offArmConfig(root)
            }
            const r = await runClaude(dir, task.prompt, [...baseArgs('json'), ...cfg.args], RUN_TIMEOUT_MS)
            const j = lastJson(r.stdout) || {}
            const u = j.usage || {}
            const chk = spawnSync(process.execPath, [path.join(AB_DIR, 'checks', task.check), dir, FIXTURE], { encoding: 'utf8', timeout: 5 * 60_000 })
            const verdict = lastJson(chk.stdout || '') || { ok: false, reasons: [`check produced no verdict: ${(chk.stderr || '').slice(0, 300)}`] }
            const hl = hookLog(root)
            const row: RunResult = {
              task: task.id, arm, rep, ok: !!verdict.ok, reasons: verdict.reasons || [], suite: verdict.suite ?? null,
              isError: !!j.is_error || !r.stdout.trim(), exit: r.exit, timedOut: r.timedOut,
              input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheCreation: u.cache_creation_input_tokens ?? 0,
              tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
              cost: j.total_cost_usd ?? 0, turns: j.num_turns ?? 0, ms: j.duration_ms ?? r.wallMs, wallMs: r.wallMs,
              changed: git(dir, ['status', '--porcelain']).trim().split('\n').slice(0, 20).join('; '),
              resultText: String(j.result ?? r.stderr ?? '').slice(0, 400),
              ...(arm === 'on' ? {
                memoryCalls: { ...calls },
                primer: { sessionStart: hl.find((h) => h.event === 'SessionStart')?.chars ?? 0, prompt: hl.find((h) => h.event === 'UserPromptSubmit')?.chars ?? 0 },
                supersedeMinted: minted,
              } : {}),
            }
            results.push(row)
            console.log(`[${results.length}/${total}] ${task.id} ${arm} rep${rep}: ${row.ok ? 'PASS' : 'FAIL'} tokens=${row.tokens} cost=$${row.cost.toFixed(4)} turns=${row.turns} ${(row.ms / 1000).toFixed(0)}s` +
              (arm === 'on' ? ` primer=${row.primer?.sessionStart}/${row.primer?.prompt}ch calls=${JSON.stringify(row.memoryCalls)} minted=${minted}` : '') +
              (row.ok ? '' : ` :: ${row.reasons.slice(0, 2).join(' | ')}`))
            if (KEEP) console.log(`   kept: ${dir}`)
            else fs.rmSync(root, { recursive: true, force: true })
          }
        }
      }

      const on = agg(results.filter((r) => r.arm === 'on'))
      const off = agg(results.filter((r) => r.arm === 'off'))
      console.log(`\nMEMORY A/B — model=${MODEL} reps=${REPS} tasks=${TASKS.length}\n${table(results)}`)
      const out = process.env.TERMPOLIS_AB_OUT || path.join(os.tmpdir(), `memory-ab-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
      fs.writeFileSync(out, JSON.stringify({ model: MODEL, reps: REPS, effort: EFFORT || null, at: new Date().toISOString(), results }, null, 2))
      console.log(`raw results: ${out}`)
      const delta = (a: number, b: number): number | null => (b ? +(((a - b) / b) * 100).toFixed(1) : null)
      console.log('PROOF|' + JSON.stringify({
        bench: 'memory-ab', model: MODEL, reps: REPS, tasks: TASKS.map((t) => t.id),
        on, off,
        deltaPct: { tokens: delta(on.tokens, off.tokens), output: delta(on.output, off.output), cost: delta(on.cost, off.cost), turns: delta(on.turns, off.turns), ms: delta(on.ms, off.ms) },
        successDelta: on.success - off.success,
      }))

      // Sanity only, never the verdict: every run produced a result, and the ON arm really got memory.
      expect(results.length).toBe(total)
      expect(results.filter((r) => r.arm === 'on').every((r) => (r.primer?.sessionStart ?? 0) > 0)).toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      _resetPortStateForTest()
      resetRateLimits()
      _resetForTests()
    }
  }, 6 * 60 * 60_000)
})
