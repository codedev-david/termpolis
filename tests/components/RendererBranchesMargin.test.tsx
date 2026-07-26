// Branch-coverage margin for renderer code paths that only run when something
// upstream misbehaves: an IPC call that answers `{ success: false }` with no
// message, a payload that arrives without its fields, a git row whose status
// letter nobody special-cased, a buffer row that vanishes mid-read. The happy
// path suites never walk these, so they are exactly where the v8 branch gaps
// live — and they are also the paths that decide whether a bad backend answer
// shows the user a sane message or a blank panel.
import React from 'react'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  reflowSoftWraps,
  reflowForMessage,
  extractSelectionWithLogicalNewlines,
  writeCodeBlockToClipboard,
  type TerminalLike,
} from '../../src/renderer/src/lib/exportTerminal'
import {
  extractTokensFromEvents,
  heuristicTokensFromEvents,
  computePressure,
} from '../../src/renderer/src/lib/contextPressure'
import type { AgentActivityEvent } from '../../src/renderer/src/types'

vi.mock('../../src/renderer/src/lib/pollingService', () => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}))

import { ContextPanel } from '../../src/renderer/src/components/ContextPanel/ContextPanel'
import { CodeGraphPanel } from '../../src/renderer/src/components/Memory/CodeGraphPanel'
import { SafeImportPanel } from '../../src/renderer/src/components/SettingsPane/SafeImportPanel'
import { SwarmReviewPanel } from '../../src/renderer/src/components/SwarmReview/SwarmReviewPanel'

type Api = Record<string, ReturnType<typeof vi.fn>>

afterEach(() => {
  cleanup()
})

// Swap globals for the duration of one test and put the originals back exactly
// as they were. Deliberately NOT vi.stubGlobal/unstubAllGlobals: unstubbing is
// all-or-nothing and would also tear out the IntersectionObserver shim the
// shared test setup installs.
function withGlobals(patch: Record<string, unknown>): () => void {
  const saved = Object.keys(patch).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const)
  for (const [k, v] of Object.entries(patch)) {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
  }
  return () => {
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, k, desc)
      else delete (globalThis as unknown as Record<string, unknown>)[k]
    }
  }
}

// ---------------------------------------------------------------------------
// contextPressure — token accounting when the transcript watcher is sloppy
// ---------------------------------------------------------------------------

function evt(over: Partial<AgentActivityEvent>): AgentActivityEvent {
  return {
    id: over.id ?? 'e1',
    ts: over.ts ?? 1,
    terminalId: over.terminalId ?? 't1',
    agentType: over.agentType ?? 'claude',
    kind: over.kind ?? 'message',
    summary: over.summary ?? '',
    payload: over.payload ?? {},
    ...(over.taskId ? { taskId: over.taskId } : {}),
  } as AgentActivityEvent
}

describe('contextPressure — degraded token_update payloads', () => {
  it('keeps the newest session when an older session event trails it in the array', () => {
    // The watcher replays a whole jsonl file, so an older session can appear
    // AFTER the current one. Its (huge) count must not win.
    const events = [
      evt({ id: 'a', kind: 'token_update', taskId: 'session-new', ts: 200, payload: { inputTokens: 50 } }),
      evt({ id: 'b', kind: 'token_update', taskId: 'session-old', ts: 100, payload: { inputTokens: 999_999 } }),
    ]
    expect(extractTokensFromEvents(events)).toBe(50)
  })

  it('treats a token_update with no payload at all as zero tokens', () => {
    const bare = { id: 'a', ts: 1, terminalId: 't1', agentType: 'claude', kind: 'token_update', summary: '' } as unknown as AgentActivityEvent
    expect(extractTokensFromEvents([bare])).toBe(0)
  })

  it('reads the snake_case and short-form token aliases other watchers emit', () => {
    const short = evt({
      id: 'a',
      kind: 'token_update',
      ts: 1,
      payload: { input: 10, output: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
    })
    const snake = evt({
      id: 'b',
      kind: 'token_update',
      ts: 2,
      payload: { prompt_tokens: 3, completion_tokens: 1 },
    })
    expect(extractTokensFromEvents([short])).toBe(18)
    expect(extractTokensFromEvents([snake])).toBe(4)
    expect(extractTokensFromEvents([short, snake])).toBe(18)
  })

  it('falls back to the per-message average when a message carries no payload', () => {
    const bare = { id: 'a', ts: 1, terminalId: 't1', agentType: 'claude', kind: 'message', summary: '' } as unknown as AgentActivityEvent
    expect(heuristicTokensFromEvents([bare], 250)).toBe(250)
  })

  it('returns zero when events exist but none of them are messages', () => {
    const events = [evt({ id: 'a', kind: 'tool_use', ts: 1 })]
    expect(heuristicTokensFromEvents(events, 250)).toBe(0)
  })

  it('honours an explicit maxTokens override for the window size', () => {
    const events = [evt({ id: 'a', kind: 'token_update', ts: 1, payload: { inputTokens: 5_000 } })]
    const w = computePressure(events, { model: 'claude-opus-4', maxTokens: 12_345 })
    expect(w.total).toBe(12_345)
    expect(w.used).toBe(5_000)
    expect(w.source).toBe('transcript')
  })

  it('uses a caller-supplied average, and ignores a nonsensical negative one', () => {
    const events = [evt({ id: 'a', kind: 'message', ts: 1 })]
    expect(computePressure(events, { avgTokensPerMessage: 1_000 }).used).toBe(1_000)
    expect(computePressure(events, { avgTokensPerMessage: -5 }).used).toBe(250)
    expect(computePressure(events, { avgTokensPerMessage: 0 }).used).toBe(250)
  })
})

// ---------------------------------------------------------------------------
// exportTerminal — buffer walks over an inconsistent terminal
// ---------------------------------------------------------------------------

describe('exportTerminal — degraded buffers and clipboards', () => {
  it('flushes a trailing soft-wrap run that never reaches a short line', () => {
    const a = 'a'.repeat(20)
    const b = 'b'.repeat(20)
    // Both rows are exactly `cols` wide, so the loop buffers to the very end
    // and the join has to happen after it — otherwise the text is lost.
    expect(reflowSoftWraps(`${a}\n${b}`, 20)).toBe(a + b)
  })

  it('assumes an 80-column wrap when the terminal reports no usable width', () => {
    const long = 'a'.repeat(78)
    // 78 + 1 + len('bbbb') = 83 > 80, so at the default width the break is a wrap.
    expect(reflowForMessage([long, 'bbbb'], 0)).toEqual([`${long} bbbb`])
    expect(reflowForMessage([long, 'bbbb'], 10)).toEqual([`${long} bbbb`])
    // At a genuinely wide terminal the same break is a real newline.
    expect(reflowForMessage([long, 'bbbb'], 200)).toEqual([long, 'bbbb'])
  })

  it('returns an empty string when xterm hands back a null selection', () => {
    const term = {
      cols: 80,
      getSelection: () => null,
      buffer: { active: { getLine: () => undefined } },
    } as unknown as TerminalLike
    expect(extractSelectionWithLogicalNewlines(term)).toBe('')
  })

  it('falls back to the flat selection when the buffer is not reachable', () => {
    const term = {
      cols: 80,
      getSelection: () => 'flat\nselection',
      getSelectionPosition: () => ({ start: { x: 0, y: 0 }, end: { x: 4, y: 1 } }),
    } as unknown as TerminalLike
    expect(extractSelectionWithLogicalNewlines(term)).toBe('flat\nselection')
  })

  it('still emits the joined line when a wrapped row is trimmed away mid-walk', () => {
    // The buffer can scroll between the "is the next row wrapped?" peek and the
    // read of that row. The walk must skip the missing row and still flush what
    // it had accumulated instead of silently dropping the selection.
    const rows = [
      { isWrapped: false, translateToString: () => 'AAA' },
      { isWrapped: true, translateToString: () => 'BBB' },
    ]
    let peeked = false
    const term = {
      cols: 80,
      getSelection: () => 'AAABBBCCC',
      getSelectionPosition: () => ({ start: { x: 0, y: 0 }, end: { x: 3, y: 2 } }),
      buffer: {
        active: {
          getLine: (y: number) => {
            if (y === 2) {
              if (!peeked) {
                peeked = true
                return { isWrapped: true, translateToString: () => 'CCC' }
              }
              return undefined
            }
            return rows[y]
          },
        },
      },
    } as unknown as TerminalLike
    expect(extractSelectionWithLogicalNewlines(term)).toBe('AAABBB')
  })

  it('writes rich + plain forms when ClipboardItem is available', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const writeText = vi.fn().mockResolvedValue(undefined)
    const restore = withGlobals({
      ClipboardItem: class {
        constructor(public parts: Record<string, Blob>) {}
      },
      navigator: { clipboard: { write, writeText } },
      window: { ClipboardItem: class {} },
    })
    try {
      await writeCodeBlockToClipboard('hello', 80)
    } finally {
      restore()
    }
    expect(write).toHaveBeenCalledTimes(1)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('degrades to a plain-text write when there is no window object', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const write = vi.fn().mockResolvedValue(undefined)
    const restore = withGlobals({
      navigator: { clipboard: { write, writeText } },
      window: undefined,
    })
    try {
      await writeCodeBlockToClipboard('hello', 80)
    } finally {
      restore()
    }
    expect(write).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(String(writeText.mock.calls[0][0])).toContain('hello')
  })
})

// ---------------------------------------------------------------------------
// ContextPanel
// ---------------------------------------------------------------------------

function setContextApi(over: Partial<Api> = {}): Api {
  const api: Api = {
    completionPathEntries: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getGitInfo: vi.fn().mockResolvedValue({ success: false, data: null }),
    ...over,
  }
  ;(window as unknown as { termpolis: Api }).termpolis = api
  return api
}

describe('ContextPanel — degraded git/file backends', () => {
  it('does not touch the backend at all without a working directory', () => {
    const api = setContextApi()
    render(<ContextPanel cwd="" onClose={vi.fn()} />)
    expect(api.completionPathEntries).not.toHaveBeenCalled()
    expect(api.getGitInfo).not.toHaveBeenCalled()
  })

  it('degrades to an empty tree when the file listing fails or returns no data', async () => {
    const api = setContextApi({ completionPathEntries: vi.fn().mockResolvedValue({ success: false }) })
    render(<ContextPanel cwd="/repo" onClose={vi.fn()} />)
    await waitFor(() => expect(api.completionPathEntries).toHaveBeenCalled())
    expect(await screen.findByText('No files')).toBeTruthy()
    // The rest of the panel must still render — a failed listing is not fatal.
    expect(screen.getByText('Git Status')).toBeTruthy()

    cleanup()
    const api2 = setContextApi({ completionPathEntries: vi.fn().mockResolvedValue({ success: true, data: null }) })
    render(<ContextPanel cwd="/repo" onClose={vi.fn()} />)
    await waitFor(() => expect(api2.completionPathEntries).toHaveBeenCalled())
    expect(await screen.findByText('No files')).toBeTruthy()
  })

  it('reports "Not a git repo" when the git bridge throws', async () => {
    const api = setContextApi({ getGitInfo: vi.fn().mockRejectedValue(new Error('spawn ENOENT')) })
    render(<ContextPanel cwd="/repo" onClose={vi.fn()} />)
    await waitFor(() => expect(api.getGitInfo).toHaveBeenCalled())
    expect(await screen.findByText('Not a git repo')).toBeTruthy()
  })

  it('colours untracked, renamed and unrecognised status rows distinctly', async () => {
    setContextApi({
      getGitInfo: vi.fn().mockResolvedValue({
        success: true,
        data: { status: '?? brand-new.ts\nR  moved.ts\nUU conflicted.ts', recentCommits: '' },
      }),
    })
    render(<ContextPanel cwd="/repo" onClose={vi.fn()} />)
    const untracked = await screen.findByTitle(/brand-new\.ts/)
    expect(untracked.style.color).toBe('rgb(97, 175, 239)')
    expect(screen.getByTitle(/moved\.ts/).style.color).toBe('rgb(198, 120, 221)')
    expect(screen.getByTitle(/conflicted\.ts/).style.color).toBe('rgb(171, 178, 191)')
  })

  it('collapses the commits section when its header is clicked', async () => {
    setContextApi({
      getGitInfo: vi.fn().mockResolvedValue({
        success: true,
        data: { status: '', recentCommits: 'deadbee first commit' },
      }),
    })
    const { container } = render(<ContextPanel cwd="/repo" onClose={vi.fn()} />)
    expect(await screen.findByText('first commit')).toBeTruthy()
    expect(container.querySelectorAll('.fa-chevron-right').length).toBe(0)

    fireEvent.click(screen.getByText('Recent Commits'))
    expect(screen.queryByText('first commit')).toBeNull()
    expect(container.querySelectorAll('.fa-chevron-right').length).toBe(1)
  })

  it('renders a hash-only commit line without inventing a message', async () => {
    setContextApi({
      getGitInfo: vi.fn().mockResolvedValue({
        success: true,
        data: { status: '', recentCommits: 'deadbee' },
      }),
    })
    render(<ContextPanel cwd="/repo" onClose={vi.fn()} />)
    const row = await screen.findByTitle('deadbee')
    expect(row.textContent).toBe('deadbee')
  })
})

// ---------------------------------------------------------------------------
// CodeGraphPanel
// ---------------------------------------------------------------------------

function sym(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: `a#${name}@1`, name, kind: 'function', file: '/repo/a.ts', startLine: 1, endLine: 5, lang: 'ts', ...over }
}

function setGraphApi(over: Partial<Api> = {}): Api {
  const api: Api = {
    codeGraphStats: vi.fn().mockResolvedValue({ success: true, data: { files: 10, symbols: 42, edges: 99 } }),
    codeGraphSearch: vi.fn().mockResolvedValue({ success: true, data: [sym('foo')] }),
    codeGraphExplore: vi.fn().mockResolvedValue({
      success: true,
      data: { symbol: sym('foo'), source: '', callers: [{ name: 'caller1' }], callees: [{ name: 'bar' }] },
    }),
    codeGraphImpact: vi.fn().mockResolvedValue({ success: true, data: [{ name: 'x' }] }),
    codeGraphBuild: vi.fn().mockResolvedValue({ success: true, data: { files: 1, symbols: 2, edges: 3 } }),
    gitFindRoot: vi.fn().mockResolvedValue({ success: true, data: '/repo' }),
    ...over,
  }
  ;(window as unknown as { termpolis: Api }).termpolis = api
  return api
}

async function findSymbol(api: Api, name = 'foo'): Promise<void> {
  fireEvent.change(screen.getByTestId('code-graph-search'), { target: { value: name } })
  fireEvent.click(screen.getByTestId('code-graph-search-btn'))
  await waitFor(() => expect(api.codeGraphSearch).toHaveBeenCalled())
}

describe('CodeGraphPanel — degraded graph backend', () => {
  it('leaves the stats placeholder in place when the stats call fails', async () => {
    const api = setGraphApi({ codeGraphStats: vi.fn().mockResolvedValue({ success: false }) })
    render(<CodeGraphPanel cwd="/repo" />)
    await waitFor(() => expect(api.codeGraphStats).toHaveBeenCalled())
    expect(screen.getByTestId('code-graph-stats').textContent).not.toContain('symbols')
    expect(screen.queryByTestId('code-graph-empty')).toBeNull()
  })

  it('shows no result list when the search call fails', async () => {
    const api = setGraphApi({ codeGraphSearch: vi.fn().mockResolvedValue({ success: false }) })
    render(<CodeGraphPanel cwd="/repo" />)
    await findSymbol(api)
    await waitFor(() => expect(screen.queryByTestId('code-graph-results')).toBeNull())
  })

  it('shows no detail pane when explore and impact both fail', async () => {
    const api = setGraphApi({
      codeGraphExplore: vi.fn().mockResolvedValue({ success: false }),
      codeGraphImpact: vi.fn().mockResolvedValue({ success: false }),
    })
    render(<CodeGraphPanel cwd="/repo" />)
    await findSymbol(api)
    fireEvent.click(await screen.findByTestId('cg-sym-foo'))
    await waitFor(() => expect(api.codeGraphExplore).toHaveBeenCalledWith('foo'))
    expect(screen.queryByTestId('code-graph-detail')).toBeNull()
  })

  it('hides the blast radius when the impact query fails but explore succeeds', async () => {
    const api = setGraphApi({ codeGraphImpact: vi.fn().mockResolvedValue({ success: false }) })
    render(<CodeGraphPanel cwd="/repo" />)
    await findSymbol(api)
    fireEvent.click(await screen.findByTestId('cg-sym-foo'))
    await screen.findByTestId('code-graph-detail')
    expect(screen.queryByTestId('code-graph-impact')).toBeNull()
  })

  it('says "1 symbol" (singular) for a blast radius of one', async () => {
    const api = setGraphApi()
    render(<CodeGraphPanel cwd="/repo" />)
    await findSymbol(api)
    fireEvent.click(await screen.findByTestId('cg-sym-foo'))
    const impact = await screen.findByTestId('code-graph-impact')
    expect(impact.textContent).toContain('1 symbol could be affected')
    expect(impact.textContent).not.toContain('symbols')
  })

  it('renders an em dash for a symbol with no callers or callees', async () => {
    const api = setGraphApi({
      codeGraphExplore: vi.fn().mockResolvedValue({
        success: true,
        data: { symbol: sym('foo', { file: '' }), source: '', callers: [], callees: [] },
      }),
    })
    render(<CodeGraphPanel cwd="/repo" />)
    await findSymbol(api)
    fireEvent.click(await screen.findByTestId('cg-sym-foo'))
    const detail = await screen.findByTestId('code-graph-detail')
    expect(detail.textContent).toContain('Callers:')
    expect(detail.textContent).toContain('—')
    // A symbol with no file path still renders its line range rather than crashing.
    expect(detail.textContent).toContain(':1-5')
    expect(screen.queryByTestId('code-graph-source')).toBeNull()
  })

  it('asks for a git repo when resolving the root throws', async () => {
    const api = setGraphApi({ gitFindRoot: vi.fn().mockRejectedValue(new Error('not a repo')) })
    render(<CodeGraphPanel cwd="/somewhere" />)
    await waitFor(() => expect(api.codeGraphStats).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('code-graph-rebuild'))
    const status = await screen.findByTestId('code-graph-status')
    expect(status.textContent).toContain('git repo')
    expect(api.codeGraphBuild).not.toHaveBeenCalled()
  })

  it('will not rebuild without a cwd, or without a gitFindRoot bridge', async () => {
    const api = setGraphApi()
    render(<CodeGraphPanel />)
    await waitFor(() => expect(api.codeGraphStats).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('code-graph-rebuild'))
    expect((await screen.findByTestId('code-graph-status')).textContent).toContain('git repo')
    expect(api.gitFindRoot).not.toHaveBeenCalled()
    expect(api.codeGraphBuild).not.toHaveBeenCalled()

    cleanup()
    const api2 = setGraphApi()
    delete (api2 as Record<string, unknown>).gitFindRoot
    render(<CodeGraphPanel cwd="/repo" />)
    await waitFor(() => expect(api2.codeGraphStats).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('code-graph-rebuild'))
    expect((await screen.findByTestId('code-graph-status')).textContent).toContain('git repo')
    expect(api2.codeGraphBuild).not.toHaveBeenCalled()
  })

  it('reports a failed rebuild instead of a bogus symbol count', async () => {
    const api = setGraphApi({ codeGraphBuild: vi.fn().mockResolvedValue({ success: false }) })
    render(<CodeGraphPanel cwd="/repo" />)
    await waitFor(() => expect(api.codeGraphStats).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('code-graph-rebuild'))
    const status = await screen.findByTestId('code-graph-status')
    expect(status.textContent).toContain('Build failed.')
  })

  it('only searches on Enter, not on every keystroke', async () => {
    const api = setGraphApi()
    render(<CodeGraphPanel cwd="/repo" />)
    const input = screen.getByTestId('code-graph-search')
    fireEvent.change(input, { target: { value: 'foo' } })
    fireEvent.keyDown(input, { key: 'a' })
    expect(api.codeGraphSearch).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(api.codeGraphSearch).toHaveBeenCalledWith('foo', 30))
  })
})

// ---------------------------------------------------------------------------
// SafeImportPanel
// ---------------------------------------------------------------------------

let progressCb: ((p: { pct: number; stage: string }) => void) | null = null

function scanReport(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    canceled: false,
    name: 'pdf-tools',
    kind: 'skill',
    hash: 'h1',
    level: 'green',
    findings: [],
    filesScanned: 3,
    summary: 'no dangerous constructs found',
    targets: ['claude', 'codex'],
    alreadyApproved: false,
    ...over,
  }
}

function setImportApi(over: Partial<Api> = {}): Api {
  const api: Api = {
    scan: vi.fn().mockResolvedValue({ success: true, data: scanReport() }),
    approveInstall: vi.fn().mockResolvedValue({
      success: true,
      data: { installed: [{ target: 'claude', path: '/h/.claude/skills/pdf-tools/SKILL.md' }] },
    }),
    list: vi.fn().mockResolvedValue({ success: true, data: [] }),
    revoke: vi.fn().mockResolvedValue({ success: true }),
    onProgress: vi.fn((cb: (p: { pct: number; stage: string }) => void) => {
      progressCb = cb
      return () => {
        progressCb = null
      }
    }),
    ...over,
  }
  ;(window as unknown as { safeImport: Api }).safeImport = api
  return api
}

describe('SafeImportPanel — degraded import bridge', () => {
  beforeEach(() => {
    progressCb = null
  })

  it('renders no imported list when listing artifacts fails', async () => {
    const api = setImportApi({ list: vi.fn().mockResolvedValue({ success: false }) })
    render(<SafeImportPanel />)
    await waitFor(() => expect(api.list).toHaveBeenCalled())
    expect(screen.queryByTestId('safe-import-list')).toBeNull()
  })

  it('falls back to a generic message when a scan fails without one', async () => {
    const api = setImportApi({ scan: vi.fn().mockResolvedValue({ success: false }) })
    render(<SafeImportPanel />)
    fireEvent.click(screen.getByTestId('safe-import-pick'))
    await waitFor(() => expect(api.scan).toHaveBeenCalled())
    expect(await screen.findByText('Scan failed')).toBeTruthy()
    expect(screen.queryByTestId('safe-import-report')).toBeNull()
  })

  it('falls back to a generic message when an install fails without one', async () => {
    const api = setImportApi({ approveInstall: vi.fn().mockResolvedValue({ success: false }) })
    render(<SafeImportPanel />)
    fireEvent.click(screen.getByTestId('safe-import-pick'))
    await screen.findByTestId('safe-import-report')
    fireEvent.click(screen.getByTestId('safe-import-approve'))
    await waitFor(() => expect(api.approveInstall).toHaveBeenCalled())
    expect(await screen.findByText('Install failed')).toBeTruthy()
    // The report stays on screen so the user can retry rather than losing the scan.
    expect(screen.getByTestId('safe-import-report')).toBeTruthy()
  })

  it('says "no agent" when the install reports success but wires nothing', async () => {
    const api = setImportApi({
      approveInstall: vi.fn().mockResolvedValue({ success: true, data: { installed: [] } }),
    })
    render(<SafeImportPanel />)
    fireEvent.click(screen.getByTestId('safe-import-pick'))
    await screen.findByTestId('safe-import-report')
    fireEvent.click(screen.getByTestId('safe-import-approve'))
    await waitFor(() => expect(api.approveInstall).toHaveBeenCalled())
    const done = await screen.findByTestId('safe-import-done')
    expect(done.textContent).toContain('no agent')
  })

  it('toggles a wire-in target off and back on', async () => {
    setImportApi()
    render(<SafeImportPanel />)
    fireEvent.click(screen.getByTestId('safe-import-pick'))
    await screen.findByTestId('safe-import-report')
    const claude = screen.getByLabelText('claude') as HTMLInputElement
    expect(claude.checked).toBe(true)
    fireEvent.click(claude)
    expect((screen.getByLabelText('claude') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByLabelText('claude'))
    expect((screen.getByLabelText('claude') as HTMLInputElement).checked).toBe(true)
  })

  it('labels progress generically when the scanner reports an empty stage', async () => {
    let release: (v: unknown) => void = () => {}
    const api = setImportApi({
      scan: vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      ),
    })
    render(<SafeImportPanel />)
    fireEvent.click(screen.getByTestId('safe-import-pick'))
    await waitFor(() => expect(api.scan).toHaveBeenCalled())
    act(() => {
      progressCb?.({ pct: 42, stage: '' })
    })
    const progress = await screen.findByTestId('safe-import-progress')
    expect(progress.textContent).toContain('Processing skill/plugin')
    expect(progress.textContent).toContain('42%')
    await act(async () => {
      release({ success: true, data: scanReport() })
    })
  })
})

// ---------------------------------------------------------------------------
// SwarmReviewPanel
// ---------------------------------------------------------------------------

const SINGLE_FILE_DIFF = `diff --git a/src/only.ts b/src/only.ts
index 111..222 100644
--- a/src/only.ts
+++ b/src/only.ts
@@ -1 +1 @@
-old
+new
`

const MIXED_DIFF = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 111..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts
diff --git a/assets/logo.png b/assets/logo.png
index 111..222 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`

const swarmApi = {
  gitDiffRange: vi.fn(),
  gitApplyPatch: vi.fn(),
  gitCheckoutFile: vi.fn(),
  gitResetHard: vi.fn(),
  gitCommitAll: vi.fn(),
  swarmRunCommand: vi.fn(),
  readConfigFile: vi.fn(),
}

async function renderReview(diff: string, overrideProps: Record<string, unknown> = {}) {
  const props = {
    preSwarmSha: 'abc1234567',
    cwd: '/repo',
    taskDescription: 'Add feature',
    onClose: vi.fn(),
    onCommitted: vi.fn(),
    ...overrideProps,
  }
  swarmApi.gitDiffRange.mockResolvedValue({ success: true, data: diff })
  const utils = render(<SwarmReviewPanel {...(props as never)} />)
  await waitFor(() => expect(swarmApi.gitDiffRange).toHaveBeenCalled())
  return { ...utils, props }
}

describe('SwarmReviewPanel — degraded git bridge and odd diffs', () => {
  beforeEach(() => {
    Object.values(swarmApi).forEach((fn) => fn.mockReset())
    ;(window as unknown as { termpolis: typeof swarmApi }).termpolis = swarmApi
    swarmApi.gitDiffRange.mockResolvedValue({ success: true, data: SINGLE_FILE_DIFF })
    swarmApi.gitApplyPatch.mockResolvedValue({ success: true })
    swarmApi.gitCheckoutFile.mockResolvedValue({ success: true })
    swarmApi.gitResetHard.mockResolvedValue({ success: true })
    swarmApi.gitCommitAll.mockResolvedValue({ success: true })
    swarmApi.swarmRunCommand.mockResolvedValue({ success: true, data: { output: 'passed', exitCode: 0 } })
    swarmApi.readConfigFile.mockResolvedValue({ success: true, data: JSON.stringify({ scripts: { test: 'vitest' } }) })
  })

  it('shows a generic load error when the diff call fails without a message', async () => {
    swarmApi.gitDiffRange.mockResolvedValue({ success: false })
    render(
      <SwarmReviewPanel
        preSwarmSha="abc1234567"
        cwd="/repo"
        onClose={vi.fn()}
      />,
    )
    expect(await screen.findByText('Failed to load diff')).toBeTruthy()
    expect(screen.queryByTestId('review-summary')).toBeNull()
  })

  it('uses singular wording for a one-file, one-hunk review', async () => {
    await renderReview(SINGLE_FILE_DIFF)
    const summary = await screen.findByTestId('review-summary')
    expect(summary.textContent).toContain('1 file ·')
    expect(summary.textContent).toContain('1 hunk')
    expect(summary.textContent).not.toContain('files')
    expect(summary.textContent).not.toContain('hunks')
  })

  it('badges deleted and renamed files differently from modified ones', async () => {
    await renderReview(MIXED_DIFF)
    const deleted = await screen.findByTestId('review-file-src/gone.ts')
    expect(deleted.textContent).toContain('D')
    expect(deleted.querySelector('.bg-\\[\\#3a1a1a\\]')).toBeTruthy()
    const renamed = screen.getByTestId('review-file-src/new.ts')
    expect(renamed.textContent).toContain('R')
    expect(renamed.querySelector('.bg-\\[\\#1a1a3a\\]')).toBeTruthy()
  })

  it('explains that a binary file has no inline diff', async () => {
    await renderReview(MIXED_DIFF)
    fireEvent.click(await screen.findByTestId('review-file-assets/logo.png'))
    expect(await screen.findByText(/Binary file/)).toBeTruthy()
  })

  it('explains a pure rename that carries no hunks', async () => {
    await renderReview(MIXED_DIFF)
    fireEvent.click(await screen.findByTestId('review-file-src/new.ts'))
    expect(await screen.findByText(/No hunks \(pure rename or mode change\)/)).toBeTruthy()
  })

  it('says "unknown" when reverse-applying a rejected hunk fails silently', async () => {
    swarmApi.gitApplyPatch.mockResolvedValue({ success: false })
    await renderReview(SINGLE_FILE_DIFF)
    fireEvent.click(await screen.findByTestId('review-file-src/only.ts'))
    fireEvent.click(await screen.findByText('Reject'))
    fireEvent.click(screen.getByTestId('review-commit'))
    const msg = await screen.findByTestId('review-action-msg')
    expect(msg.textContent).toContain('Failed to reject hunk in src/only.ts: unknown')
    expect(swarmApi.gitCommitAll).not.toHaveBeenCalled()
  })

  it('commits straight through when every hunk is explicitly accepted', async () => {
    await renderReview(SINGLE_FILE_DIFF)
    fireEvent.click(await screen.findByTestId('review-file-src/only.ts'))
    fireEvent.click(await screen.findByText('Accept'))
    fireEvent.click(screen.getByTestId('review-commit'))
    await waitFor(() => expect(swarmApi.gitCommitAll).toHaveBeenCalled())
    // An accepted hunk is kept, so nothing is reverse-applied.
    expect(swarmApi.gitApplyPatch).not.toHaveBeenCalled()
  })

  it('cancels the revert-all confirmation without touching git', async () => {
    await renderReview(SINGLE_FILE_DIFF)
    fireEvent.click(await screen.findByTestId('review-revert-all'))
    expect(screen.getByTestId('review-revert-all-confirm')).toBeTruthy()
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByTestId('review-revert-all-confirm')).toBeNull()
    expect(swarmApi.gitResetHard).not.toHaveBeenCalled()
  })

  it('styles the post-revert confirmation as success, not as an error', async () => {
    await renderReview(SINGLE_FILE_DIFF)
    fireEvent.click(await screen.findByTestId('review-revert-all'))
    fireEvent.click(screen.getByTestId('review-revert-all-confirm'))
    await waitFor(() => expect(swarmApi.gitResetHard).toHaveBeenCalledWith('/repo', 'abc1234567'))
    const msg = await screen.findByTestId('review-action-msg')
    expect(msg.textContent).toContain('All swarm changes reverted')
    expect(msg.className).toContain('#98c379')
    expect(msg.className).not.toContain('#e06c75')
  })

  it('ignores a refine request with nothing but whitespace in it', async () => {
    const onRefineWithSwarm = vi.fn()
    await renderReview(SINGLE_FILE_DIFF, { onRefineWithSwarm })
    fireEvent.change(await screen.findByTestId('review-refine-input'), { target: { value: '   ' } })
    fireEvent.click(screen.getByTestId('review-refine-btn'))
    expect(onRefineWithSwarm).not.toHaveBeenCalled()
  })
})
