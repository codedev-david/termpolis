import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const baseFacts = [
  {
    agentId: 'claude',
    agentName: 'Claude Code',
    trainingOptOut: 'default-off',
    retentionDays: 30,
    privacyDocUrl: 'https://www.anthropic.com/legal/commercial-terms',
    consoleUrl: 'https://console.anthropic.com/settings/privacy',
    notes: 'Commercial Terms exclude inputs from training.',
  },
  {
    agentId: 'gemini',
    agentName: 'Gemini CLI',
    trainingOptOut: 'opt-out-required',
    retentionDays: 'configurable',
    privacyDocUrl: 'https://ai.google.dev/gemini-api/terms',
    consoleUrl: 'https://aistudio.google.com/app/apikey',
    notes: 'Free tier may use prompts to improve products unless paid.',
  },
]

const baseStatus = {
  success: true,
  data: {
    settings: { redactionEnabled: false, auditEnabled: false },
    facts: baseFacts,
    auditPath: '/tmp/audit.jsonl',
    geminiAccount: {
      mode: 'free-oauth' as const,
      safeForTraining: false,
      evidence: ['No paid-tier env vars detected'],
      recommendation: 'WARNING: Free-tier OAuth login. Google may use your prompts.',
    },
  },
}

beforeEach(() => {
  ;(window as any).aiSecurity = {
    getStatus: vi.fn().mockResolvedValue(baseStatus),
    setRedaction: vi.fn().mockResolvedValue({ success: true, data: { redactionEnabled: true, auditEnabled: false } }),
    setAudit: vi.fn().mockResolvedValue({ success: true, data: { redactionEnabled: false, auditEnabled: true } }),
    setStrictGemini: vi.fn().mockResolvedValue({ success: true, data: { strictGeminiPaidOnly: true } }),
    scan: vi.fn().mockResolvedValue({ success: true, data: { hitCount: 0, hits: [], redacted: '' } }),
    recentAudit: vi.fn().mockResolvedValue({ success: true, data: [] }),
    clearAudit: vi.fn().mockResolvedValue({ success: true }),
  }
})

import { SecuritySettings } from '../../src/renderer/src/components/SettingsPane/SecuritySettings'

describe('SecuritySettings', () => {
  it('renders the headline pitch', async () => {
    render(<SecuritySettings />)
    await waitFor(() => {
      expect(screen.getByText(/AI-Assisted Development with Source-Code Safety/i)).toBeInTheDocument()
    })
  })

  it('lists per-agent facts pulled from main', async () => {
    render(<SecuritySettings />)
    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeInTheDocument()
      expect(screen.getByText('Gemini CLI')).toBeInTheDocument()
    })
  })

  it('shows green badge for default-off agents', async () => {
    render(<SecuritySettings />)
    await waitFor(() => {
      expect(screen.getByText(/No training/i)).toBeInTheDocument()
    })
  })

  it('shows yellow opt-out badge for Gemini', async () => {
    render(<SecuritySettings />)
    await waitFor(() => {
      expect(screen.getByText(/Opt-out required/i)).toBeInTheDocument()
    })
  })

  it('toggles redaction via IPC', async () => {
    render(<SecuritySettings />)
    const toggle = await screen.findByTestId('security-redaction-toggle')
    fireEvent.click(toggle)
    await waitFor(() => {
      expect((window as any).aiSecurity.setRedaction).toHaveBeenCalledWith(true)
    })
  })

  it('toggles audit via IPC', async () => {
    render(<SecuritySettings />)
    const toggle = await screen.findByTestId('security-audit-toggle')
    fireEvent.click(toggle)
    await waitFor(() => {
      expect((window as any).aiSecurity.setAudit).toHaveBeenCalledWith(true)
    })
  })

  it('runs a scan and surfaces hit count', async () => {
    ;(window as any).aiSecurity.scan = vi.fn().mockResolvedValue({
      success: true,
      data: {
        hitCount: 1,
        hits: [{ rule: 'aws_access_key', label: 'AWS Access Key ID', sample: 'AKIA…LE' }],
        redacted: '[REDACTED:aws_access_key]',
      },
    })
    render(<SecuritySettings />)
    const textarea = await screen.findByPlaceholderText(/Paste the prompt/)
    fireEvent.change(textarea, { target: { value: 'AKIAIOSFODNN7EXAMPLE' } })
    fireEvent.click(screen.getByTestId('security-scan-btn'))
    await waitFor(() => {
      expect(screen.getByText(/1 secret detected/i)).toBeInTheDocument()
    })
  })

  it('shows "No secrets detected" when scan is clean', async () => {
    ;(window as any).aiSecurity.scan = vi.fn().mockResolvedValue({
      success: true,
      data: { hitCount: 0, hits: [], redacted: 'hello' },
    })
    render(<SecuritySettings />)
    const textarea = await screen.findByPlaceholderText(/Paste the prompt/)
    fireEvent.change(textarea, { target: { value: 'hello' } })
    fireEvent.click(screen.getByTestId('security-scan-btn'))
    await waitFor(() => {
      expect(screen.getByText(/No secrets detected/i)).toBeInTheDocument()
    })
  })

  it('renders the Termpolis self-disclosures list', async () => {
    render(<SecuritySettings />)
    await waitFor(() => {
      expect(screen.getByText(/Zero accounts/i)).toBeInTheDocument()
      expect(screen.getByText(/MCP server: 127\.0\.0\.1 only/i)).toBeInTheDocument()
      expect(screen.getByText(/No browser or IDE extension/i)).toBeInTheDocument()
    })
  })

  it('refreshes audit entries when audit is toggled on', async () => {
    ;(window as any).aiSecurity.recentAudit = vi.fn().mockResolvedValue({
      success: true,
      data: [{ ts: new Date().toISOString(), agent: 'claude', event: 'terminal_open', byteCount: 12 }],
    })
    ;(window as any).aiSecurity.setAudit = vi.fn().mockResolvedValue({
      success: true,
      data: { redactionEnabled: false, auditEnabled: true },
    })
    render(<SecuritySettings />)
    const toggle = await screen.findByTestId('security-audit-toggle')
    fireEvent.click(toggle)
    await waitFor(() => {
      expect((window as any).aiSecurity.recentAudit).toHaveBeenCalled()
    })
  })

  it('handles missing aiSecurity bridge gracefully', async () => {
    ;(window as any).aiSecurity = undefined
    expect(() => render(<SecuritySettings />)).not.toThrow()
  })

  it('shows loading state before status returns', () => {
    let resolve: (v: any) => void = () => {}
    ;(window as any).aiSecurity.getStatus = vi.fn(() => new Promise(r => { resolve = r }))
    render(<SecuritySettings />)
    expect(screen.getByText(/Loading security status/i)).toBeInTheDocument()
    resolve(baseStatus)
  })

  it('handles getStatus rejection without crashing', async () => {
    ;(window as any).aiSecurity.getStatus = vi.fn().mockRejectedValue(new Error('boom'))
    render(<SecuritySettings />)
    await waitFor(() => {
      expect(screen.queryByText(/Loading security status/i)).not.toBeInTheDocument()
    })
  })

  it('runScan is a no-op when textarea is empty', async () => {
    render(<SecuritySettings />)
    await screen.findByPlaceholderText(/Paste the prompt/)
    fireEvent.click(screen.getByTestId('security-scan-btn'))
    await new Promise(r => setTimeout(r, 10))
    expect((window as any).aiSecurity.scan).not.toHaveBeenCalled()
  })

  it('scan clipboard pulls from clipboard and triggers scan', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: vi.fn().mockResolvedValue('AKIAIOSFODNN7EXAMPLE') },
      configurable: true,
    })
    ;(window as any).aiSecurity.scan = vi.fn().mockResolvedValue({
      success: true,
      data: { hitCount: 1, hits: [{ rule: 'aws_access_key', label: 'AWS', sample: 'AK…E' }], redacted: '[REDACTED]' },
    })
    render(<SecuritySettings />)
    await screen.findByPlaceholderText(/Paste the prompt/)
    fireEvent.click(screen.getByText('Scan clipboard'))
    await waitFor(() => {
      expect((window as any).aiSecurity.scan).toHaveBeenCalledWith('AKIAIOSFODNN7EXAMPLE')
    })
    await waitFor(() => {
      expect(screen.getByText(/1 secret detected/i)).toBeInTheDocument()
    })
  })

  it('scan clipboard swallows clipboard errors', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    })
    render(<SecuritySettings />)
    await screen.findByPlaceholderText(/Paste the prompt/)
    expect(() => fireEvent.click(screen.getByText('Scan clipboard'))).not.toThrow()
  })

  it('opens privacy doc links via window.open', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<SecuritySettings />)
    const links = await screen.findAllByText(/Privacy \/ ToS source/i)
    fireEvent.click(links[0])
    expect(open).toHaveBeenCalledWith(baseFacts[0].privacyDocUrl, '_blank')
    open.mockRestore()
  })

  it('opens console links via window.open', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<SecuritySettings />)
    const links = await screen.findAllByText(/Provider data console/i)
    fireEvent.click(links[1])
    expect(open).toHaveBeenCalledWith(baseFacts[1].consoleUrl, '_blank')
    open.mockRestore()
  })

  it('clears audit when confirmed', async () => {
    ;(window as any).aiSecurity.recentAudit = vi.fn().mockResolvedValue({
      success: true,
      data: [{ ts: new Date().toISOString(), agent: 'claude', event: 'terminal_open' }],
    })
    ;(window as any).aiSecurity.setAudit = vi.fn().mockResolvedValue({
      success: true,
      data: { redactionEnabled: false, auditEnabled: true },
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<SecuritySettings />)
    fireEvent.click(await screen.findByTestId('security-audit-toggle'))
    const clearBtn = await screen.findByText(/Clear log/i)
    fireEvent.click(clearBtn)
    await waitFor(() => {
      expect((window as any).aiSecurity.clearAudit).toHaveBeenCalled()
    })
    confirmSpy.mockRestore()
  })

  it('skips clearing audit when confirm is declined', async () => {
    ;(window as any).aiSecurity.recentAudit = vi.fn().mockResolvedValue({
      success: true,
      data: [{ ts: new Date().toISOString(), agent: 'claude', event: 'terminal_open' }],
    })
    ;(window as any).aiSecurity.setAudit = vi.fn().mockResolvedValue({
      success: true,
      data: { redactionEnabled: false, auditEnabled: true },
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<SecuritySettings />)
    fireEvent.click(await screen.findByTestId('security-audit-toggle'))
    const clearBtn = await screen.findByText(/Clear log/i)
    fireEvent.click(clearBtn)
    await new Promise(r => setTimeout(r, 10))
    expect((window as any).aiSecurity.clearAudit).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('Refresh button re-fetches recent audit entries', async () => {
    ;(window as any).aiSecurity.setAudit = vi.fn().mockResolvedValue({
      success: true,
      data: { redactionEnabled: false, auditEnabled: true },
    })
    const recent = vi.fn().mockResolvedValue({ success: true, data: [] })
    ;(window as any).aiSecurity.recentAudit = recent
    render(<SecuritySettings />)
    fireEvent.click(await screen.findByTestId('security-audit-toggle'))
    await screen.findByText(/Recent entries/i)
    recent.mockClear()
    fireEvent.click(screen.getByText('Refresh'))
    await waitFor(() => expect(recent).toHaveBeenCalled())
  })

  it('renders audit table rows when entries are present', async () => {
    ;(window as any).aiSecurity.setAudit = vi.fn().mockResolvedValue({
      success: true,
      data: { redactionEnabled: false, auditEnabled: true },
    })
    ;(window as any).aiSecurity.recentAudit = vi.fn().mockResolvedValue({
      success: true,
      data: [
        { ts: '2026-05-05T12:00:00.000Z', agent: 'claude', event: 'terminal_open', byteCount: 12, hitCount: 0 },
        { ts: '2026-05-05T12:05:00.000Z', agent: 'codex', event: 'terminal_close', notes: 'closed' },
      ],
    })
    render(<SecuritySettings />)
    fireEvent.click(await screen.findByTestId('security-audit-toggle'))
    await waitFor(() => {
      expect(screen.getByText('claude')).toBeInTheDocument()
      expect(screen.getByText('codex')).toBeInTheDocument()
    })
  })

  it('"Copy redacted" button calls clipboard.writeText with redacted preview', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText, readText: vi.fn().mockResolvedValue('') },
      configurable: true,
    })
    ;(window as any).aiSecurity.scan = vi.fn().mockResolvedValue({
      success: true,
      data: { hitCount: 1, hits: [{ rule: 'aws_access_key', label: 'AWS', sample: 'AK…E' }], redacted: '[REDACTED:aws_access_key]' },
    })
    render(<SecuritySettings />)
    const textarea = await screen.findByPlaceholderText(/Paste the prompt/)
    fireEvent.change(textarea, { target: { value: 'AKIAIOSFODNN7EXAMPLE' } })
    fireEvent.click(screen.getByTestId('security-scan-btn'))
    await screen.findByText(/1 secret detected/i)
    fireEvent.click(screen.getByText(/Copy redacted/i))
    expect(writeText).toHaveBeenCalledWith('[REDACTED:aws_access_key]')
  })

  it('renders the Gemini account status block with free-oauth warning by default', async () => {
    render(<SecuritySettings />)
    const block = await screen.findByTestId('gemini-account-status')
    expect(block).toBeInTheDocument()
    expect(block.textContent).toMatch(/Free personal OAuth/i)
    expect(block.textContent).toMatch(/UNSAFE/i)
    expect(block.textContent).toMatch(/WARNING/i)
  })

  it('renders Vertex paid badge when geminiAccount.mode is paid-vertex', async () => {
    ;(window as any).aiSecurity.getStatus = vi.fn().mockResolvedValue({
      success: true,
      data: {
        ...baseStatus.data,
        geminiAccount: {
          mode: 'paid-vertex',
          safeForTraining: true,
          evidence: ['GOOGLE_APPLICATION_CREDENTIALS + GOOGLE_CLOUD_PROJECT set'],
          recommendation: 'Vertex AI / service-account credentials detected.',
        },
      },
    })
    render(<SecuritySettings />)
    const block = await screen.findByTestId('gemini-account-status')
    expect(block.textContent).toMatch(/Vertex AI \(paid\)/i)
    expect(block.textContent).toMatch(/Vertex AI \/ service-account/i)
  })

  it('renders Code Assist paid badge when mode is paid-code-assist', async () => {
    ;(window as any).aiSecurity.getStatus = vi.fn().mockResolvedValue({
      success: true,
      data: {
        ...baseStatus.data,
        geminiAccount: {
          mode: 'paid-code-assist',
          safeForTraining: true,
          evidence: ['GOOGLE_GENAI_USE_GCA=true'],
          recommendation: 'Gemini Code Assist license detected.',
        },
      },
    })
    render(<SecuritySettings />)
    const block = await screen.findByTestId('gemini-account-status')
    expect(block.textContent).toMatch(/Code Assist \(paid\)/i)
  })

  it('renders paid AI Studio API key badge', async () => {
    ;(window as any).aiSecurity.getStatus = vi.fn().mockResolvedValue({
      success: true,
      data: {
        ...baseStatus.data,
        geminiAccount: {
          mode: 'paid-api-key',
          safeForTraining: true,
          evidence: ['GEMINI_API_KEY set'],
          recommendation: 'Paid Gemini API key detected.',
        },
      },
    })
    render(<SecuritySettings />)
    const block = await screen.findByTestId('gemini-account-status')
    expect(block.textContent).toMatch(/Paid AI Studio API key/i)
  })

  it('renders unknown gemini mode without crashing', async () => {
    ;(window as any).aiSecurity.getStatus = vi.fn().mockResolvedValue({
      success: true,
      data: {
        ...baseStatus.data,
        geminiAccount: {
          mode: 'unknown',
          safeForTraining: false,
          evidence: [],
          recommendation: 'No determination possible.',
        },
      },
    })
    render(<SecuritySettings />)
    const block = await screen.findByTestId('gemini-account-status')
    expect(block.textContent).toMatch(/Unknown/i)
  })

  it('omits the gemini block when status omits geminiAccount', async () => {
    ;(window as any).aiSecurity.getStatus = vi.fn().mockResolvedValue({
      success: true,
      data: {
        settings: { redactionEnabled: false, auditEnabled: false },
        facts: baseFacts,
        auditPath: '/tmp/audit.jsonl',
      },
    })
    render(<SecuritySettings />)
    await screen.findByText(/AI-Assisted Development with Source-Code Safety/i)
    expect(screen.queryByTestId('gemini-account-status')).not.toBeInTheDocument()
  })

  it('toggles strict-gemini mode via IPC', async () => {
    render(<SecuritySettings />)
    const toggle = await screen.findByTestId('security-strict-gemini-toggle')
    fireEvent.click(toggle)
    await waitFor(() => {
      expect((window as any).aiSecurity.setStrictGemini).toHaveBeenCalledWith(true)
    })
  })

  it('strict-gemini toggle is a no-op when bridge omits the method', async () => {
    delete (window as any).aiSecurity.setStrictGemini
    render(<SecuritySettings />)
    const toggle = await screen.findByTestId('security-strict-gemini-toggle')
    expect(() => fireEvent.click(toggle)).not.toThrow()
  })

  it('reflects persisted strict-gemini state on load', async () => {
    ;(window as any).aiSecurity.getStatus = vi.fn().mockResolvedValue({
      success: true,
      data: {
        ...baseStatus.data,
        settings: { redactionEnabled: false, auditEnabled: false, strictGeminiPaidOnly: true },
      },
    })
    render(<SecuritySettings />)
    const toggle = await screen.findByTestId('security-strict-gemini-toggle')
    // Red bg indicates ON
    expect(toggle.className).toMatch(/bg-\[#dc2626\]/)
  })

  it('renders the legal disclaimer with key phrases', async () => {
    render(<SecuritySettings />)
    const disclaimer = await screen.findByTestId('security-legal-disclaimer')
    expect(disclaimer).toBeInTheDocument()
    expect(disclaimer.textContent).toMatch(/AS IS/i)
    expect(disclaimer.textContent).toMatch(/disclaim all liability/i)
    expect(disclaimer.textContent).toMatch(/Apache License 2\.0/i)
  })

  it('renders the Background watchers card', async () => {
    render(<SecuritySettings />)
    const card = await screen.findByTestId('security-watchers')
    expect(card).toBeInTheDocument()
    expect(card.textContent).toMatch(/Sensitive-file read watcher/i)
    expect(card.textContent).toMatch(/Per-agent egress audit/i)
  })

  it('shows zero recent matches when no sensitive-file events are present', async () => {
    render(<SecuritySettings />)
    const badge = await screen.findByTestId('security-sensitive-file-count')
    expect(badge.textContent).toMatch(/0 recent matches/)
    expect(badge.className).toMatch(/bg-\[#0d3a1a\]/)
  })

  it('counts sensitive_file_read events from the audit log', async () => {
    ;(window as any).aiSecurity.setAudit = vi.fn().mockResolvedValue({
      success: true,
      data: { redactionEnabled: false, auditEnabled: true },
    })
    ;(window as any).aiSecurity.recentAudit = vi.fn().mockResolvedValue({
      success: true,
      data: [
        { ts: '2026-05-09T12:00:00.000Z', agent: 'claude', event: 'sensitive_file_read', notes: '/home/u/.env' },
        { ts: '2026-05-09T12:01:00.000Z', agent: 'codex', event: 'sensitive_file_read', notes: '/home/u/.aws/credentials' },
        { ts: '2026-05-09T12:02:00.000Z', agent: 'gemini', event: 'terminal_open', byteCount: 12 },
      ],
    })
    render(<SecuritySettings />)
    fireEvent.click(await screen.findByTestId('security-audit-toggle'))
    await waitFor(() => {
      const badge = screen.getByTestId('security-sensitive-file-count')
      expect(badge.textContent).toMatch(/2 recent matches/)
      expect(badge.className).toMatch(/bg-\[#3a2a0d\]/)
    })
  })

  it('lists up to 5 recent sensitive-file matches with agent + path', async () => {
    ;(window as any).aiSecurity.setAudit = vi.fn().mockResolvedValue({
      success: true,
      data: { redactionEnabled: false, auditEnabled: true },
    })
    ;(window as any).aiSecurity.recentAudit = vi.fn().mockResolvedValue({
      success: true,
      data: [
        { ts: '2026-05-09T12:00:00.000Z', agent: 'claude', event: 'sensitive_file_read', notes: '/home/u/.env.production' },
      ],
    })
    render(<SecuritySettings />)
    fireEvent.click(await screen.findByTestId('security-audit-toggle'))
    await waitFor(() => {
      const card = screen.getByTestId('security-watchers')
      expect(card.textContent).toMatch(/claude/)
      expect(card.textContent).toMatch(/\.env\.production/)
    })
  })
})
