// The defensive halves of two Settings panels: the paths that only run when the bridge is missing,
// the IPC call fails, or the stored numbers are not what the happy path assumes. Both components
// are written to degrade quietly rather than throw or invent a figure, and that promise is only
// worth anything if something exercises it.

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditLogModal } from '../../src/renderer/src/components/SettingsPane/AuditLogModal'
import { TokenSavingsSettings } from '../../src/renderer/src/components/SettingsPane/TokenSavingsSettings'
import type { AuditCoverage, AuditEntry } from '../../src/renderer/src/lib/auditSummary'

type Fn = ReturnType<typeof vi.fn>

// The panels print a real U+2248; spelling it as an escape keeps this file's assertions
// independent of however the checkout encodes non-ASCII.
const APPROX = '≈'

// ===========================================================================
// AuditLogModal
// ===========================================================================

const COVERAGE: AuditCoverage = {
  auditEnabled: true,
  commitShield: true,
  egressGuard: true,
  memoryScrub: true,
}

const ai = (): Record<string, Fn> =>
  (window as unknown as { aiSecurity: Record<string, Fn> }).aiSecurity

const row = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  ts: '2026-07-12T10:00:00.000Z',
  agent: 'claude',
  event: 'terminal_open',
  ...over,
})

describe('AuditLogModal — the paths where the bridge or the data is missing', () => {
  beforeEach(() => {
    ;(window as unknown as { aiSecurity: Record<string, Fn> }).aiSecurity = {
      recentAudit: vi.fn().mockResolvedValue({ success: true, data: [] }),
      clearAudit: vi.fn().mockResolvedValue({ success: true }),
    }
  })

  it('resolves its api without touching a global `window` that does not exist', () => {
    // `api` is read at render time from a bare `window`, so a render outside a browser realm
    // (static markup, an SSR-ish harness) would be a ReferenceError without the typeof guard.
    // Removing the global entirely is the only way to prove the guard, not just the happy arm.
    const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', { value: undefined, configurable: true, writable: true })
    try {
      // Precondition: if a jsdom change ever made this a no-op the test would quietly become a
      // duplicate of the happy path, so assert the global really is gone before rendering.
      expect(typeof window).toBe('undefined')
      const html = renderToStaticMarkup(
        <AuditLogModal onClose={() => {}} coverage={COVERAGE} auditPath="/tmp/audit.jsonl" />,
      )
      expect(html).toContain('AI Security audit log')
      // No window means no bridge and no effects, so it stops at the loading shell rather than
      // rendering a "clean" verdict it has no evidence for.
      expect(html).toContain('Loading audit log')
    } finally {
      if (realWindow) Object.defineProperty(globalThis, 'window', realWindow)
    }
  })

  it('clears the spinner and no-ops Clear log when the aiSecurity bridge is absent', async () => {
    // A renderer that loaded before the preload bridge attached (or a build with the security
    // feature compiled out) has no window.aiSecurity at all. The modal must settle, not hang on
    // "Loading audit log…" forever, and Clear must not call through to undefined.
    delete (window as unknown as { aiSecurity?: unknown }).aiSecurity

    render(<AuditLogModal onClose={() => {}} coverage={COVERAGE} auditPath="/tmp/audit.jsonl" />)

    const empty = await screen.findByTestId('audit-empty')
    expect(empty).toHaveTextContent('The log is empty.')
    expect(screen.queryByText(/Loading audit log/)).toBeNull()

    // Would throw on `undefined.clearAudit()` if the guard were dropped — fireEvent rethrows.
    fireEvent.click(screen.getByTestId('audit-clear'))
    await waitFor(() => expect(screen.getByTestId('audit-empty')).toBeInTheDocument())
  })

  it('stops loading when recentAudit reports a failure', async () => {
    // Reading the JSONL can fail (locked file, EACCES). The `finally` is what guarantees the
    // spinner clears; without it the panel would sit on "Loading…" with no way out.
    ai().recentAudit.mockResolvedValue({ success: false, error: 'EACCES' })

    render(<AuditLogModal onClose={() => {}} coverage={COVERAGE} auditPath="/tmp/audit.jsonl" />)

    expect(await screen.findByTestId('audit-empty')).toHaveTextContent('The log is empty.')
    expect(screen.queryByText(/Loading audit log/)).toBeNull()
  })

  it('keeps the table empty when a "successful" read carries no data', async () => {
    // success:true with data omitted is what an older main handler returns for an empty log.
    // Assigning it straight into state would put `undefined` where an array is expected and
    // crash the filter on the next render.
    ai().recentAudit.mockResolvedValue({ success: true })

    render(<AuditLogModal onClose={() => {}} coverage={COVERAGE} auditPath="/tmp/audit.jsonl" />)

    expect(await screen.findByTestId('audit-empty')).toHaveTextContent('The log is empty.')
    expect(screen.getByText('0 of 0 events')).toBeInTheDocument()
  })

  it('narrows the rows by the free-text needle and distinguishes "no rows" from "no matches"', async () => {
    ai().recentAudit.mockResolvedValue({
      success: true,
      data: [
        row({ event: 'terminal_open', agent: 'claude' }),
        row({ event: 'commit_scan', agent: 'codex', notes: 'pre-commit hook', hitCount: 2 }),
      ],
    })

    render(<AuditLogModal onClose={() => {}} coverage={COVERAGE} auditPath="/tmp/audit.jsonl" />)

    // Empty needle: every row survives the filter.
    const rows = await screen.findByTestId('audit-rows')
    expect(rows.textContent).toContain('Terminal opened')
    expect(rows.textContent).toContain('Commit scanned')

    // A needle matches across event, agent and notes — here it only matches the agent.
    fireEvent.change(screen.getByTestId('audit-filter'), { target: { value: 'codex' } })
    expect(screen.getByTestId('audit-rows').textContent).toContain('Commit scanned')
    expect(screen.getByTestId('audit-rows').textContent).not.toContain('Terminal opened')
    expect(screen.getByText('1 of 2 events')).toBeInTheDocument()

    // Filtered down to nothing. The log is NOT empty, so saying "The log is empty." here would
    // read as "you have no history" when the history is one keystroke away.
    fireEvent.change(screen.getByTestId('audit-filter'), { target: { value: 'no-such-thing' } })
    expect(screen.getByTestId('audit-empty')).toHaveTextContent('Nothing matches that filter.')
    expect(screen.getByText('0 of 2 events')).toBeInTheDocument()
  })

  it('falls back to the raw event name for an event this build has no label for', async () => {
    // AuditEntry.event is a plain string on purpose: a log written by a newer build (or an old
    // one holding a since-renamed event) must stay readable instead of rendering a blank cell.
    ai().recentAudit.mockResolvedValue({
      success: true,
      data: [row({ event: 'quantum_egress_v9' })],
    })

    render(<AuditLogModal onClose={() => {}} coverage={COVERAGE} auditPath="/tmp/audit.jsonl" />)

    const rows = await screen.findByTestId('audit-rows')
    expect(rows.textContent).toContain('quantum_egress_v9')
    // No notes and no hitCount on that row — both optional fields render as nothing, not "undefined".
    expect(rows.textContent).not.toContain('undefined')
  })
})

// ===========================================================================
// TokenSavingsSettings
// ===========================================================================

const proxyTotals = (over: Record<string, number> = {}) => ({
  requests: 40, textOrigTokens: 200000, textSavedTokens: 100000, savedPct: 50,
  images: 3, imageOrigBytes: 0, imageSavedBytes: 0,
  cacheReadTokens: 900000, cacheCreationTokens: 20000, inputTokens: 500, outputTokens: 8000, retrieves: 0, givebackTokens: 0, ...over,
})

const unifiedTotals = (over: Record<string, number> = {}) => ({
  requests: 40, wireOrigTokens: 200000, wireSavedTokens: 100000,
  images: 3, imageOrigBytes: 0, imageSavedBytes: 0,
  toolOrigTokens: 0, toolSavedTokens: 0, toolEvents: 0, byTool: {},
  retrieves: 0, givebackTokens: 0, grossSavedTokens: 100000, netSavedTokens: 100000, savedPct: 50,
  cacheReadTokens: 900000, cacheCreationTokens: 20000, inputTokens: 500, outputTokens: 8000, ...over,
})

const tp = (): Record<string, Fn> =>
  (window as unknown as { termpolis: Record<string, Fn> }).termpolis

const withProxy = (session: Record<string, number>, cumulative: Record<string, number>): void => {
  tp().tokenSavingsGetProxyReceipt = vi.fn().mockResolvedValue({
    success: true,
    data: { session: proxyTotals(session), cumulative: proxyTotals(cumulative) },
  })
}

describe('TokenSavingsSettings — failed reads and totals that are not the happy path', () => {
  beforeEach(() => {
    ;(window as unknown as { termpolis: Record<string, Fn> }).termpolis = {
      tokenSavingsGetSettings: vi.fn().mockResolvedValue({ success: true, data: { enabled: true, mode: 'balanced', steering: true, thinkingCap: 0, adaptiveSteering: true } }),
      tokenSavingsSetSettings: vi.fn().mockResolvedValue({ success: true, data: { enabled: false, mode: 'balanced', steering: true, thinkingCap: 0, adaptiveSteering: true } }),
      tokenSavingsGetReceipt: vi.fn().mockResolvedValue({ success: true, data: { session: { netSaved: 12345, events: 3, byTool: {} }, cumulative: { netSaved: 99999, events: 40, byTool: {} } } }),
      tokenSavingsGetProxyReceipt: vi.fn().mockResolvedValue({ success: true, data: { session: proxyTotals(), cumulative: proxyTotals() } }),
      tokenSavingsGetUnifiedReceipt: vi.fn().mockResolvedValue({ success: true, data: { session: unifiedTotals(), cumulative: unifiedTotals() } }),
    }
  })

  it('shows zeros and hides the toggles when every read fails', async () => {
    // All three IPC reads can fail together (main not up yet, ledger unreadable). Rendering a
    // checkbox in that state would show an invented default that main does not actually hold.
    tp().tokenSavingsGetSettings = vi.fn().mockResolvedValue({ success: false, error: 'no handler' })
    tp().tokenSavingsGetReceipt = vi.fn().mockResolvedValue({ success: false, error: 'no handler' })
    tp().tokenSavingsGetProxyReceipt = vi.fn().mockResolvedValue({ success: false, error: 'no handler' })
    tp().tokenSavingsGetUnifiedReceipt = vi.fn().mockResolvedValue({ success: false, error: 'no handler' })

    render(<TokenSavingsSettings />)

    await waitFor(() => expect(tp().tokenSavingsGetProxyReceipt).toHaveBeenCalled())
    expect(screen.getByTestId('hr-proxy-session-pct')).toHaveTextContent('0%')
    expect(screen.getByTestId('hr-proxy-cumulative-pct')).toHaveTextContent('0%')
    expect(screen.getByTestId('hr-proxy-cumulative-saved')).toHaveTextContent('0')
    expect(screen.queryByTestId('hr-toggle-enabled')).toBeNull()
    expect(screen.queryByTestId('hr-mode')).toBeNull()
    expect(screen.queryByTestId('hr-session-saved')).toBeNull()
    // No usage figures at all ⇒ omit the share sentence rather than claim a share.
    expect(screen.queryByTestId('hr-proxy-share-total')).toBeNull()
  })

  it('leaves the checkbox where it was when saving the setting fails', async () => {
    // The toggle deliberately does not update optimistically: it renders what main confirmed.
    // A failed write must therefore leave the box exactly as it was, not flip and silently drift
    // out of sync with the value the proxy is actually using.
    tp().tokenSavingsSetSettings = vi.fn().mockResolvedValue({ success: false, error: 'EROFS' })

    render(<TokenSavingsSettings />)

    const box = (await screen.findByTestId('hr-toggle-enabled')) as HTMLInputElement
    expect(box.checked).toBe(true)

    fireEvent.click(box)
    await waitFor(() => expect(tp().tokenSavingsSetSettings).toHaveBeenCalledWith({ enabled: false }))
    expect((screen.getByTestId('hr-toggle-enabled') as HTMLInputElement).checked).toBe(true)
  })

  it('drops the "healthy" mark while the prompt cache is still being written', async () => {
    // Early in a session the proxy has created far more cache than it has read back. That is the
    // expensive shape, and the line must not congratulate the user for it.
    withProxy(
      { cacheReadTokens: 1000, cacheCreationTokens: 50000, textSavedTokens: 0 },
      { cacheReadTokens: 1000, cacheCreationTokens: 50000, textSavedTokens: 0 },
    )

    render(<TokenSavingsSettings />)

    const health = await screen.findByTestId('hr-proxy-cache-health')
    expect(health).toHaveTextContent('1,000 cached-read vs 50,000 cache-create tokens')
    expect(health.textContent).not.toContain('healthy')

    // Nothing removed yet, but usage WAS captured — that is an honest 0%, not a hidden line.
    const share = screen.getByTestId('hr-proxy-share-total')
    expect(share.textContent).toContain(`${APPROX}0% of all input tokens you sent this session`)
  })

  it('reports 0% for a session with no usage captured yet while all-time still answers', async () => {
    // A freshly relaunched app has an empty session ledger but a populated all-time one. The
    // session figure is null there, and null must print as 0%, never as "null%".
    withProxy(
      { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      { inputTokens: 500000, cacheReadTokens: 0, cacheCreationTokens: 0, textSavedTokens: 500000 },
    )

    render(<TokenSavingsSettings />)

    const share = await screen.findByTestId('hr-proxy-share-total')
    expect(share.textContent).toContain(`${APPROX}0% of all input tokens you sent this session`)
    expect(share.textContent).toContain(`${APPROX}50% all-time`)
  })

  it('omits the all-time clause when only the session ledger has usage numbers', async () => {
    // The all-time ledger predates the token-usage fields, so an upgraded install can hold a
    // cumulative record with no input/cache counts at all while the live session counts fine.
    // Dropping the clause is the only honest option — "≈0% all-time" would be a claim, not a gap.
    withProxy(
      { inputTokens: 900000, cacheReadTokens: 0, cacheCreationTokens: 0, textSavedTokens: 100000 },
      { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    )

    render(<TokenSavingsSettings />)

    const share = await screen.findByTestId('hr-proxy-share-total')
    expect(share.textContent).toContain(`${APPROX}10% of all input tokens you sent this session`)
    expect(share.textContent).not.toContain('all-time')
  })

  it('never renders a nonsense share when the stored totals cancel out', async () => {
    // The divisor is ingested + saved, and both come off disk. A corrupt or hand-edited ledger
    // can make them cancel; without the guard the panel would print "≈-Infinity%".
    withProxy(
      { inputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0, textSavedTokens: -1000 },
      { inputTokens: 500000, cacheReadTokens: 0, cacheCreationTokens: 0, textSavedTokens: 500000 },
    )

    render(<TokenSavingsSettings />)

    const share = await screen.findByTestId('hr-proxy-share-total')
    expect(share.textContent).toContain(`${APPROX}0% of all input tokens you sent this session`)
    expect(share.textContent).toContain(`${APPROX}50% all-time`)
    expect(share.textContent).not.toMatch(/Infinity|NaN/)
  })
})
