/**
 * Branch-coverage backfill for three pure-ish renderer libs:
 *   - src/renderer/src/lib/agentStatusDetector.ts
 *   - src/renderer/src/lib/memoryDashboard.ts
 *   - src/renderer/src/lib/conductorManager.ts
 *
 * These tests deliberately target the paths the happy-path suites never reach:
 * error arms, `?? fallback` arms, the "no data" tiles, the self-terminating
 * monitoring loop, and the auth handshake. Every test asserts observable
 * behaviour (return value, thrown/swallowed error, store transition, or the
 * exact string a user would see), never just "it ran".
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'

// ---------------------------------------------------------------------------
// Module mocks (must be hoisted above the imports of the modules under test)
// ---------------------------------------------------------------------------

// Incrementing uuid so we can tell conductor terminal #1 from #2 when
// startConductor is called twice (the duplicate-conductor guard).
const uuidState = vi.hoisted(() => ({ n: 0 }))
vi.mock('uuid', () => ({ v4: vi.fn(() => `cm-uuid-${++uuidState.n}`) }))

const mockRecordSwarmError = vi.fn()
vi.mock('../../src/renderer/src/lib/sentry', () => ({
  recordSwarmError: (...args: unknown[]) => mockRecordSwarmError(...args),
  Sentry: { addBreadcrumb: vi.fn(), captureException: vi.fn() },
  initSentry: vi.fn(),
}))

import { detectAgentStatus } from '../../src/renderer/src/lib/agentStatusDetector'
import {
  compactNumber,
  pct,
  dashboardReceipts,
  codeGraphReceipt,
  compositionRows,
  reliabilityTiles,
  teachingRows,
  competenceRows,
  svgLine,
  sourceLabel,
  portabilityRows,
  typeColor,
} from '../../src/renderer/src/lib/memoryDashboard'
import {
  startConductor,
  stopConductor,
  sendTask,
  waitForAuth,
  revealConductor,
  getConductorState,
} from '../../src/renderer/src/lib/conductorManager'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import type { MemoryMetrics } from '../../src/renderer/src/types'

// ===========================================================================
// 1. agentStatusDetector — the branches the happy-path suite never reaches
// ===========================================================================

describe('agentStatusDetector — uncovered branches', () => {
  const filler = (lines: number): string =>
    Array(lines).fill('some terminal output line here').join('\n')

  describe('no-signal fallback (keeps the previous status)', () => {
    it('returns the previous status with an EMPTY summary when nothing matches', () => {
      // Empty buffer + a non-'starting' previous status: every detector must
      // decline, and the caller must be told "I have no new information"
      // (empty summary) rather than being handed a fabricated state.
      const result = detectAgentStatus('', 'Gemini', 'working')
      expect(result).toEqual({ status: 'working', summary: '' })
    })

    it('does not invent a status from a short, promptless trailing line', () => {
      // Last line is under the 20-char "still generating" threshold and does
      // not end in a shell prompt char, so neither thinking nor idle applies.
      const result = detectAgentStatus(`${filler(6)}\nok`, 'Gemini', 'errored')
      expect(result).toEqual({ status: 'errored', summary: '' })
    })
  })

  describe('errored — shell / install failures (v1.x Windows launch bugs)', () => {
    it('flags the .exe stub "not a valid application for this OS platform"', () => {
      const output =
        `${filler(6)}\nProgram 'claude.exe' failed to run: The specified executable is not a valid application for this OS platform.\n`
      const result = detectAgentStatus(output, 'Claude', 'starting')
      expect(result.status).toBe('errored')
      expect(result.summary).toMatch(/not a valid application/i)
    })

    it('flags cmd.exe\'s "is not recognized as an internal or external command"', () => {
      const output =
        `${filler(6)}\n'claude' is not recognized as an internal or external command, operable program or batch file.\n`
      const result = detectAgentStatus(output, 'Claude', 'starting')
      expect(result.status).toBe('errored')
      // No line in the window carries an error-ish keyword, so the extractor
      // honestly falls back rather than quoting an unrelated line.
      expect(result.summary).toBe('Agent encountered an error')
    })

    it('flags PowerShell\'s "The system cannot find the file specified"', () => {
      const output =
        `${filler(6)}\nStart-Process : This command cannot be run due to the error: The system cannot find the file specified.\n`
      const result = detectAgentStatus(output, 'Claude', 'starting')
      expect(result.status).toBe('errored')
      expect(result.summary).toMatch(/cannot find the file specified/i)
    })

    it('flags ApplicationFailedException / NativeCommandFailed', () => {
      const output = `${filler(6)}\nclaude.exe : ApplicationFailedException — the application failed to launch.\n`
      const result = detectAgentStatus(output, 'Claude', 'starting')
      expect(result.status).toBe('errored')
      expect(result.summary).toMatch(/ApplicationFailedException/i)
    })

    it('flags the Claude stub shim "native binary not installed"', () => {
      // This output also contains "npm install", which isWorking() matches —
      // errored must win, otherwise a dead agent reads as busy forever.
      const output =
        `${filler(6)}\nError: Claude native binary not installed. Run: npm install -g @anthropic-ai/claude-code --force\n`
      const result = detectAgentStatus(output, 'Claude', 'starting')
      expect(result.status).toBe('errored')
      expect(result.summary).toMatch(/native binary not installed/i)
    })

    it('flags zsh\'s "command not found: claude"', () => {
      const output = `${filler(6)}\nzsh: command not found: claude\n`
      const result = detectAgentStatus(output, 'Claude', 'starting')
      expect(result.status).toBe('errored')
      expect(result.summary).toBe('Agent encountered an error')
    })
  })

  describe('idle — agent TUI prompt box (not the trailing-char shell prompt)', () => {
    it('reads a Claude Code "> " prompt line as idle even with a hint line under it', () => {
      // Real Claude Code idle screen: the prompt line is NOT the last line —
      // a hint line follows it — so the trailing-shell-prompt check misses and
      // the claude-specific `^>$` rule is what has to catch it.
      const output = `${filler(6)}\n> \n  ? for shortcuts`
      const result = detectAgentStatus(output, 'Claude', 'working')
      expect(result).toEqual({ status: 'idle', summary: 'Waiting at prompt' })
    })

    it('reads a Codex "> " prompt line as idle even with a hint line under it', () => {
      const output = `${filler(6)}\n> \n  ctrl+c to quit`
      const result = detectAgentStatus(output, 'Codex', 'working')
      expect(result).toEqual({ status: 'idle', summary: 'Waiting at prompt' })
    })

    it('does NOT read a non-claude/codex agent\'s hint line as idle', () => {
      // Same buffer, Gemini: neither agent-specific rule applies, so this must
      // fall through to the previous-status fallback instead of a false "idle".
      const output = `${filler(6)}\n> \n  ctrl+c to quit`
      const result = detectAgentStatus(output, 'Gemini', 'working')
      expect(result.status).toBe('working')
    })
  })

  describe('starting — long startup output (past the <100 char shortcut)', () => {
    it('stays starting while a long banner is still initializing', () => {
      const output = [
        'Termpolis conductor shell ready',
        'Checking agent availability across the workspace',
        'Initializing MCP bridge and tool registry',
      ].join('\n')
      expect(output.trim().length).toBeGreaterThan(100) // past the short-output shortcut
      const result = detectAgentStatus(output, 'Claude', 'starting')
      expect(result).toEqual({ status: 'starting', summary: 'Agent initializing...' })
    })

    it('stays starting on a long-ish version banner with no loading keyword', () => {
      const output = [
        'claude version 1.2.3',
        'Copyright (c) Anthropic PBC. All rights reserved.',
        'Model: claude-opus-4-8',
        'Workspace: C:\\dev\\termpolis',
      ].join('\n')
      expect(output.trim().length).toBeGreaterThan(100)
      expect(output.trim().length).toBeLessThan(500)
      const result = detectAgentStatus(output, 'Claude', 'starting')
      expect(result.status).toBe('starting')
    })

    it('a startup banner does NOT hold a non-starting agent in starting', () => {
      const output = [
        'Termpolis conductor shell ready',
        'Checking agent availability across the workspace',
        'Initializing MCP bridge and tool registry',
      ].join('\n')
      // Previous status is 'working': the hysteresis gate must reject it.
      expect(detectAgentStatus(output, 'Claude', 'working').status).not.toBe('starting')
    })
  })

  describe('completion summary extraction', () => {
    it('falls back to "Task completed" when the banner scrolled out of the summary window', () => {
      // isCompleted() scans the whole 1500-char tail, but the summary extractor
      // only reads the last 5 lines. When the COMPLETE banner is older than
      // that, the status must still be completed and the summary must be the
      // honest generic string — not a random unrelated line.
      const output = [
        'SWARM COMPLETE',
        'alpha rollup line',
        'beta rollup line',
        'gamma rollup line',
        'delta rollup line',
        'epsilon rollup line',
        'zeta rollup line',
      ].join('\n')
      const result = detectAgentStatus(output, 'Claude', 'working')
      expect(result).toEqual({ status: 'completed', summary: 'Task completed' })
    })
  })
})

// ===========================================================================
// 2. memoryDashboard — fallbacks, grading arms and the "no data" contract
// ===========================================================================

function mm(over: Partial<MemoryMetrics> = {}): MemoryMetrics {
  return {
    ledger: {
      generatedTs: 0,
      recalls: 0, recallFiredRate: 0, avgHits: 0, avgTopScore: 0, avgLatencyMs: 0,
      byPath: { vector: 0, keyword: 0, cache: 0 },
      embedAvailability: 1, writes: 0, writeDurability: 1,
      injects: 0, tokensInjected: 0, reusedSolutions: 0, tokensSavedEstimate: 0,
      feedbackCount: 0, feedbackHelpfulRate: 0,
      lessonsLearned: 0, crossAgentRecalls: 0, teachingMatrix: {},
      ...(over.ledger || {}),
    },
    store: { total: 0, capacity: 500000, byType: {}, bySource: {}, lessons: 0, timeline: [], ...(over.store || {}) },
    graph: { nodes: 0, edges: 0, byRelation: {}, ...(over.graph || {}) },
    competence: over.competence || [],
    recentActivity: over.recentActivity || [],
    codeGraph: over.codeGraph,
  }
}

describe('memoryDashboard — uncovered branches', () => {
  describe('formatters must never render NaN/Infinity into the UI', () => {
    it('compactNumber renders non-finite input as "0", not "NaN"', () => {
      expect(compactNumber(NaN)).toBe('0')
      expect(compactNumber(Infinity)).toBe('0')
      expect(compactNumber(-Infinity)).toBe('0')
    })

    it('compactNumber handles negatives on both sides of the k/M thresholds', () => {
      expect(compactNumber(-1500)).toBe('-1.5k')
      expect(compactNumber(-2_000_000)).toBe('-2M')
      expect(compactNumber(-12)).toBe('-12')
    })

    it('pct coerces a NaN ratio to 0%, not "NaN%"', () => {
      expect(pct(NaN)).toBe('0%')
      expect(pct(undefined as unknown as number)).toBe('0%')
    })
  })

  describe('dashboardReceipts sparklines', () => {
    it('maps the weekly timeline into per-tile spark series', () => {
      const r = dashboardReceipts(mm({
        store: {
          total: 300, capacity: 500000, byType: { episodic: 300 }, bySource: { claude: 300 }, lessons: 40,
          timeline: [
            { t: 1, total: 10, lessons: 1 },
            { t: 2, total: 25, lessons: 4 },
            { t: 3, total: 300, lessons: 40 },
          ],
        },
      }))
      expect(r[0].spark).toEqual([10, 25, 300])   // memories over time
      expect(r[1].spark).toEqual([1, 4, 40])      // lessons over time
      // The connection/token tiles have no honest per-tile series — they must
      // carry NO sparkline rather than a faked one.
      expect(r[2].spark).toBeUndefined()
      expect(r[3].spark).toBeUndefined()
    })

    it('survives a metrics payload with no timeline at all (older brain)', () => {
      const noTimeline = mm({
        store: { total: 5, capacity: 10, byType: { episodic: 5 }, bySource: { claude: 5 }, lessons: 0, timeline: undefined as unknown as [] },
      })
      const r = dashboardReceipts(noTimeline)
      expect(r).toHaveLength(4)
      expect(r[0].value).toBe('5')
      expect(r[0].spark).toEqual([])
      expect(r[1].spark).toEqual([])
    })
  })

  describe('compositionRows', () => {
    it('reports 0% (not NaN%) when every bucket is zero', () => {
      const rows = compositionRows({ episodic: 0, semantic: 0 })
      expect(rows).toHaveLength(2)
      expect(rows.every((r) => r.pct === 0)).toBe(true)
      expect(rows.every((r) => Number.isNaN(r.pct))).toBe(false)
    })
  })

  describe('reliabilityTiles — the honest-grading contract', () => {
    it('grades mid-band values as warn', () => {
      const tiles = reliabilityTiles(mm({
        ledger: {
          ...mm().ledger,
          recalls: 100, recallFiredRate: 0.75,   // >=0.6, <0.9  -> warn
          embedUp: true, embedRecentUp: 20, embedRecentTotal: 20, // model is UP -> good (a status, not a rate)
          writes: 50, writeDurability: 0.97,     // >=0.95, <0.999 -> warn
          avgLatencyMs: 350,                     // >=250, <600 -> warn (cross-process recall floor)
        },
      }))
      expect(tiles.map((t) => t.status)).toEqual(['warn', 'good', 'warn', 'warn'])
      expect(tiles[0].value).toBe('75%')
      expect(tiles[3].value).toBe('350ms')
    })

    it('grades floor values as bad', () => {
      const tiles = reliabilityTiles(mm({
        ledger: {
          ...mm().ledger,
          recalls: 100, recallFiredRate: 0.3,
          embedUp: false, embedRecentUp: 0, embedRecentTotal: 20, // actually down NOW -> bad
          writes: 50, writeDurability: 0.5,
          avgLatencyMs: 800,
        },
      }))
      expect(tiles.map((t) => t.status)).toEqual(['bad', 'bad', 'bad', 'bad'])
      expect(tiles[3].value).toBe('800ms')
    })

    // The bug this file now guards, found on a real install: the embedding tile showed the LIFETIME
    // fraction of semantic recalls under a label promising the model's CURRENT state. One nine-minute
    // outage (49 failed recalls in an evening) pinned a perfectly healthy brain at 44% — below the 50%
    // "bad" cut — so the tile sat there RED while semantic recall worked flawlessly. And with no decay
    // in a lifetime average, it would never have gone green again.
    it('a healthy model is GREEN even when its lifetime rate is terrible', () => {
      const tiles = reliabilityTiles(mm({
        ledger: {
          ...mm().ledger,
          recalls: 99,
          embedUp: true,               // working right now — that is the question the tile asks
          embedRecentUp: 8, embedRecentTotal: 8,
          embedAvailability: 0.444,    // ...and this is history. It must not colour the tile.
        },
      }))
      const embed = tiles.find((t) => t.label === 'Embedding model')!
      expect(embed.status).toBe('good')
      expect(embed.value).toBe('up')
      expect(embed.sub).toBe('8 of last 8 recalls semantic') // history, reported but never graded
    })

    it('a model that is actually down says so, and names the fallback', () => {
      const tiles = reliabilityTiles(mm({
        ledger: { ...mm().ledger, recalls: 50, embedUp: false, embedRecentUp: 0, embedRecentTotal: 20, embedAvailability: 0.99 },
      }))
      const embed = tiles.find((t) => t.label === 'Embedding model')!
      expect(embed.status).toBe('bad')
      expect(embed.value).toContain('down')
      // A great lifetime average must NOT hide a live outage — the mirror image of the bug above.
      expect(embed.value).toContain('keyword')
    })

    it('a metric with no events reads "no data", never a flattering 100%', () => {
      // The trap this guards: writeDurability defaults to 1. With zero writes a
      // naive render would proudly show "100%" durability for a brain that has
      // never written anything. It must read "no data"/idle instead — while the
      // recall tiles, which DO have events, still show their real numbers.
      const tiles = reliabilityTiles(mm({
        ledger: { ...mm().ledger, recalls: 20, recallFiredRate: 0.95, embedAvailability: 1, writes: 0, writeDurability: 1, avgLatencyMs: 10 },
      }))
      const byLabel = Object.fromEntries(tiles.map((t) => [t.label, t]))
      expect(byLabel['Write durability']).toMatchObject({ value: 'no data', status: 'idle' })
      expect(byLabel['Recall fired']).toMatchObject({ value: '95%', status: 'good' })
    })
  })

  describe('teachingRows / portabilityRows — malformed matrices', () => {
    it('teachingRows returns [] for a missing matrix instead of throwing', () => {
      expect(teachingRows(undefined as unknown as Record<string, Record<string, number>>)).toEqual([])
    })

    it('teachingRows skips an author whose reader map is missing', () => {
      const rows = teachingRows({
        claude: undefined as unknown as Record<string, number>,
        gemini: { claude: 3 },
      })
      expect(rows).toEqual([{ author: 'gemini', reader: 'claude', count: 3, cross: true }])
    })

    it('portabilityRows reports cross=0 for every author when the matrix is missing', () => {
      const rows = portabilityRows(
        { claude: 10, gemini: 4 },
        undefined as unknown as Record<string, Record<string, number>>,
      )
      expect(rows).toEqual([
        { model: 'claude', label: 'Claude', wrote: 10, cross: 0 },
        { model: 'gemini', label: 'Gemini', wrote: 4, cross: 0 },
      ])
    })

    it('portabilityRows skips an author whose reader map is missing', () => {
      const rows = portabilityRows(
        { claude: 10 },
        { gemini: undefined as unknown as Record<string, number>, codex: { claude: 2 } },
      )
      expect(rows).toEqual([{ model: 'claude', label: 'Claude', wrote: 10, cross: 0 }])
    })

    it('portabilityRows keeps only the 8 strongest authors', () => {
      const bySource: Record<string, number> = {}
      for (let i = 0; i < 12; i++) bySource[`agent-${i}`] = i
      const rows = portabilityRows(bySource, {})
      expect(rows).toHaveLength(8)
      expect(rows[0].model).toBe('agent-11') // strongest first
      expect(rows.at(-1)!.model).toBe('agent-4')
    })
  })

  describe('competenceRows', () => {
    it('grades the 0.75..0.85 band as warn', () => {
      const rows = competenceRows(mm({
        competence: [{ domain: 'swarm', attempts: 9, confidence: 0.8 }],
      }))
      expect(rows[0]).toEqual({ domain: 'swarm', confidence: 0.8, attempts: 9, status: 'warn' })
    })

    it('is empty (not a misleading zero row) when the brain has no outcomes yet', () => {
      expect(competenceRows(mm())).toEqual([])
    })
  })

  describe('sourceLabel — a raw machine id must never reach the dashboard', () => {
    it('collapses a terminal UUID to a short session label', () => {
      expect(sourceLabel('a35ab45f-9c1d-4e77-8f21-77ac13b0e0aa')).toBe('session a35ab45…')
    })

    it('collapses a long bare hex id to a short session label', () => {
      expect(sourceLabel('deadbeefcafe1234')).toBe('session deadbee…')
    })

    it('passes an unknown but human-readable source through unchanged', () => {
      expect(sourceLabel('my-custom-agent')).toBe('my-custom-agent')
    })

    it('still prefers the friendly name for a known agent', () => {
      expect(sourceLabel('mneme')).toBe('Reflection')
    })
  })

  describe('typeColor', () => {
    it('returns the palette slot for a known cognitive type', () => {
      expect(typeColor('entity')).toBe('#c98500')
      expect(typeColor('procedural')).toBe('#199e70')
    })

    it('falls back to the episodic blue for an unknown type (never undefined)', () => {
      expect(typeColor('brand-new-type')).toBe('#3987e5')
    })
  })

  describe('svgLine', () => {
    it('places a single point at the horizontal centre of the box', () => {
      const { line, area } = svgLine([7], 100, 50, 5)
      expect(line).toBe('M50.0 5.0')          // x = w/2, y = top (v == max)
      expect(area).toContain('Z')
    })

    it('keeps a flat all-zero series on the baseline instead of dividing by zero', () => {
      const { line, max } = svgLine([0, 0, 0], 100, 50, 0)
      expect(max).toBe(1)                      // max is floored at 1
      expect(line).toBe('M0.0 50.0 L50.0 50.0 L100.0 50.0')
      expect(line).not.toContain('NaN')
    })
  })

  describe('codeGraphReceipt', () => {
    it('is null when the code graph has symbols but no edges yet', () => {
      expect(codeGraphReceipt(mm({ codeGraph: { files: 3, symbols: 40, edges: 0 } }))).toBeNull()
    })
  })
})

// ===========================================================================
// 3. conductorManager — auth handshake, failure arms, monitoring self-teardown
// ===========================================================================

type Mock = ReturnType<typeof vi.fn>
interface TermpolisMocks {
  detectAgents: Mock
  createTerminal: Mock
  writeToTerminal: Mock
  killTerminal: Mock
  readTerminalBuffer: Mock
  getHomedir: Mock
  getMcpConfigPath: Mock
  writeConfigFile: Mock
  gitRevParseHead: Mock
}
interface SwarmMocks { sendMessage: Mock; getTasks: Mock; getMessages: Mock }

const tp = (): TermpolisMocks => (window as unknown as { termpolis: TermpolisMocks }).termpolis
const sw = (): SwarmMocks => (window as unknown as { swarmAPI: SwarmMocks }).swarmAPI

/** Buffer payload helper — the shape readTerminalBuffer resolves with. */
const buf = (output: string): { success: true; data: { output: string; length: number } } =>
  ({ success: true, data: { output, length: output.length } })

describe('conductorManager — uncovered branches', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    uuidState.n = 0
    mockRecordSwarmError.mockClear()

    // Fresh mocks every test — no leaked `...Once` queues between cases.
    ;(window as unknown as { termpolis: TermpolisMocks }).termpolis = {
      detectAgents: vi.fn().mockResolvedValue({ success: true, data: { claude: true, codex: true } }),
      createTerminal: vi.fn().mockResolvedValue({ success: true }),
      writeToTerminal: vi.fn(),
      killTerminal: vi.fn().mockResolvedValue({ success: true }),
      readTerminalBuffer: vi.fn().mockResolvedValue(buf('claude 1.0.0 ')),
      getHomedir: vi.fn().mockResolvedValue({ success: true, data: '/home/dev' }),
      getMcpConfigPath: vi.fn().mockResolvedValue({ success: true, data: '/userData/claude-mcp-config.json' }),
      writeConfigFile: vi.fn().mockResolvedValue({ success: true }),
      gitRevParseHead: vi.fn().mockResolvedValue({ success: true, data: 'sha123' }),
    }
    ;(window as unknown as { swarmAPI: SwarmMocks }).swarmAPI = {
      sendMessage: vi.fn().mockResolvedValue({ success: true }),
      getTasks: vi.fn().mockResolvedValue({ success: true, data: [] }),
      getMessages: vi.fn().mockResolvedValue({ success: true, data: [] }),
    }

    useTerminalStore.setState({
      terminals: [],
      swarmActive: false,
      activeTerminalId: null,
      swarmNotification: null,
      swarmCompletionSummary: null,
    })
  })

  afterEach(() => {
    stopConductor()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** Drive startConductor through its two internal sleeps and return its result. */
  async function start(cwd = '/tmp/project'): Promise<{ success: boolean; error?: string; needsAuth?: boolean }> {
    const p = startConductor(cwd)
    await vi.advanceTimersByTimeAsync(2000) // shell init
    await vi.advanceTimersByTimeAsync(5000) // --version echo
    return p
  }

  // ---- startConductor failure + auth arms ----

  it('startConductor kills the previous conductor before spawning a new one', async () => {
    await start()
    expect(getConductorState().terminalId).toBe('cm-uuid-1')

    await start() // second launch without an explicit stop

    // The first conductor must be torn down, not left running alongside the new one.
    expect(tp().killTerminal).toHaveBeenCalledWith('cm-uuid-1')
    expect(getConductorState().terminalId).toBe('cm-uuid-2')
    const conductors = useTerminalStore.getState().terminals.filter((t) => t.isConductor)
    expect(conductors.map((t) => t.id)).toEqual(['cm-uuid-2'])
  })

  it('startConductor surfaces a default message when createTerminal fails without one', async () => {
    tp().createTerminal.mockResolvedValueOnce({ success: false }) // no `error` field
    const res = await startConductor('/tmp/project')

    expect(res).toEqual({ success: false, error: 'Failed to create terminal' })
    expect(getConductorState().status).toBe('error')
    // The swarm must be released so the user can retry.
    expect(useTerminalStore.getState().swarmActive).toBe(false)
  })

  it('startConductor reports needsAuth when the CLI prints a sign-in prompt', async () => {
    tp().readTerminalBuffer.mockResolvedValue(buf('Please sign in: https://claude.ai/auth/cli\n'))

    const res = await start()

    expect(res).toEqual({ success: true, needsAuth: true })
    expect(getConductorState().status).toBe('authenticating')
  })

  it('startConductor treats an unreadable buffer as "no auth prompt" and reports ready', async () => {
    tp().readTerminalBuffer.mockResolvedValue({ success: false, error: 'terminal gone' })

    const res = await start()

    expect(res).toEqual({ success: true, needsAuth: false })
    expect(getConductorState().status).toBe('ready')
  })

  // ---- waitForAuth (previously untested end to end) ----

  it('waitForAuth returns false immediately when there is no conductor terminal', async () => {
    stopConductor() // guarantee terminalId === null
    await expect(waitForAuth()).resolves.toBe(false) // default timeout arg
    expect(getConductorState().status).toBe('idle')  // no state churn
  })

  it('waitForAuth flips the conductor to ready once the version prints with no auth prompt', async () => {
    tp().readTerminalBuffer.mockResolvedValue(buf('Please sign in: https://claude.ai/auth/cli\n'))
    await start()
    expect(getConductorState().status).toBe('authenticating')

    // The user completes the browser login; the next --version echo is clean.
    tp().readTerminalBuffer.mockResolvedValue(buf('claude 1.2.3 (Claude Code)\n'))

    const p = waitForAuth(120000)
    await vi.advanceTimersByTimeAsync(4000) // poll gap
    await vi.advanceTimersByTimeAsync(3000) // echo settle

    await expect(p).resolves.toBe(true)
    expect(getConductorState().status).toBe('ready')
    // It re-issues `--version` to probe, rather than trusting the stale buffer.
    expect(tp().writeToTerminal).toHaveBeenCalledWith('cm-uuid-1', expect.stringContaining('--version'))
  })

  it('waitForAuth keeps waiting while the version AND the auth banner are both on screen', async () => {
    await start()
    // Version is visible but the sign-in banner has not cleared — not authed yet.
    tp().readTerminalBuffer.mockResolvedValue(buf('claude 1.2.3\nPlease sign in to continue\n'))

    const p = waitForAuth(1000) // one poll, then give up
    await vi.advanceTimersByTimeAsync(8000)

    await expect(p).resolves.toBe(false)
    expect(getConductorState()).toMatchObject({ status: 'error', error: 'Authentication timed out' })
  })

  it('waitForAuth times out when the buffer never yields data', async () => {
    await start()
    tp().readTerminalBuffer.mockResolvedValue({ success: true, data: null }) // success, but empty

    const p = waitForAuth(1000)
    await vi.advanceTimersByTimeAsync(8000)

    await expect(p).resolves.toBe(false)
    expect(getConductorState()).toMatchObject({ status: 'error', error: 'Authentication timed out' })
  })

  // ---- sendTask guard rails ----

  it('sendTask refuses to run when there is no conductor and says so on the bus', async () => {
    stopConductor()
    await sendTask('Build a REST API', '/tmp/project')

    expect(sw().sendMessage).toHaveBeenCalledWith(
      'system', 'all', 'info',
      expect.stringContaining('terminal: none'),
    )
    expect(sw().sendMessage).toHaveBeenCalledWith(
      'system', 'all', 'info',
      expect.stringContaining('status: idle'),
    )
    // Nothing was launched.
    expect(tp().writeConfigFile).not.toHaveBeenCalled()
  })

  it('sendTask refuses a second submit while the first is still running (and names the terminal)', async () => {
    await start()
    await sendTask('First task', '/tmp/project')
    expect(getConductorState().status).toBe('running')

    sw().sendMessage.mockClear()
    tp().writeConfigFile.mockClear()

    await sendTask('Second task', '/tmp/project')

    expect(sw().sendMessage).toHaveBeenCalledWith(
      'system', 'all', 'info',
      expect.stringContaining('terminal: cm-uuid-1'),
    )
    expect(sw().sendMessage).toHaveBeenCalledWith(
      'system', 'all', 'info',
      expect.stringContaining('status: running'),
    )
    // The second task must NOT be written or launched.
    expect(tp().writeConfigFile).not.toHaveBeenCalled()
  })

  it('sendTask swallows a broken message bus rather than throwing at the caller', async () => {
    stopConductor()
    sw().sendMessage.mockRejectedValue(new Error('bus down'))

    await expect(sendTask('Build', '/tmp/project')).resolves.toBeUndefined()
  })

  it('sendTask still launches when agent detection fails (empty agent set)', async () => {
    await start()
    tp().detectAgents.mockResolvedValue({ success: false, error: 'PATH scan failed' })

    await sendTask('Build a REST API', '/tmp/project')

    // The prompt is still written and the conductor still launched.
    const taskWrite = tp().writeConfigFile.mock.calls.find(([p]) =>
      typeof p === 'string' && p.endsWith('.termpolis-conductor-task.md'))
    expect(taskWrite).toBeDefined()
    expect(taskWrite![1]).toContain('Build a REST API')
    expect(getConductorState().status).toBe('running')
  })

  it('sendTask falls back to the project cwd when the homedir lookup fails', async () => {
    await start('/tmp/project')
    tp().getHomedir.mockResolvedValue({ success: false, error: 'no home' })

    await sendTask('Build', '/tmp/project')

    expect(tp().writeConfigFile).toHaveBeenCalledWith(
      '/tmp/project/.termpolis-conductor-task.md',
      expect.any(String),
    )
  })

  it('sendTask omits --mcp-config entirely when no config path is available', async () => {
    // An empty value would become `--mcp-config ""` and Claude would error out,
    // so the flag has to disappear rather than be emitted blank.
    await start()
    tp().getMcpConfigPath.mockResolvedValue({ success: false, error: 'not written yet' })

    await sendTask('Build', '/tmp/project')

    const shWrite = tp().writeConfigFile.mock.calls.find(([p]) =>
      typeof p === 'string' && p.endsWith('.termpolis-conductor-run.sh'))
    expect(shWrite).toBeDefined()
    const body = shWrite![1] as string
    expect(body).not.toContain('--mcp-config')
    expect(body).toContain('--dangerously-skip-permissions')
  })

  // ---- E2E test-mode shim (TERMPOLIS_TEST_AGENTS=1) ----

  describe('E2E test-agent substitution', () => {
    beforeEach(() => { process.env.TERMPOLIS_TEST_AGENTS = '1' })
    afterEach(() => { delete process.env.TERMPOLIS_TEST_AGENTS })

    it('bash script invokes the mock shim directly, skipping the binary probe', async () => {
      await start()
      await sendTask('Build', '/tmp/project')

      const shWrite = tp().writeConfigFile.mock.calls.find(([p]) =>
        typeof p === 'string' && p.endsWith('.termpolis-conductor-run.sh'))
      const body = shWrite![1] as string
      expect(body).toContain('node e2e/mocks/mock-claude.cjs -p')
      // The production probe rejects anything that doesn't print "Claude Code",
      // which the mock doesn't — so it must not be emitted in test mode.
      expect(body).not.toContain('resolve_claude')
    })

    it('PowerShell script invokes the mock shim directly, skipping Resolve-WorkingClaude', async () => {
      const original = window.navigator.platform
      Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true })
      try {
        await start()
        await sendTask('Build', '/tmp/project')

        const psWrite = tp().writeConfigFile.mock.calls.find(([p]) =>
          typeof p === 'string' && p.endsWith('.termpolis-conductor-run.ps1'))
        const body = psWrite![1] as string
        expect(body).toContain('node e2e/mocks/mock-claude.cjs -p $task')
        expect(body).not.toContain('Resolve-WorkingClaude')
        expect(body).toContain('exit $LASTEXITCODE')
      } finally {
        Object.defineProperty(window.navigator, 'platform', { value: original, configurable: true })
      }
    })
  })

  describe('Windows launch without an MCP config', () => {
    let original: string
    beforeAll(() => {
      original = window.navigator.platform
      Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true })
    })
    afterAll(() => {
      Object.defineProperty(window.navigator, 'platform', { value: original, configurable: true })
    })

    it('omits the --mcp-config flag from the .ps1 instead of passing an empty one', async () => {
      await start()
      tp().getMcpConfigPath.mockResolvedValue({ success: true, data: '' })

      await sendTask('Build', '/tmp/project')

      const psWrite = tp().writeConfigFile.mock.calls.find(([p]) =>
        typeof p === 'string' && p.endsWith('.termpolis-conductor-run.ps1'))
      const body = psWrite![1] as string
      expect(body).not.toContain('--mcp-config')
      expect(body).toContain('Resolve-WorkingClaude') // production probe still emitted
    })
  })

  // ---- monitoring loop ----

  it('the monitoring loop tears itself down when the conductor stops running', async () => {
    tp().readTerminalBuffer.mockResolvedValue(buf('claude 1.2.3 (Claude Code)\n'))
    await start()
    await sendTask('Build', '/tmp/project')

    // waitForAuth flips the status back to 'ready' — the in-flight loop is now
    // orphaned and must stop polling instead of ticking forever.
    const p = waitForAuth(120000)
    await vi.advanceTimersByTimeAsync(7000)
    await p
    expect(getConductorState().status).toBe('ready')

    sw().getTasks.mockClear()
    await vi.advanceTimersByTimeAsync(15000) // next tick

    expect(sw().getTasks).not.toHaveBeenCalled()
  })

  it('re-arming the monitor does not leave the old interval ticking', async () => {
    tp().readTerminalBuffer.mockResolvedValue(buf('claude 1.2.3 (Claude Code)\n'))
    await start()
    await sendTask('Build', '/tmp/project') // interval #1

    const p = waitForAuth(120000) // status -> ready, interval #1 still armed
    await vi.advanceTimersByTimeAsync(7000)
    await p

    await sendTask('Build again', '/tmp/project') // interval #2 replaces #1

    sw().getTasks.mockClear()
    await vi.advanceTimersByTimeAsync(15000)

    // If interval #1 had survived, BOTH would have fired in this window.
    expect(sw().getTasks).toHaveBeenCalledTimes(1)
  })

  it('the monitoring loop reports the conductor terminal disappearing', async () => {
    await start()
    await sendTask('Build', '/tmp/project')

    // User closes the (revealed) conductor terminal mid-swarm.
    useTerminalStore.setState({ terminals: [] })
    await vi.advanceTimersByTimeAsync(15000)

    expect(getConductorState()).toMatchObject({
      status: 'error',
      error: 'Conductor terminal closed unexpectedly',
    })
    expect(useTerminalStore.getState().swarmNotification).toEqual({
      message: 'Conductor stopped unexpectedly',
      type: 'error',
    })
    // And it stopped polling.
    sw().getTasks.mockClear()
    await vi.advanceTimersByTimeAsync(30000)
    expect(sw().getTasks).not.toHaveBeenCalled()
  })

  it('a refusal with no "I can\'t ..." sentence still produces a readable notification', async () => {
    await start()
    // Trips the refusal detector via "potentially harmful", but carries no
    // extractable "I cannot ..." sentence — the generic snippet must be used.
    tp().readTerminalBuffer.mockResolvedValue(
      buf('That request is potentially harmful, so I am declining to orchestrate it'),
    )

    await sendTask('Do something sketchy', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    expect(useTerminalStore.getState().swarmNotification?.message).toContain(
      'The conductor declined this task.',
    )
    expect(getConductorState().status).toBe('error')
    expect(useTerminalStore.getState().swarmActive).toBe(false)
    expect(sw().sendMessage).toHaveBeenCalledWith(
      'conductor', 'all', 'info',
      expect.stringContaining('Task refused'),
    )
  })

  it('an unreadable conductor buffer does not stop task-based completion', async () => {
    await start()
    tp().readTerminalBuffer.mockResolvedValue({ success: false, error: 'buffer gone' })
    sw().getTasks.mockResolvedValue({ success: true, data: [{ id: 't1', status: 'completed' }] })

    await sendTask('Build', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    expect(getConductorState().status).toBe('done')
    expect(useTerminalStore.getState().swarmNotification).toEqual({
      message: '1 task completed successfully',
      type: 'success',
    })
  })

  it('pluralises the mixed success/failure completion message', async () => {
    await start()
    sw().getTasks.mockResolvedValue({
      success: true,
      data: [
        { id: 't1', status: 'completed' },
        { id: 't2', status: 'completed' },
        { id: 't3', status: 'failed' },
      ],
    })

    await sendTask('Build', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    expect(useTerminalStore.getState().swarmNotification).toEqual({
      message: '2 tasks succeeded, 1 failed',
      type: 'success',
    })
  })

  it('an empty result message still yields a readable completion notification', async () => {
    await start()
    sw().getTasks.mockResolvedValue({ success: true, data: [] })
    sw().getMessages.mockResolvedValue({ success: true, data: [{ type: 'result', content: '' }] })

    await sendTask('Build', '/tmp/project')
    await vi.advanceTimersByTimeAsync(15000)

    expect(useTerminalStore.getState().swarmNotification).toEqual({
      message: 'Swarm finished',
      type: 'success',
    })
    expect(getConductorState().status).toBe('done')
  })

  it('the stall warning fires exactly once, not on every tick', async () => {
    await start()
    const notifSpy = vi.spyOn(useTerminalStore.getState(), 'setSwarmNotification')
    sw().getTasks.mockResolvedValue({ success: true, data: [] })
    sw().getMessages.mockResolvedValue({
      success: true,
      data: [{ type: 'info', content: 'Conductor analyzing task: Build...' }], // 1 msg => not "has messages"
    })

    await sendTask('Build', '/tmp/project')

    const stalls = (): number => notifSpy.mock.calls.filter(
      ([a]) => a?.message?.includes('not created any tasks'),
    ).length

    await vi.advanceTimersByTimeAsync(75000) // ticks at 15..75s; stall trips past 60s
    expect(stalls()).toBe(1)

    await vi.advanceTimersByTimeAsync(15000) // another tick — must NOT re-warn
    expect(stalls()).toBe(1)
  })

  // ---- revealConductor ----

  it('revealConductor is a no-op when no conductor exists', () => {
    stopConductor()
    useTerminalStore.setState({ activeTerminalId: 'user-term', terminals: [] })

    revealConductor()

    // It must not steal focus or mutate the store when there is nothing to show.
    expect(useTerminalStore.getState().activeTerminalId).toBe('user-term')
  })
})
