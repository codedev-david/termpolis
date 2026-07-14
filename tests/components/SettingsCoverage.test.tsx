// Branch-hardening for the three Settings panes.
//
// SecuritySettings.test.tsx / SettingsPane.test.tsx / MemoryLearningSettings.test.tsx already cover
// the happy paths. This file deliberately drives the arms they never reach: the OFF side of every
// default-ON gate, the bridge-missing and call-rejects paths, the git-hook install edge cases
// (canceled / no error string / a FOREIGN husky hook), the updater state machine, and the memory
// dashboard's InfoTip + 5s poll + unmount race.
//
// Three v1.25.2 invariants are pinned here on purpose, because they are the ones a well-meaning
// refactor would quietly break:
//   1. There is no redaction toggle, and `setRedaction` must never be called. Outbound redaction
//      was deleted — it ate keystrokes and could never work against a TUI agent anyway.
//   2. The rule count on screen comes from the LIVE `ruleCount` off getStatus, never a literal.
//   3. The audit log names WHAT leaked (`DB_PASSWORD`) and never the value.
import React from 'react'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MemoryMetrics } from '../../src/renderer/src/types'

// ---------------------------------------------------------------------------
// Store mock. Unlike SettingsPane.test.tsx's, this one carries a real `terminals`
// array + `activeTerminalId` (so the activeCwd selector's inner .find() actually runs)
// and starts with allowAppMouseControl ON (so the toggle's ON arm renders).
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const state = {
    defaultShell: 'bash',
    setDefaultShell: vi.fn(),
    autocompleteEnabled: true,
    setAutocompleteEnabled: vi.fn(),
    allowAppMouseControl: true,
    setAllowAppMouseControl: vi.fn(),
    terminals: [{ id: 't1', cwd: 'C:/repos/alpha' }] as Array<{ id: string; cwd: string }>,
    activeTerminalId: 't1' as string | null,
    keybindings: {},
    customKeybindings: [] as unknown[],
    setKeybinding: vi.fn(),
    resetKeybindings: vi.fn(),
    addCustomKeybinding: vi.fn(),
    updateCustomKeybinding: vi.fn(),
    removeCustomKeybinding: vi.fn(),
    agentRatingOverrides: {},
    setAgentRatingOverrides: vi.fn(),
    voiceSettings: {
      enabled: false,
      consentAccepted: false,
      groqModel: 'whisper-large-v3-turbo',
      inputDeviceId: '',
      pushToTalkKey: 'Ctrl+Shift+L',
      pushToTalkMode: 'tapOrHold',
      sendKey: 'Space',
      autoSubmitInAgent: false,
      correctionEnabled: true,
      confirmBeforeRunInShell: true,
    },
    setVoiceSettings: vi.fn(),
  }
  return { state }
})

vi.mock('../../src/renderer/src/store/terminalStore', () => ({
  useTerminalStore: Object.assign(
    (selector?: (s: typeof h.state) => unknown) => (selector ? selector(h.state) : h.state),
    { getState: () => h.state, setState: vi.fn() },
  ),
}))

// Monaco needs browser APIs jsdom doesn't have.
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, language }: { value?: string; language?: string }) => (
    <div data-testid="monaco-editor" data-language={language}>{value}</div>
  ),
}))

import { SecuritySettings } from '../../src/renderer/src/components/SettingsPane/SecuritySettings'
import { SettingsPane } from '../../src/renderer/src/components/SettingsPane/SettingsPane'
import { MemoryLearningSettings } from '../../src/renderer/src/components/SettingsPane/MemoryLearningSettings'

// ---------------------------------------------------------------------------
// Bridges
// ---------------------------------------------------------------------------
type Win = typeof window & {
  aiSecurity?: Record<string, unknown>
  termpolis?: Record<string, unknown>
  updater?: Record<string, unknown>
}
const w = window as Win

const FACTS = [
  {
    agentId: 'claude',
    agentName: 'Claude Code',
    trainingOptOut: 'default-off',
    retentionDays: 30,
    privacyDocUrl: 'https://example.invalid/privacy',
    consoleUrl: 'https://example.invalid/console',
    notes: 'Commercial Terms exclude inputs from training.',
  },
]

/** getStatus payload. Everything the component reads, with sane defaults it can override. */
const status = (settings: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    settings: { auditEnabled: false, ...settings },
    facts: FACTS,
    auditPath: '/tmp/audit.jsonl',
    ...extra,
  },
})

function makeAiSecurity(): Record<string, unknown> {
  return {
    getStatus: vi.fn().mockResolvedValue(status()),
    // The bridge no longer ships this. It stays on the MOCK so that if the component ever
    // reaches for redaction again the assertion below fails loudly instead of throwing silently.
    setRedaction: vi.fn().mockResolvedValue({ success: true }),
    setAudit: vi.fn().mockResolvedValue({ success: true }),
    setStrictGemini: vi.fn().mockResolvedValue({ success: true }),
    setCommitShield: vi.fn().mockResolvedValue({ success: true }),
    setEgressGuard: vi.fn().mockResolvedValue({ success: true }),
    setMemoryScrub: vi.fn().mockResolvedValue({ success: true }),
    scan: vi.fn().mockResolvedValue({ success: true, data: { hitCount: 0, hits: [], redacted: '' } }),
    recentAudit: vi.fn().mockResolvedValue({ success: true, data: [] }),
    clearAudit: vi.fn().mockResolvedValue({ success: true }),
    gitHooksList: vi.fn().mockResolvedValue({ success: true, data: [] }),
    gitHooksInstall: vi.fn().mockResolvedValue({ success: true, data: { canceled: false, repo: 'C:/repos/demo' } }),
    gitHooksUninstall: vi.fn().mockResolvedValue({ success: true }),
  }
}

const EMPTY_GRAPH = { success: true, data: { nodes: [], edges: [], totalNodes: 0, totalEdges: 0 } }

function makeTermpolis(): Record<string, unknown> {
  return {
    getAvailableShells: vi.fn().mockResolvedValue({ success: true, data: [{ type: 'bash', label: 'Bash' }] }),
    getHomedir: vi.fn().mockResolvedValue({ success: true, data: '/home/test' }),
    readConfigFile: vi.fn().mockResolvedValue({ success: true, data: '# config' }),
    writeConfigFile: vi.fn().mockResolvedValue({ success: true }),
    setTelemetryOptIn: vi.fn().mockResolvedValue({ success: true }),
    getAppVersion: vi.fn().mockResolvedValue({ success: true, data: { version: '9.9.9' } }),
    memoryGetPrimerLimit: vi.fn().mockResolvedValue({ success: true, data: 10 }),
    memorySetPrimerLimit: vi.fn().mockResolvedValue({ success: true }),
    brainExport: vi.fn().mockResolvedValue({ success: true, data: { canceled: false, path: '/tmp/b.zip', bytes: 2048 } }),
    brainImport: vi.fn().mockResolvedValue({ success: true, data: { canceled: false, memoriesImported: 5, edgesImported: 3 } }),
    codeGraphStats: vi.fn().mockResolvedValue({ success: true, data: { files: 0, symbols: 0, edges: 0 } }),
    codeGraphBuild: vi.fn().mockResolvedValue({ success: true, data: { files: 1, symbols: 2, edges: 3 } }),
    gitFindRoot: vi.fn().mockResolvedValue({ success: true, data: 'C:/repos/alpha' }),
    clipboardReadText: vi.fn().mockResolvedValue({ success: true, data: '' }),
    clipboardWriteText: vi.fn().mockResolvedValue({ success: true }),
    memoryMetrics: vi.fn().mockResolvedValue({ success: true, data: emptyMetrics() }),
    memoryGraphSample: vi.fn().mockResolvedValue(EMPTY_GRAPH),
    groqGetKeyStatus: vi.fn().mockResolvedValue({ success: true, data: { connected: false, hint: '' } }),
  }
}

function makeUpdater(): Record<string, unknown> {
  return {
    check: vi.fn().mockResolvedValue({ success: true }),
    onState: vi.fn(() => () => {}),
    quitAndInstall: vi.fn(),
  }
}

function emptyMetrics(over: Partial<MemoryMetrics> = {}): MemoryMetrics {
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
    ...(over.codeGraph ? { codeGraph: over.codeGraph } : {}),
  }
}

/** A brain with something in it, so the dashboard renders its panels rather than the empty note. */
function fullMetrics(over: Partial<MemoryMetrics> = {}): MemoryMetrics {
  const base = emptyMetrics(over)
  return {
    ...base,
    store: {
      total: 1200, capacity: 500000,
      byType: { episodic: 900, semantic: 300 },
      bySource: { claude: 800, codex: 400 },
      lessons: 42,
      timeline: [{ t: 1, total: 100, lessons: 2 }, { t: 2, total: 1200, lessons: 42 }],
      ...(over.store || {}),
    },
    graph: { nodes: 1200, edges: 3400, byRelation: { 'relates-to': 3400 }, ...(over.graph || {}) },
  }
}

/** Points window.termpolis.memoryMetrics/memoryGraphSample at the given payloads. */
function stubBrain(m: MemoryMetrics | null, graph: unknown = EMPTY_GRAPH): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(m ? { success: true, data: m } : { success: false, error: 'nope' })
  ;(w.termpolis as Record<string, unknown>).memoryMetrics = fn
  ;(w.termpolis as Record<string, unknown>).memoryGraphSample = vi.fn().mockResolvedValue(graph)
  return fn
}

const ai = (): Record<string, ReturnType<typeof vi.fn>> => w.aiSecurity as Record<string, ReturnType<typeof vi.fn>>
const tp = (): Record<string, ReturnType<typeof vi.fn>> => w.termpolis as Record<string, ReturnType<typeof vi.fn>>
const up = (): Record<string, ReturnType<typeof vi.fn>> => w.updater as Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  w.aiSecurity = makeAiSecurity()
  w.termpolis = makeTermpolis()
  w.updater = makeUpdater()
  h.state.allowAppMouseControl = true
  h.state.terminals = [{ id: 't1', cwd: 'C:/repos/alpha' }]
  h.state.activeTerminalId = 't1'
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})

// ===========================================================================
// SecuritySettings — facts, and the LIVE rule count
// ===========================================================================
describe('SecuritySettings — agent facts', () => {
  it('falls back to the "Unknown" badge and "Unknown" retention for an unclassified agent', async () => {
    ai().getStatus.mockResolvedValue(
      status({}, {
        facts: [{
          agentId: 'mystery',
          agentName: 'Mystery Agent',
          trainingOptOut: 'unknown',
          retentionDays: 'unknown',
          privacyDocUrl: 'https://example.invalid/p',
          consoleUrl: 'https://example.invalid/c',
          notes: 'No published terms.',
        }],
      }),
    )
    render(<SecuritySettings />)
    const card = await screen.findByTestId('security-agent-facts')
    // badgeFor() and retentionLabel() both bottom out at "Unknown" rather than inventing a claim.
    expect(within(card).getAllByText('Unknown')).toHaveLength(2)
    expect(within(card).queryByText(/No training/i)).toBeNull()
    expect(within(card).queryByText(/day retention/i)).toBeNull()
  })
})

describe('SecuritySettings — the rule count is live, never a literal', () => {
  it('renders the rule count reported by main, in BOTH the watch card and the Commit Shield card', async () => {
    ai().getStatus.mockResolvedValue(status({}, { ruleCount: 41 }))
    render(<SecuritySettings />)
    const watch = await screen.findByTestId('security-prompt-watch')
    expect(watch.textContent).toMatch(/41-rule engine/)
    expect(watch.textContent).not.toMatch(/97-rule/)
    // The git-boundary card must quote the SAME engine — one number, one source of truth.
    expect(screen.getByText(/block commits & pushes that carry a secret/i).closest('div')!.parentElement!.textContent)
      .toMatch(/41-rule engine/)
  })

  it('falls back to 97 only when main reports no ruleCount at all', async () => {
    render(<SecuritySettings />) // baseline getStatus omits ruleCount
    const watch = await screen.findByTestId('security-prompt-watch')
    expect(watch.textContent).toMatch(/97-rule engine/)
  })

  it('never calls setRedaction, and offers no redaction toggle', async () => {
    render(<SecuritySettings />)
    await screen.findByTestId('security-prompt-watch')
    // Click every switch on the pane — none of them may reach the deleted redaction API.
    fireEvent.click(screen.getByTestId('security-commit-shield-toggle'))
    fireEvent.click(screen.getByTestId('security-egress-guard-toggle'))
    fireEvent.click(screen.getByTestId('security-memory-scrub-toggle'))
    fireEvent.click(screen.getByTestId('security-audit-toggle'))
    await waitFor(() => expect(ai().setAudit).toHaveBeenCalled())
    expect(ai().setRedaction).not.toHaveBeenCalled()
    expect(screen.queryByTestId('security-redaction-toggle')).toBeNull()
  })
})

// ===========================================================================
// SecuritySettings — the three default-ON gates, both directions
// ===========================================================================
const GATES = [
  { name: 'Commit Shield', testid: 'security-commit-shield-toggle', setter: 'setCommitShield', key: 'commitShield' },
  { name: 'Egress Guard', testid: 'security-egress-guard-toggle', setter: 'setEgressGuard', key: 'egressGuard' },
  { name: 'Memory scrub', testid: 'security-memory-scrub-toggle', setter: 'setMemoryScrub', key: 'memoryScrub' },
] as const

describe('SecuritySettings — default-ON gates toggle both ways', () => {
  it.each(GATES)('$name: renders ON by default, and a click turns it OFF', async ({ testid, setter }) => {
    render(<SecuritySettings />)
    const toggle = await screen.findByTestId(testid)
    expect(toggle.className).toMatch(/bg-\[#0d9488\]/) // teal = armed

    fireEvent.click(toggle)

    await waitFor(() => expect(ai()[setter]).toHaveBeenCalledWith(false))
    expect(toggle.className).toMatch(/bg-\[#555\]/) // grey = off
    expect(toggle.className).not.toMatch(/bg-\[#0d9488\]/)
  })

  it.each(GATES)('$name: a persisted OFF value renders OFF, and a click turns it back ON', async ({ testid, setter, key }) => {
    ai().getStatus.mockResolvedValue(status({ [key]: false }))
    render(<SecuritySettings />)
    const toggle = await screen.findByTestId(testid)
    expect(toggle.className).toMatch(/bg-\[#555\]/)

    fireEvent.click(toggle)

    await waitFor(() => expect(ai()[setter]).toHaveBeenCalledWith(true))
    expect(toggle.className).toMatch(/bg-\[#0d9488\]/)
  })

  it.each(GATES)('$name: is inert — and stays visibly ON — when the preload bridge omits its setter', async ({ testid, setter }) => {
    delete (w.aiSecurity as Record<string, unknown>)[setter]
    render(<SecuritySettings />)
    const toggle = await screen.findByTestId(testid)

    fireEvent.click(toggle)
    await Promise.resolve()

    // No optimistic flip: the UI must not claim a gate was disarmed when nothing was told to.
    expect(toggle.className).toMatch(/bg-\[#0d9488\]/)
  })

  it('an absent gate key means "never configured" — the secure default (ON) holds', async () => {
    ai().getStatus.mockResolvedValue(status({ auditEnabled: false })) // no commitShield/egressGuard/memoryScrub keys
    render(<SecuritySettings />)
    for (const g of GATES) {
      expect((await screen.findByTestId(g.testid)).className).toMatch(/bg-\[#0d9488\]/)
    }
  })
})

// ===========================================================================
// SecuritySettings — audit toggle OFF, and the failure replies
// ===========================================================================
describe('SecuritySettings — audit log lifecycle', () => {
  it('turning the audit log OFF stops recording and does NOT re-fetch entries', async () => {
    ai().getStatus.mockResolvedValue(status({ auditEnabled: true }))
    ai().recentAudit.mockResolvedValue({
      success: true,
      data: [{ ts: '2026-07-12T10:00:00.000Z', agent: 'claude', event: 'terminal_open', byteCount: 4 }],
    })
    render(<SecuritySettings />)
    await screen.findByText(/Recent entries/i)
    const fetchesWhileOn = ai().recentAudit.mock.calls.length
    expect(fetchesWhileOn).toBeGreaterThan(0)

    fireEvent.click(screen.getByTestId('security-audit-toggle'))

    await waitFor(() => expect(ai().setAudit).toHaveBeenCalledWith(false))
    // Switching OFF must not pull a fresh page of a log we just stopped writing.
    expect(ai().recentAudit.mock.calls.length).toBe(fetchesWhileOn)
    expect(screen.queryByText(/Recent entries/i)).toBeNull()
    expect(screen.getByTestId('security-secrets-sent-count').textContent).toMatch(/audit log off/i)
  })

  it('asks for 500 entries but renders only the newest 50', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      ts: `2026-07-12T10:${String(i).padStart(2, '0')}:00.000Z`,
      agent: 'claude',
      event: 'terminal_open',
      byteCount: i,
    }))
    ai().getStatus.mockResolvedValue(status({ auditEnabled: true }))
    ai().recentAudit.mockResolvedValue({ success: true, data: rows })
    render(<SecuritySettings />)

    // The "secrets sent" number is read as a fact about the machine, so the window is deliberately
    // wide (500) even though the inline table paints only RECENT_ROWS of it.
    await waitFor(() => expect(ai().recentAudit).toHaveBeenCalledWith(500))
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(50)
  })

  it('a failed getStatus leaves the pane usable rather than stuck on the spinner', async () => {
    ai().getStatus.mockResolvedValue({ success: false })
    render(<SecuritySettings />)
    await waitFor(() => expect(screen.queryByText(/Loading security status/i)).toBeNull())
    expect(screen.getByTestId('security-settings')).toBeInTheDocument()
    expect(screen.getByTestId('security-agent-facts').children).toHaveLength(0)
    expect(screen.queryByTestId('gemini-account-status')).toBeNull()
  })

  it('a failed recentAudit reply leaves the table empty rather than half-populated', async () => {
    ai().getStatus.mockResolvedValue(status({ auditEnabled: true }))
    ai().recentAudit.mockResolvedValue({ success: false })
    render(<SecuritySettings />)
    await screen.findByText(/Recent entries/i)
    expect(screen.getByText(/No entries yet/i)).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('a failed gitHooksList shows no repositories rather than a phantom one', async () => {
    ai().gitHooksList.mockResolvedValue({ success: false })
    render(<SecuritySettings />)
    await screen.findByTestId('security-git-hooks')
    expect(screen.queryByTestId('security-hook-list')).toBeNull()
  })
})

// ===========================================================================
// SecuritySettings — no bridge, and a bridge that vanishes mid-session
// ===========================================================================
describe('SecuritySettings — missing preload bridge', () => {
  it('renders the whole pane and every control is a safe no-op when window.aiSecurity is absent', async () => {
    w.aiSecurity = undefined
    render(<SecuritySettings />)

    // Not stuck on the spinner — the pane still explains the product with no IPC at all.
    const pane = await screen.findByTestId('security-settings')
    expect(pane).toBeInTheDocument()

    const strict = screen.getByTestId('security-strict-gemini-toggle')
    const shield = screen.getByTestId('security-commit-shield-toggle')
    fireEvent.click(screen.getByTestId('security-audit-toggle'))
    fireEvent.click(strict)
    fireEvent.click(shield)
    fireEvent.click(screen.getByTestId('security-egress-guard-toggle'))
    fireEvent.click(screen.getByTestId('security-memory-scrub-toggle'))
    fireEvent.click(screen.getByTestId('security-protect-repo'))
    fireEvent.click(screen.getByText('Scan clipboard'))
    fireEvent.change(screen.getByPlaceholderText(/Paste the prompt/), { target: { value: 'AKIA' + 'A'.repeat(16) } })
    fireEvent.click(screen.getByTestId('security-scan-btn'))
    await act(async () => { await Promise.resolve() })

    // Nothing flipped, nothing was scanned, and the clipboard was never even read.
    expect(strict.className).toMatch(/bg-\[#555\]/)
    expect(shield.className).toMatch(/bg-\[#0d9488\]/)
    expect(screen.queryByTestId('security-hook-msg')).toBeNull()
    expect(screen.queryByText(/secrets? detected/i)).toBeNull()
    expect(tp().clipboardReadText).not.toHaveBeenCalled()
  })

  it('Refresh and Clear log go quiet if the bridge disappears after mount', async () => {
    ai().getStatus.mockResolvedValue(status({ auditEnabled: true }))
    const before = ai()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { rerender } = render(<SecuritySettings />)
    await screen.findByText(/Recent entries/i)
    const fetches = before.recentAudit.mock.calls.length

    // The preload context is gone (a renderer reload can do this). The handlers must notice.
    w.aiSecurity = undefined
    rerender(<SecuritySettings />)

    fireEvent.click(screen.getByText('Refresh'))
    fireEvent.click(screen.getByText(/Clear log/i))
    await act(async () => { await Promise.resolve() })

    expect(before.recentAudit.mock.calls.length).toBe(fetches)
    expect(before.clearAudit).not.toHaveBeenCalled()
    // wipeAudit bails BEFORE prompting — no scary "permanently delete?" dialog we can't honour.
    expect(confirmSpy).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// SecuritySettings — git hooks: the flows that are NOT the happy path
// ===========================================================================
describe('SecuritySettings — git hook install edge cases', () => {
  it('a canceled folder picker says nothing and re-fetches nothing', async () => {
    ai().gitHooksInstall.mockResolvedValue({ success: true, data: { canceled: true } })
    render(<SecuritySettings />)
    await waitFor(() => expect(ai().gitHooksList).toHaveBeenCalled())
    const listCalls = ai().gitHooksList.mock.calls.length

    fireEvent.click(screen.getByTestId('security-protect-repo'))

    await waitFor(() => expect(ai().gitHooksInstall).toHaveBeenCalled())
    expect(screen.queryByTestId('security-hook-msg')).toBeNull()
    expect(ai().gitHooksList.mock.calls.length).toBe(listCalls)
    // and the button is released again, not stuck on "Installing…"
    expect(screen.getByTestId('security-protect-repo')).toHaveTextContent('Protect a repository…')
  })

  it('a failure with no error string still says something actionable', async () => {
    ai().gitHooksInstall.mockResolvedValue({ success: false }) // main gave us nothing to quote
    render(<SecuritySettings />)
    fireEvent.click(await screen.findByTestId('security-protect-repo'))
    await waitFor(() =>
      expect(screen.getByTestId('security-hook-msg')).toHaveTextContent('Could not install the hooks'),
    )
  })

  it('a success with no repo path degrades to the generic word rather than "undefined"', async () => {
    ai().gitHooksInstall.mockResolvedValue({ success: true, data: { canceled: false } })
    render(<SecuritySettings />)
    fireEvent.click(await screen.findByTestId('security-protect-repo'))
    await waitFor(() => {
      const msg = screen.getByTestId('security-hook-msg').textContent || ''
      expect(msg).toMatch(/^Protected repository —/)
      expect(msg).not.toMatch(/undefined/)
    })
  })

  it('disables the button while the install is in flight, so you cannot double-install', async () => {
    let finish: (v: unknown) => void = () => {}
    ai().gitHooksInstall.mockReturnValue(new Promise((r) => { finish = r }))
    render(<SecuritySettings />)
    const btn = await screen.findByTestId('security-protect-repo')

    fireEvent.click(btn)
    await waitFor(() => expect(btn).toHaveTextContent('Installing…'))
    expect(btn).toBeDisabled()

    await act(async () => { finish({ success: true, data: { canceled: false, repo: 'C:/repos/demo' } }) })
    await waitFor(() => expect(btn).not.toBeDisabled())
    expect(btn).toHaveTextContent('Protect a repository…')
  })

  it('protect is a no-op when the bridge predates git hooks', async () => {
    delete (w.aiSecurity as Record<string, unknown>).gitHooksInstall
    render(<SecuritySettings />)
    fireEvent.click(await screen.findByTestId('security-protect-repo'))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId('security-hook-msg')).toBeNull()
  })
})

describe('SecuritySettings — a repo is only "armed" when OUR pre-commit hook is really there', () => {
  it('does not claim protection for a foreign (husky) hook or an unreadable repo', async () => {
    ai().gitHooksList.mockResolvedValue({
      success: true,
      data: [
        // Someone else's hook is sitting there. We chain rather than clobber — but until we have
        // actually installed, saying "armed" would be a lie the user acts on.
        { repo: 'C:/repos/husky-user', status: { 'pre-commit': 'foreign', 'pre-push': 'absent' } },
        { repo: 'C:/repos/unreadable', status: null },
      ],
    })
    render(<SecuritySettings />)
    const list = await screen.findByTestId('security-hook-list')

    expect(within(list).getAllByText('not installed')).toHaveLength(2)
    expect(within(list).queryByText('armed')).toBeNull()
    expect(list.textContent).toContain('C:/repos/husky-user')
    expect(list.textContent).toContain('C:/repos/unreadable')
  })

  it('Remove is a no-op when the bridge cannot uninstall', async () => {
    ai().gitHooksList.mockResolvedValue({
      success: true,
      data: [{ repo: 'C:/repos/demo', status: { 'pre-commit': 'installed' } }],
    })
    delete (w.aiSecurity as Record<string, unknown>).gitHooksUninstall
    render(<SecuritySettings />)
    const list = await screen.findByTestId('security-hook-list')
    expect(within(list).getByText('armed')).toBeInTheDocument()
    const listCalls = ai().gitHooksList.mock.calls.length

    fireEvent.click(within(list).getByText('Remove'))
    await act(async () => { await Promise.resolve() })

    // Nothing was uninstalled, so the list must not be re-read (and the repo stays listed).
    expect(ai().gitHooksList.mock.calls.length).toBe(listCalls)
    expect(screen.getByTestId('security-hook-list').textContent).toContain('C:/repos/demo')
  })

  it('Remove uninstalls the hooks and re-reads the list', async () => {
    ai().gitHooksList.mockResolvedValue({
      success: true,
      data: [{ repo: 'C:/repos/demo', status: { 'pre-commit': 'installed' } }],
    })
    render(<SecuritySettings />)
    const list = await screen.findByTestId('security-hook-list')
    const listCalls = ai().gitHooksList.mock.calls.length

    fireEvent.click(within(list).getByText('Remove'))

    await waitFor(() => expect(ai().gitHooksUninstall).toHaveBeenCalledWith('C:/repos/demo'))
    await waitFor(() => expect(ai().gitHooksList.mock.calls.length).toBeGreaterThan(listCalls))
  })
})

// ===========================================================================
// SecuritySettings — manual scanner, and the modal's coverage wiring
// ===========================================================================
describe('SecuritySettings — manual scanner', () => {
  it('pluralises the hit count (2 secrets, not "2 secret")', async () => {
    ai().scan.mockResolvedValue({
      success: true,
      data: {
        hitCount: 2,
        hits: [
          { rule: 'env_secret', label: '.env-style assignment', sample: 'DB_P…2', name: 'DB_PASSWORD' },
          { rule: 'json_secret', label: 'JSON secret', sample: 'ap…9' },
        ],
        redacted: '[REDACTED:env_secret] [REDACTED:json_secret]',
      },
    })
    render(<SecuritySettings />)
    fireEvent.change(await screen.findByPlaceholderText(/Paste the prompt/), { target: { value: 'two of them' } })
    fireEvent.click(screen.getByTestId('security-scan-btn'))

    expect(await screen.findByText('2 secrets detected')).toBeInTheDocument()
    // A hit with no captured identifier still renders its label — it just has no name to rotate.
    expect(screen.getByText('JSON secret')).toBeInTheDocument()
    expect(screen.getByText('DB_PASSWORD')).toBeInTheDocument()
  })

  // A scan that FAILED is not a scan that came back clean. Printing the green "No secrets detected"
  // for a broken IPC call would be the single most dangerous thing this pane could do.
  it('says nothing at all when the scan itself fails — never a reassuring "No secrets detected"', async () => {
    ai().scan.mockResolvedValue({ success: false })
    render(<SecuritySettings />)
    fireEvent.change(await screen.findByPlaceholderText(/Paste the prompt/), { target: { value: 'DB_PASSWORD=' + 'a'.repeat(20) } })
    fireEvent.click(screen.getByTestId('security-scan-btn'))

    await waitFor(() => expect(ai().scan).toHaveBeenCalled())
    expect(screen.queryByText(/No secrets detected/i)).toBeNull()
    expect(screen.queryByText(/secrets? detected/i)).toBeNull()
  })

  it('says nothing when a clipboard scan fails, either', async () => {
    tp().clipboardReadText.mockResolvedValue({ success: true, data: 'DB_PASSWORD=' + 'a'.repeat(20) })
    ai().scan.mockResolvedValue({ success: false })
    render(<SecuritySettings />)
    await screen.findByPlaceholderText(/Paste the prompt/)

    fireEvent.click(screen.getByText('Scan clipboard'))

    // The clipboard text still lands in the box (so you can retry) but no verdict is invented.
    await waitFor(() => expect(ai().scan).toHaveBeenCalledWith('DB_PASSWORD=' + 'a'.repeat(20)))
    expect(screen.queryByText(/secrets? detected/i)).toBeNull()
  })
})

describe('SecuritySettings — the audit modal reflects the LIVE gate states', () => {
  it('a gate turned off in the pane reads OFF in the modal, and the modal closes again', async () => {
    render(<SecuritySettings />)
    fireEvent.click(await screen.findByTestId('security-commit-shield-toggle'))
    await waitFor(() => expect(ai().setCommitShield).toHaveBeenCalledWith(false))

    fireEvent.click(screen.getByTestId('security-open-audit'))

    const coverage = await screen.findByTestId('audit-coverage')
    expect(coverage.textContent).toMatch(/Commit Shield: OFF/)
    expect(coverage.textContent).toMatch(/Egress Guard: on/)
    expect(coverage.textContent).toMatch(/Memory scrub: on/)

    fireEvent.click(screen.getByTestId('audit-close'))
    await waitFor(() => expect(screen.queryByTestId('audit-log-modal')).toBeNull())
  })

  it('names the leaked identifier and never the value', async () => {
    const SECRET_VALUE = 'hunter2-never-render-me'
    ai().getStatus.mockResolvedValue(status({ auditEnabled: true }))
    ai().recentAudit.mockResolvedValue({
      success: true,
      data: [{
        ts: '2026-07-12T10:00:00.000Z',
        agent: 'claude',
        event: 'prompt_secret_sent',
        hitCount: 1,
        notes: 'DB_PASSWORD (env_secret)', // main records the NAME + the rule. Never the value.
      }],
    })
    render(<SecuritySettings />)
    fireEvent.click(await screen.findByTestId('security-open-audit'))

    const names = await screen.findByTestId('audit-secret-names')
    expect(names.textContent).toMatch(/DB_PASSWORD/)
    expect(document.body.textContent).not.toContain(SECRET_VALUE)
  })
})

// ===========================================================================
// SettingsPane — brain import/export edge cases
// ===========================================================================
describe('SettingsPane — brain import/export', () => {
  it('reports 0 KB rather than NaN when main omits the byte count', async () => {
    tp().brainExport.mockResolvedValue({ success: true, data: { canceled: false, path: '/tmp/b.zip' } })
    render(<SettingsPane />)
    fireEvent.click(screen.getByTestId('brain-export-btn'))
    await waitFor(() => expect(screen.getByTestId('brain-io-status')).toHaveTextContent('Exported 0 KB → /tmp/b.zip'))
  })

  it('surfaces a thrown export (the bridge itself blew up), not just a failed one', async () => {
    tp().brainExport.mockRejectedValue(new Error('EACCES /tmp/b.zip'))
    render(<SettingsPane />)
    fireEvent.click(screen.getByTestId('brain-export-btn'))
    await waitFor(() => expect(screen.getByTestId('brain-io-status')).toHaveTextContent('Export failed: EACCES /tmp/b.zip'))
    // and the buttons are released again — a thrown export must not wedge the pane
    expect(screen.getByTestId('brain-export-btn')).not.toBeDisabled()
    expect(screen.getByTestId('brain-import-btn')).not.toBeDisabled()
  })

  it('a canceled import clears the "Importing…" status instead of leaving it hanging', async () => {
    tp().brainImport.mockResolvedValue({ success: true, data: { canceled: true } })
    render(<SettingsPane />)
    fireEvent.click(screen.getByTestId('brain-import-btn'))
    await waitFor(() => expect(tp().brainImport).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId('brain-io-status')).toBeNull())
  })

  it('surfaces a rejected import (success:false), not just a thrown one', async () => {
    tp().brainImport.mockResolvedValue({ success: false, error: 'archive checksum mismatch' })
    render(<SettingsPane />)
    fireEvent.click(screen.getByTestId('brain-import-btn'))
    await waitFor(() =>
      expect(screen.getByTestId('brain-io-status')).toHaveTextContent('Import failed: archive checksum mismatch'),
    )
  })

  it('reports 0/0 when an import succeeds but merged nothing new', async () => {
    tp().brainImport.mockResolvedValue({ success: true, data: { canceled: false } })
    render(<SettingsPane />)
    fireEvent.click(screen.getByTestId('brain-import-btn'))
    await waitFor(() =>
      expect(screen.getByTestId('brain-io-status')).toHaveTextContent('Imported 0 memories and 0 graph edges.'),
    )
  })
})

// ===========================================================================
// SettingsPane — the updater state machine
// ===========================================================================
describe('SettingsPane — updater', () => {
  it('says so plainly when there is no updater in this build', async () => {
    w.updater = undefined
    render(<SettingsPane />)
    fireEvent.click(screen.getByTestId('settings-check-updates'))
    await waitFor(() =>
      expect(screen.getByTestId('settings-update-status')).toHaveTextContent('Updater unavailable in this build (dev mode?).'),
    )
  })

  it('falls back to "unknown error" when the check fails without a reason', async () => {
    up().check.mockResolvedValue({ success: false })
    render(<SettingsPane />)
    fireEvent.click(screen.getByTestId('settings-check-updates'))
    await waitFor(() => expect(screen.getByTestId('settings-update-status')).toHaveTextContent('Failed: unknown error'))
  })

  it('surfaces a thrown Error by its message', async () => {
    up().check.mockRejectedValue(new Error('ENOTFOUND github.com'))
    render(<SettingsPane />)
    fireEvent.click(screen.getByTestId('settings-check-updates'))
    await waitFor(() => expect(screen.getByTestId('settings-update-status')).toHaveTextContent('Failed: ENOTFOUND github.com'))
  })

  it('stringifies a thrown non-Error rather than printing "Failed: undefined"', async () => {
    up().check.mockRejectedValue('ipc channel closed') // a bare string escaped the main process
    render(<SettingsPane />)
    fireEvent.click(screen.getByTestId('settings-check-updates'))
    await waitFor(() => expect(screen.getByTestId('settings-update-status')).toHaveTextContent('Failed: ipc channel closed'))
    expect(screen.getByTestId('settings-update-status').textContent).not.toMatch(/undefined/)
  })

  it('re-enables the button after a failed check', async () => {
    up().check.mockRejectedValue(new Error('offline'))
    render(<SettingsPane />)
    const btn = screen.getByTestId('settings-check-updates')
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByTestId('settings-update-status')).toHaveTextContent('Failed: offline'))
    expect(btn).not.toBeDisabled()
  })

  it('renders each state the updater can push, and ignores a null one', async () => {
    let cb: (s: unknown) => void = () => {}
    up().onState.mockImplementation((fn: (s: unknown) => void) => { cb = fn; return () => {} })
    render(<SettingsPane />)

    // A null payload must not blank or corrupt the status line.
    act(() => cb(null))
    expect(screen.queryByTestId('settings-update-status')).toBeNull()

    act(() => cb({ status: 'checking' }))
    expect(screen.getByTestId('settings-update-status')).toHaveTextContent('Checking…')

    act(() => cb({ status: 'available', version: '1.2.3' }))
    expect(screen.getByTestId('settings-update-status')).toHaveTextContent('Update available (v1.2.3) — downloading…')

    act(() => cb({ status: 'available' })) // main did not tell us the version
    expect(screen.getByTestId('settings-update-status')).toHaveTextContent('Update available — downloading…')

    act(() => cb({ status: 'downloading', version: '1.2.3' }))
    expect(screen.getByTestId('settings-update-status')).toHaveTextContent('Downloading update v1.2.3…')

    act(() => cb({ status: 'downloading' }))
    expect(screen.getByTestId('settings-update-status')).toHaveTextContent('Downloading update…')

    act(() => cb({ status: 'error', error: 'signature mismatch' }))
    expect(screen.getByTestId('settings-update-status')).toHaveTextContent('Update error: signature mismatch')

    act(() => cb({ status: 'error' }))
    expect(screen.getByTestId('settings-update-status')).toHaveTextContent('Update error: unknown')
  })

  it('does not subscribe when the updater cannot report state', async () => {
    delete (w.updater as Record<string, unknown>).onState
    render(<SettingsPane />)
    // Renders, and the mount effect returns before wiring a listener it cannot wire.
    await waitFor(() => expect(screen.getByTestId('settings-app-version')).toHaveTextContent('v9.9.9'))
  })

  it('hides the version badge when getAppVersion rejects', async () => {
    tp().getAppVersion.mockRejectedValue(new Error('no ipc'))
    render(<SettingsPane />)
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument())
    expect(screen.queryByTestId('settings-app-version')).toBeNull()
  })

  it('hides the version badge when getAppVersion replies with a failure', async () => {
    tp().getAppVersion.mockResolvedValue({ success: false })
    render(<SettingsPane />)
    await waitFor(() => expect(tp().getAppVersion).toHaveBeenCalled())
    expect(screen.queryByTestId('settings-app-version')).toBeNull()
  })
})

describe('SettingsPane — primer size', () => {
  it('keeps the default of 10 when main hands back something that is not a number', async () => {
    tp().memoryGetPrimerLimit.mockResolvedValue({ success: true, data: null })
    render(<SettingsPane />)
    const input = await screen.findByTestId('settings-primer-limit') as HTMLInputElement
    await waitFor(() => expect(tp().memoryGetPrimerLimit).toHaveBeenCalled())
    expect(input.value).toBe('10')
  })
})

// ===========================================================================
// SettingsPane — terminal defaults stepper + mouse toggle ON arm
// ===========================================================================
describe('SettingsPane — terminal defaults stepper', () => {
  const saved = (): { fontSize: number } => JSON.parse(localStorage.getItem('termpolis.terminal.defaults') || '{}')

  it('the − and + buttons step the default font size and persist it', () => {
    render(<SettingsPane />)
    const box = screen.getByTestId('settings-terminal-defaults')
    const input = screen.getByTestId('settings-default-font-size') as HTMLInputElement
    const start = Number(input.value)

    fireEvent.click(within(box).getByText('+'))
    expect(saved().fontSize).toBe(start + 1)

    fireEvent.click(within(box).getByText('−'))
    expect(saved().fontSize).toBe(start)
  })

  it('clamps at the 8..32 bounds instead of stepping past them', () => {
    render(<SettingsPane />)
    const box = screen.getByTestId('settings-terminal-defaults')
    const input = screen.getByTestId('settings-default-font-size')

    fireEvent.change(input, { target: { value: '8' } })
    fireEvent.click(within(box).getByText('−'))
    expect(saved().fontSize).toBe(8)

    fireEvent.change(input, { target: { value: '32' } })
    fireEvent.click(within(box).getByText('+'))
    expect(saved().fontSize).toBe(32)
  })
})

describe('SettingsPane — app mouse control', () => {
  it('renders ON when the store says apps may capture the mouse, and a click turns it off', () => {
    h.state.allowAppMouseControl = true
    render(<SettingsPane />)
    const toggle = screen.getByLabelText('Toggle whether terminal apps may capture the mouse')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle.className).toMatch(/bg-\[#0078d4\]/)

    fireEvent.click(toggle)

    expect(h.state.setAllowAppMouseControl).toHaveBeenCalledWith(false)
  })
})

// ===========================================================================
// SettingsPane — the active terminal's cwd reaches the code graph
// ===========================================================================
describe('SettingsPane — active terminal cwd', () => {
  it('hands the active terminal\'s cwd to the Code Graph panel', async () => {
    h.state.terminals = [{ id: 't0', cwd: 'C:/repos/other' }, { id: 't1', cwd: 'C:/repos/alpha' }]
    h.state.activeTerminalId = 't1'
    render(<SettingsPane />)

    fireEvent.click(screen.getByTestId('code-graph-rebuild'))

    await waitFor(() => expect(tp().gitFindRoot).toHaveBeenCalledWith('C:/repos/alpha'))
  })

  it('falls back to an empty cwd when no terminal matches the active id', async () => {
    h.state.terminals = [{ id: 't0', cwd: 'C:/repos/other' }]
    h.state.activeTerminalId = 'gone'
    render(<SettingsPane />)

    fireEvent.click(screen.getByTestId('code-graph-rebuild'))

    await waitFor(() =>
      expect(screen.getByTestId('code-graph-status')).toHaveTextContent('Open a terminal in a git repo'),
    )
    expect(tp().gitFindRoot).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// SettingsPane — tabs
// ===========================================================================
describe('SettingsPane — tab switching', () => {
  it('shows exactly one panel at a time across all seven tabs', async () => {
    render(<SettingsPane />)

    // general (default)
    expect(screen.getByText('Default Shell')).toBeInTheDocument()
    expect(screen.queryByTestId('security-settings')).toBeNull()

    fireEvent.click(screen.getByTestId('settings-tab-memory'))
    expect(await screen.findByTestId('memory-learning-settings')).toBeInTheDocument()
    expect(screen.queryByText('Default Shell')).toBeNull()

    fireEvent.click(screen.getByTestId('settings-tab-security'))
    expect(await screen.findByTestId('security-settings')).toBeInTheDocument()
    expect(screen.queryByTestId('memory-learning-settings')).toBeNull()

    fireEvent.click(screen.getByTestId('settings-tab-voice'))
    expect(await screen.findByTestId('voice-settings')).toBeInTheDocument()
    expect(screen.queryByTestId('security-settings')).toBeNull()

    fireEvent.click(screen.getByTestId('settings-tab-keybindings'))
    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument()
    expect(screen.queryByTestId('voice-settings')).toBeNull()

    fireEvent.click(screen.getByTestId('settings-tab-agents'))
    expect(screen.getByText('Agent Capability Ratings')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('settings-tab-shell'))
    expect(await screen.findByText('Shell Config Files')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('settings-tab-general'))
    expect(screen.getByText('Default Shell')).toBeInTheDocument()
    expect(screen.queryByText('Shell Config Files')).toBeNull()
  })

  it('underlines only the active tab', () => {
    render(<SettingsPane />)
    fireEvent.click(screen.getByTestId('settings-tab-voice'))
    expect(screen.getByTestId('settings-tab-voice').className).toMatch(/border-\[#0078d4\]/)
    expect(screen.getByTestId('settings-tab-general').className).toMatch(/border-transparent/)
  })
})

// ===========================================================================
// SettingsPane — shell config save
// ===========================================================================
describe('SettingsPane — shell config save', () => {
  it('clears the "✓ Saved" flash after 2s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<SettingsPane />)
    fireEvent.click(screen.getByTestId('settings-tab-shell'))
    const btn = await screen.findByText('Save')

    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByText('✓ Saved')).toBeInTheDocument())

    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })

    expect(screen.getByText('Save')).toBeInTheDocument()
    expect(screen.queryByText('✓ Saved')).toBeNull()
    vi.useRealTimers()
  })

  // NOTE: this pins CURRENT behaviour, and that behaviour is a bug — see the report.
  // activeFile is set from getHomedir while the file contents are still loading, so a Save
  // that lands first writes '' over the user's real .bashrc.
  it('writes an empty string when Save runs before the file has finished loading', async () => {
    tp().readConfigFile.mockReturnValue(new Promise(() => {})) // never resolves
    render(<SettingsPane />)
    fireEvent.click(screen.getByTestId('settings-tab-shell'))
    const btn = await screen.findByText('Save')

    fireEvent.click(btn)

    await waitFor(() => expect(tp().writeConfigFile).toHaveBeenCalledWith('/home/test/.bashrc', ''))
  })
})

// ===========================================================================
// MemoryLearningSettings — the InfoTip affordance
// ===========================================================================
describe('MemoryLearningSettings — InfoTip', () => {
  beforeEach(() => { stubBrain(fullMetrics()) })

  const tipIn = async (panel: string): Promise<HTMLElement> =>
    within(await screen.findByTestId(panel)).getByRole('button', { name: 'What this means' })

  it('reveals the explanation on hover and hides it again on leave', async () => {
    render(<MemoryLearningSettings />)
    const btn = await tipIn('ml-bytype')
    expect(screen.queryByRole('tooltip')).toBeNull()

    fireEvent.mouseEnter(btn)
    expect(screen.getByRole('tooltip').textContent).toMatch(/Five memory types/i)

    fireEvent.mouseLeave(btn)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('reveals it on keyboard focus and hides it on blur (not mouse-only)', async () => {
    render(<MemoryLearningSettings />)
    const btn = await tipIn('ml-connections')

    fireEvent.focus(btn)
    expect(screen.getByRole('tooltip').textContent).toMatch(/Each node is a memory/i)

    fireEvent.blur(btn)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('click toggles it open then closed, and does not bubble to the panel', async () => {
    const onPanelClick = vi.fn()
    render(<div onClick={onPanelClick}><MemoryLearningSettings /></div>)
    const btn = await tipIn('ml-competence')

    fireEvent.click(btn)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.click(btn)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(onPanelClick).not.toHaveBeenCalled() // stopPropagation, so a click never reaches a parent handler
  })

  it('anchors a right-hand panel\'s tooltip to the right edge so it cannot run off-screen', async () => {
    render(<MemoryLearningSettings />)

    fireEvent.mouseEnter(await tipIn('ml-bysource')) // infoAlign="right"
    expect(screen.getByRole('tooltip').className).toMatch(/right-0/)
    expect(screen.getByRole('tooltip').className).not.toMatch(/left-0/)

    fireEvent.mouseLeave(await tipIn('ml-bysource'))
    fireEvent.mouseEnter(await tipIn('ml-bytype')) // default left
    expect(screen.getByRole('tooltip').className).toMatch(/left-0/)
  })
})

// ===========================================================================
// MemoryLearningSettings — load failures, the poll, and the unmount race
// ===========================================================================
describe('MemoryLearningSettings — metrics loading', () => {
  it('uses a generic message when main fails without saying why', async () => {
    ;(w.termpolis as Record<string, unknown>).memoryMetrics = vi.fn().mockResolvedValue({ success: false })
    ;(w.termpolis as Record<string, unknown>).memoryGraphSample = vi.fn().mockResolvedValue(EMPTY_GRAPH)
    render(<MemoryLearningSettings />)
    expect(await screen.findByTestId('ml-error')).toHaveTextContent('Could not read memory metrics')
  })

  it('surfaces a thrown error by its message', async () => {
    ;(w.termpolis as Record<string, unknown>).memoryMetrics = vi.fn().mockRejectedValue(new Error('brain locked'))
    ;(w.termpolis as Record<string, unknown>).memoryGraphSample = vi.fn().mockResolvedValue(EMPTY_GRAPH)
    render(<MemoryLearningSettings />)
    expect(await screen.findByTestId('ml-error')).toHaveTextContent('brain locked')
  })

  it('falls back to the generic message when the throw carries no message', async () => {
    ;(w.termpolis as Record<string, unknown>).memoryMetrics = vi.fn().mockRejectedValue(new Error(''))
    ;(w.termpolis as Record<string, unknown>).memoryGraphSample = vi.fn().mockResolvedValue(EMPTY_GRAPH)
    render(<MemoryLearningSettings />)
    expect(await screen.findByTestId('ml-error')).toHaveTextContent('Could not read memory metrics')
  })

  it('keeps the rest of the dashboard when only the graph sample fails', async () => {
    stubBrain(fullMetrics())
    ;(w.termpolis as Record<string, unknown>).memoryGraphSample = vi.fn().mockRejectedValue(new Error('graph down'))
    render(<MemoryLearningSettings />)

    // The graph is best-effort: it degrades to a placeholder, it does not take the pane down.
    expect(await screen.findByTestId('ml-graph-loading')).toHaveTextContent('Building the graph')
    expect(screen.getByTestId('ml-receipts')).toBeInTheDocument()
    expect(screen.queryByTestId('ml-error')).toBeNull()
  })

  // v1.25.16: this used to poll every 5 s. `memory:metrics` scans EVERY entry in the store (running
  // content regexes over each), copies the whole edge set and re-aggregates the event ledger — on
  // the main process, which is the same thread that echoes your keystrokes into the PTY. A read that
  // expensive must be tied to a user asking for it, never to a clock. It loads on open and on
  // Refresh; if a timer ever creeps back in, this test is what catches it.
  it('NEVER polls the brain on a timer — the read is far too expensive to be on a clock', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fn = stubBrain(fullMetrics())
    render(<MemoryLearningSettings />)
    await screen.findByTestId('ml-receipts')
    const afterMount = fn.mock.calls.length
    expect(afterMount).toBe(1) // loaded once, because the tab was opened

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) }) // a full minute of nothing

    expect(fn.mock.calls.length).toBe(afterMount) // ...and it never fired again
    vi.useRealTimers()
  })

  it('stops polling on unmount and swallows a metrics reply that lands after it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let settle: (v: unknown) => void = () => {}
    const fn = vi.fn().mockReturnValue(new Promise((r) => { settle = r }))
    ;(w.termpolis as Record<string, unknown>).memoryMetrics = fn
    ;(w.termpolis as Record<string, unknown>).memoryGraphSample = vi.fn().mockResolvedValue(EMPTY_GRAPH)

    const { container, unmount } = render(<MemoryLearningSettings />)
    expect(fn).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => { settle({ success: true, data: fullMetrics() }) })

    // The `mounted` guard means the late reply renders nothing…
    expect(container).toBeEmptyDOMElement()
    // …and the 5s interval was cleared, so the brain is not polled forever after the pane closes.
    await act(async () => { await vi.advanceTimersByTimeAsync(20000) })
    expect(fn).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('swallows a metrics FAILURE that lands after unmount too', async () => {
    let fail: (e: unknown) => void = () => {}
    const fn = vi.fn().mockReturnValue(new Promise((_r, rej) => { fail = rej }))
    ;(w.termpolis as Record<string, unknown>).memoryMetrics = fn
    ;(w.termpolis as Record<string, unknown>).memoryGraphSample = vi.fn().mockResolvedValue(EMPTY_GRAPH)

    const { container, unmount } = render(<MemoryLearningSettings />)
    unmount()

    // The catch runs on a component that no longer exists — the mounted guard must hold there too,
    // not just on the success path, or a slow failing IPC call sets state after teardown.
    await act(async () => { fail(new Error('brain locked')) })

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('ml-error')).toBeNull()
  })
})

// ===========================================================================
// MemoryLearningSettings — the data-driven render arms
// ===========================================================================
describe('MemoryLearningSettings — receipt tiles', () => {
  it('adds a fifth "Code connections" tile once a repo has structural edges', async () => {
    stubBrain(fullMetrics({ codeGraph: { files: 120, symbols: 3400, edges: 12800 } } as Partial<MemoryMetrics>))
    render(<MemoryLearningSettings />)
    const receipts = await screen.findByTestId('ml-receipts')

    expect(within(receipts).getByText('Code connections')).toBeInTheDocument()
    expect(within(receipts).getByText('12.8k')).toBeInTheDocument()
    expect(within(receipts).getByText(/3.4k symbols · 120 files indexed/)).toBeInTheDocument()
    expect(receipts.className).toMatch(/md:grid-cols-5/)
  })

  it('shows no code tile at all — not a fake 0 — when nothing is indexed yet', async () => {
    stubBrain(fullMetrics({ codeGraph: { files: 3, symbols: 10, edges: 0 } } as Partial<MemoryMetrics>))
    render(<MemoryLearningSettings />)
    const receipts = await screen.findByTestId('ml-receipts')

    expect(within(receipts).queryByText('Code connections')).toBeNull()
    expect(receipts.className).toMatch(/md:grid-cols-4/)
  })
})

describe('MemoryLearningSettings — competence and receipts', () => {
  it('renders a graded bar per domain once there is a track record', async () => {
    stubBrain(fullMetrics({
      competence: [
        { domain: 'testing', attempts: 12, confidence: 0.91 },
        { domain: 'refactor', attempts: 3, confidence: 0.42 },
      ],
    }))
    render(<MemoryLearningSettings />)
    const panel = await screen.findByTestId('ml-competence')

    expect(within(panel).queryByText(/No track record yet/i)).toBeNull()
    expect(within(panel).getByText('testing (12)')).toBeInTheDocument()
    expect(within(panel).getByText('91')).toBeInTheDocument() // Wilson lower bound, as a percent
    expect(within(panel).getByText('refactor (3)')).toBeInTheDocument()
    expect(within(panel).getByText('42')).toBeInTheDocument()
  })

  it('shows a helpful-rate percentage only once feedback exists', async () => {
    stubBrain(fullMetrics())
    const { unmount } = render(<MemoryLearningSettings />)
    let economics = await screen.findByTestId('ml-receipt-economics')
    expect(within(economics).getByText('—')).toBeInTheDocument() // no feedback → no claim
    unmount()

    stubBrain(fullMetrics({ ledger: { ...emptyMetrics().ledger, feedbackCount: 8, feedbackHelpfulRate: 0.75 } }))
    render(<MemoryLearningSettings />)
    economics = await screen.findByTestId('ml-receipt-economics')
    expect(within(economics).getByText('75%')).toBeInTheDocument()
    expect(within(economics).queryByText('—')).toBeNull()
  })
})

describe('MemoryLearningSettings — activity ticker', () => {
  it('colours known ops, greys out an unknown one, and zebra-stripes the rows', async () => {
    stubBrain(fullMetrics({
      recentActivity: [
        { ts: Date.parse('2026-07-12T09:08:07Z'), op: 'index', type: 'entity', detail: 'code · alpha.ts:1-40' },
        { ts: Date.parse('2026-07-12T09:09:07Z'), op: 'prune', type: 'n/a', detail: 'decay sweep' }, // not in OP_COLOR
      ],
    }))
    render(<MemoryLearningSettings />)
    const ticker = await screen.findByTestId('ml-ticker')

    const known = within(ticker).getByText('index')
    const unknown = within(ticker).getByText('prune')
    expect(known).toHaveStyle({ color: '#c98500' })
    expect(unknown).toHaveStyle({ color: '#9ca3af' }) // the || fallback, so an op we never saw still renders

    // Alternating background: row 0 is tinted, row 1 is bare.
    expect(known.parentElement!.className).toMatch(/bg-\[#1e1e1e\]/)
    expect(unknown.parentElement!.className).not.toMatch(/bg-\[#1e1e1e\]/)

    expect(within(ticker).getByText('decay sweep')).toBeInTheDocument()
  })
})
