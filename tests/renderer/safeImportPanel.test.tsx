// @vitest-environment jsdom
//
// Safe Import — the UI gate. The security-critical assertion here is that a RED artifact
// offers NO path to install: the approve control is not rendered at all, so the "just click
// through it" failure mode doesn't exist. (The main process refuses red independently — the
// UI is defence in depth, not the boundary.)
import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SafeImportPanel } from '../../src/renderer/src/components/SettingsPane/SafeImportPanel'

type Api = Record<string, ReturnType<typeof vi.fn>>

let progressCb: ((p: { pct: number; stage: string }) => void) | null = null

function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    canceled: false,
    name: 'pdf-tools',
    kind: 'skill',
    hash: 'h1',
    level: 'green',
    findings: [],
    filesScanned: 3,
    summary: 'no dangerous constructs found',
    targets: ['claude'],
    alreadyApproved: false,
    ...over,
  }
}

function setApi(overrides: Partial<Api> = {}): Api {
  const api: Api = {
    scan: vi.fn().mockResolvedValue({ success: true, data: report() }),
    approveInstall: vi.fn().mockResolvedValue({
      success: true,
      data: { installed: [{ target: 'claude', path: '/h/.claude/skills/pdf-tools/SKILL.md' }] },
    }),
    list: vi.fn().mockResolvedValue({ success: true, data: [] }),
    revoke: vi.fn().mockResolvedValue({ success: true }),
    onProgress: vi.fn((cb: (p: { pct: number; stage: string }) => void) => {
      progressCb = cb
      return () => { progressCb = null }
    }),
    ...overrides,
  }
  ;(window as unknown as { safeImport: Api }).safeImport = api
  return api
}

beforeEach(() => { progressCb = null })

describe('SafeImportPanel — the scan gate', () => {
  it('renders an unavailable notice when the bridge is missing', () => {
    ;(window as unknown as { safeImport?: Api }).safeImport = undefined
    render(<SafeImportPanel />)
    expect(screen.getByText(/unavailable/i)).toBeTruthy()
  })

  it('scans a clean skill and offers to wire it in', async () => {
    const api = setApi()
    render(<SafeImportPanel />)
    fireEvent.click(screen.getByTestId('safe-import-pick'))
    await waitFor(() => screen.getByTestId('safe-import-report'))
    expect(api.scan).toHaveBeenCalled()
    expect(screen.getByText(/Safe to import/i)).toBeTruthy()
    expect(screen.getByTestId('safe-import-approve')).toBeTruthy()
  })

  it('BLOCKS a red artifact — the approve control is never even rendered', async () => {
    setApi({
      scan: vi.fn().mockResolvedValue({
        success: true,
        data: report({
          level: 'red',
          findings: [{
            rule: 'net.fetch', label: 'Outbound network call (fetch)', severity: 'red',
            file: 'skill.js', line: 12, excerpt: 'fetch("http://evil.example")',
          }],
        }),
      }),
    })
    render(<SafeImportPanel />)
    fireEvent.click(screen.getByTestId('safe-import-pick'))
    await waitFor(() => screen.getByTestId('safe-import-report'))

    expect(screen.getByText(/Blocked — unsafe/i)).toBeTruthy()
    expect(screen.queryByTestId('safe-import-approve')).toBeNull() // the whole point
    expect(screen.getByText(/net\.fetch/)).toBeTruthy()
    expect(screen.getByText(/skill\.js:12/)).toBeTruthy()
  })

  it('shows yellow findings but still allows an informed install', async () => {
    setApi({
      scan: vi.fn().mockResolvedValue({
        success: true,
        data: report({
          level: 'yellow',
          findings: [{
            rule: 'cred.process_env', label: 'Reads process environment', severity: 'yellow',
            file: 'index.js', line: 3, excerpt: 'const k = process.env.HOME',
          }],
        }),
      }),
    })
    render(<SafeImportPanel />)
    fireEvent.click(screen.getByTestId('safe-import-pick'))
    await waitFor(() => screen.getByTestId('safe-import-report'))
    expect(screen.getByText(/Review before importing/i)).toBeTruthy()
    expect(screen.getByTestId('safe-import-approve')).toBeTruthy()
  })

  it('does nothing when the picker is canceled', async () => {
    setApi({ scan: vi.fn().mockResolvedValue({ success: true, data: { canceled: true } }) })
    render(<SafeImportPanel />)
    fireEvent.click(screen.getByTestId('safe-import-pick'))
    await waitFor(() => expect(screen.queryByTestId('safe-import-report')).toBeNull())
  })

  it('surfaces a scan error', async () => {
    setApi({ scan: vi.fn().mockResolvedValue({ success: false, error: 'unreadable archive' }) })
    render(<SafeImportPanel />)
    fireEvent.click(screen.getByTestId('safe-import-pick'))
    await waitFor(() => expect(screen.getByText('unreadable archive')).toBeTruthy())
  })
})

describe('SafeImportPanel — live progress', () => {
  it('renders the real per-file percentage streamed from the scanner', async () => {
    let resolveScan: (v: unknown) => void = () => {}
    setApi({ scan: vi.fn(() => new Promise((r) => { resolveScan = r })) })
    render(<SafeImportPanel />)

    fireEvent.click(screen.getByTestId('safe-import-pick'))
    await waitFor(() => screen.getByTestId('safe-import-progress'))

    act(() => { progressCb?.({ pct: 42, stage: 'Scanning skill.js' }) })
    await waitFor(() => {
      const bar = screen.getByTestId('safe-import-progress').textContent || ''
      expect(bar).toContain('42%')
      expect(bar).toContain('Scanning skill.js')
    })

    await act(async () => { resolveScan({ success: true, data: report() }) })
  })
})

describe('SafeImportPanel — install and revoke', () => {
  it('wires an approved skill into the chosen agents and reports where it landed', async () => {
    const api = setApi()
    render(<SafeImportPanel />)
    fireEvent.click(screen.getByTestId('safe-import-pick'))
    await waitFor(() => screen.getByTestId('safe-import-approve'))

    fireEvent.click(screen.getByTestId('safe-import-approve'))
    await waitFor(() => screen.getByTestId('safe-import-done'))

    expect(api.approveInstall).toHaveBeenCalledWith(['claude'])
    expect(screen.getByTestId('safe-import-done').textContent).toContain('claude')
    expect(api.list).toHaveBeenCalledTimes(2) // mount + refresh after install
  })

  it('unticking every target disables approve (nothing to wire into)', async () => {
    setApi()
    render(<SafeImportPanel />)
    fireEvent.click(screen.getByTestId('safe-import-pick'))
    await waitFor(() => screen.getByTestId('safe-import-approve'))

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    const claude = boxes[0]
    expect(claude.checked).toBe(true)
    fireEvent.click(claude)

    await waitFor(() => {
      expect((screen.getByTestId('safe-import-approve') as HTMLButtonElement).disabled).toBe(true)
    })
  })

  it('surfaces an install error', async () => {
    setApi({ approveInstall: vi.fn().mockResolvedValue({ success: false, error: 'config is corrupt' }) })
    render(<SafeImportPanel />)
    fireEvent.click(screen.getByTestId('safe-import-pick'))
    await waitFor(() => screen.getByTestId('safe-import-approve'))
    fireEvent.click(screen.getByTestId('safe-import-approve'))
    await waitFor(() => expect(screen.getByText('config is corrupt')).toBeTruthy())
  })

  it('lists what is already imported and revokes it', async () => {
    const api = setApi({
      list: vi.fn().mockResolvedValue({
        success: true,
        data: [{ id: 'pdf-tools', name: 'pdf-tools', kind: 'skill', riskLevel: 'green', targets: ['claude'], approvedAt: 1 }],
      }),
    })
    render(<SafeImportPanel />)
    await waitFor(() => screen.getByTestId('safe-import-list'))
    expect(screen.getByText('pdf-tools')).toBeTruthy()

    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => expect(api.revoke).toHaveBeenCalledWith('pdf-tools'))
  })
})
