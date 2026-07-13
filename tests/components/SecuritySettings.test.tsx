import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
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
    settings: { auditEnabled: false },
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
    // Deliberately still on the mock even though the bridge no longer ships it: if the component
    // ever reaches for redaction again, the assertion below catches it instead of a silent throw.
    setRedaction: vi.fn().mockResolvedValue({ success: true }),
    setAudit: vi.fn().mockResolvedValue({ success: true, data: { auditEnabled: true } }),
    setStrictGemini: vi.fn().mockResolvedValue({ success: true, data: { strictGeminiPaidOnly: true } }),
    scan: vi.fn().mockResolvedValue({ success: true, data: { hitCount: 0, hits: [], redacted: '' } }),
    recentAudit: vi.fn().mockResolvedValue({ success: true, data: [] }),
    clearAudit: vi.fn().mockResolvedValue({ success: true }),
    gitHooksList: vi.fn().mockResolvedValue({ success: true, data: [] }),
    gitHooksInstall: vi.fn().mockResolvedValue({
      success: true,
      data: { canceled: false, repo: 'C:\\repos\\demo', written: ['pre-commit', 'pre-push'] },
    }),
    gitHooksUninstall: vi.fn().mockResolvedValue({ success: true }),
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

  it('names the identifier in a manual scan hit when the rule captured one', async () => {
    ;(window as any).aiSecurity.scan = vi.fn().mockResolvedValue({
      success: true,
      data: {
        hitCount: 1,
        hits: [{ rule: 'env_secret', label: '.env-style assignment', sample: 'DB_P…2', name: 'DB_PASSWORD' }],
        redacted: '[REDACTED:env_secret]',
      },
    })
    render(<SecuritySettings />)
    const textarea = await screen.findByPlaceholderText(/Paste the prompt/)
    fireEvent.change(textarea, { target: { value: 'DB_PASSWORD=hunter2xyz' } })
    fireEvent.click(screen.getByTestId('security-scan-btn'))
    await waitFor(() => {
      expect(screen.getByText('DB_PASSWORD')).toBeInTheDocument()
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
    ;(window as any).termpolis = { ...(window as any).termpolis, clipboardReadText: vi.fn().mockResolvedValue({ success: true, data: 'AKIAIOSFODNN7EXAMPLE' }) }
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
    ;(window as any).termpolis = { ...(window as any).termpolis, clipboardReadText: vi.fn().mockRejectedValue(new Error('denied')) }
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
    const clipboardWriteText = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).termpolis = { ...(window as any).termpolis, clipboardWriteText }
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
    expect(clipboardWriteText).toHaveBeenCalledWith('[REDACTED:aws_access_key]')
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
        settings: { auditEnabled: false },
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
        settings: { auditEnabled: false, strictGeminiPaidOnly: true },
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
    // and it must not oversell the watcher as a preventative control
    expect(disclaimer.textContent).toMatch(/detects; it does not prevent/i)
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

// Prompt watching is NOT a toggle any more. The old "outbound prompt redaction" switch promised to
// strip a secret out of a prompt before the agent saw it — a promise it could not keep (it withheld
// keystrokes and never wrote them back, and a TUI agent already holds your line by the time you
// press Enter). The panel must now say, without a switch to flip, that watching is permanent and
// that it never touches your text.
describe('SecuritySettings — prompt watching is always on', () => {
  it('has NO redaction toggle, and never calls setRedaction', async () => {
    render(<SecuritySettings />)
    await screen.findByTestId('security-prompt-watch')
    expect(screen.queryByTestId('security-redaction-toggle')).toBeNull()
    expect(screen.queryByText(/Outbound prompt redaction/i)).toBeNull()
    expect((window as any).aiSecurity.setRedaction).not.toHaveBeenCalled()
  })

  it('states that watching is permanent and non-destructive', async () => {
    render(<SecuritySettings />)
    const card = await screen.findByTestId('security-prompt-watch')
    expect(card.textContent).toMatch(/always on/i)
    expect(card.textContent).toMatch(/cannot be turned off/i)
    expect(card.textContent).toMatch(/never modified, delayed, or withheld/i)
    expect(card.textContent).toMatch(/recorder, not a filter/i)
  })

  it('shows the "Secrets sent to a model" count in the panel itself, with the NAMES', async () => {
    ;(window as any).aiSecurity.getStatus = vi.fn().mockResolvedValue({
      success: true,
      data: { ...baseStatus.data, settings: { auditEnabled: true } },
    })
    ;(window as any).aiSecurity.recentAudit = vi.fn().mockResolvedValue({
      success: true,
      data: [
        {
          ts: '2026-07-12T10:00:00.000Z',
          agent: 'claude',
          event: 'prompt_secret_sent',
          hitCount: 2,
          notes: 'DB_PASSWORD (env_secret), apiKey (json_secret)',
        },
      ],
    })
    render(<SecuritySettings />)
    await waitFor(() => {
      expect(screen.getByTestId('security-secrets-sent-count').textContent).toMatch(/2 sent/)
    })
    const names = screen.getByTestId('security-secret-names')
    expect(names.textContent).toMatch(/DB_PASSWORD/)
    expect(names.textContent).toMatch(/apiKey/)
    expect(names.textContent).toMatch(/Rotate these/i)
    // red, because this is a live leak, not a clean bill of health
    expect(screen.getByTestId('security-secrets-sent-count').className).toMatch(/bg-\[#3a0d0d\]/)
  })

  it('does NOT count a code chunk as a secret sent', async () => {
    ;(window as any).aiSecurity.getStatus = vi.fn().mockResolvedValue({
      success: true,
      data: { ...baseStatus.data, settings: { auditEnabled: true } },
    })
    ;(window as any).aiSecurity.recentAudit = vi.fn().mockResolvedValue({
      success: true,
      data: [
        {
          ts: '2026-07-12T10:00:00.000Z',
          agent: 'claude',
          event: 'code_chunk_sent',
          byteCount: 40960,
          notes: 'code-chunk:indentation,punctuation',
        },
      ],
    })
    render(<SecuritySettings />)
    await waitFor(() => {
      expect(screen.getByTestId('security-secrets-sent-count').textContent).toMatch(/0 sent/)
    })
    expect(screen.queryByTestId('security-secret-names')).toBeNull()
  })

  it('refuses to show a reassuring zero while the audit log is off', async () => {
    // Watching still runs — but with nothing recorded, "0 sent" would be a claim we cannot make.
    render(<SecuritySettings />)
    const count = await screen.findByTestId('security-secrets-sent-count')
    expect(count.textContent).toMatch(/audit log off/i)
    expect(count.textContent).not.toMatch(/0 sent/)
  })
})

// The Commit Shield toggle alone only ever covered the git ops Termpolis itself runs. The
// hook panel is what extends it to `git commit` typed into a terminal — so the panel has to
// SAY that, or the user walks away believing they have protection they don't have.
describe('SecuritySettings — Commit Shield git hooks', () => {
  it('is honest about what the hooks do and do not guarantee', async () => {
    render(<SecuritySettings />)
    await waitFor(() => expect(screen.getByTestId('security-git-hooks')).toBeInTheDocument())
    const text = screen.getByTestId('security-git-hooks').textContent || ''
    expect(text).toMatch(/fails open/i)                 // never wedges git
    expect(text).toMatch(/chained, never overwritten/i) // husky survives
    expect(text).toMatch(/--no-verify/)                 // it is a net, not a cage
    expect(text).toMatch(/even with Termpolis closed/i) // the standalone scanner
  })

  it('protects a repository and reports where the hooks landed', async () => {
    render(<SecuritySettings />)
    await waitFor(() => screen.getByTestId('security-protect-repo'))

    fireEvent.click(screen.getByTestId('security-protect-repo'))

    await waitFor(() => expect((window as any).aiSecurity.gitHooksInstall).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('security-hook-msg').textContent).toMatch(/demo/))
  })

  it('lists an armed repository and can remove it', async () => {
    ;(window as any).aiSecurity.gitHooksList = vi.fn().mockResolvedValue({
      success: true,
      data: [{ repo: 'C:\repos\demo', status: { 'pre-commit': 'installed', 'pre-push': 'installed' } }],
    })
    render(<SecuritySettings />)
    await waitFor(() => screen.getByTestId('security-hook-list'))

    const list = screen.getByTestId('security-hook-list')
    expect(list.textContent).toContain('armed')

    fireEvent.click(within(list).getByText('Remove'))
    await waitFor(() =>
      expect((window as any).aiSecurity.gitHooksUninstall).toHaveBeenCalledWith('C:\repos\demo'),
    )
  })

  it('shows a repo whose hooks have gone missing as NOT armed', async () => {
    // Someone re-cloned, or ran `git init` fresh. Reporting it as protected would be a lie.
    ;(window as any).aiSecurity.gitHooksList = vi.fn().mockResolvedValue({
      success: true,
      data: [{ repo: 'C:\repos\stale', status: { 'pre-commit': 'absent', 'pre-push': 'absent' } }],
    })
    render(<SecuritySettings />)
    await waitFor(() => screen.getByTestId('security-hook-list'))
    expect(screen.getByTestId('security-hook-list').textContent).toContain('not installed')
  })

  it('surfaces an install failure instead of pretending it worked', async () => {
    ;(window as any).aiSecurity.gitHooksInstall = vi.fn().mockResolvedValue({
      success: false,
      error: 'Not a git repository — pick the folder that contains .git',
    })
    render(<SecuritySettings />)
    await waitFor(() => screen.getByTestId('security-protect-repo'))

    fireEvent.click(screen.getByTestId('security-protect-repo'))
    await waitFor(() =>
      expect(screen.getByTestId('security-hook-msg').textContent).toMatch(/Not a git repository/),
    )
  })
})

// The audit log modal. The whole risk lives in the headline: a secret in the prompt path was NOT
// stopped — it reached the provider — so the modal must never imply it was intercepted, and it must
// name what leaked so the user can rotate it. The one remaining way a zero can lie is when the log
// itself is off: watching still ran, but nothing was written down.
describe('SecuritySettings — audit log modal', () => {
  const statusWith = (settings: Record<string, boolean>) =>
    vi.fn().mockResolvedValue({ success: true, data: { ...baseStatus.data, settings } })

  const auditOf = (rows: any[]) => vi.fn().mockResolvedValue({ success: true, data: rows })

  const openModal = async (): Promise<void> => {
    render(<SecuritySettings />)
    await waitFor(() => screen.getByTestId('security-open-audit'))
    fireEvent.click(screen.getByTestId('security-open-audit'))
    await waitFor(() => screen.getByTestId('audit-verdict'))
  }

  it('opens the audit log in a modal from the watchers panel', async () => {
    render(<SecuritySettings />)
    await waitFor(() => screen.getByTestId('security-open-audit'))
    fireEvent.click(screen.getByTestId('security-open-audit'))
    await waitFor(() => expect(screen.getByTestId('audit-log-modal')).toBeInTheDocument())
  })

  it('reports a secret as SENT, names it, and never claims it was intercepted', async () => {
    ;(window as any).aiSecurity.getStatus = statusWith({ auditEnabled: true })
    ;(window as any).aiSecurity.recentAudit = auditOf([
      {
        ts: new Date().toISOString(),
        agent: 'claude',
        event: 'prompt_secret_sent',
        hitCount: 3,
        notes: 'DB_PASSWORD (env_secret), apiKey (json_secret)',
      },
    ])
    await openModal()

    const verdict = screen.getByTestId('audit-verdict').textContent || ''
    expect(verdict).toMatch(/3 secrets sent to a model/i)
    expect(verdict).toMatch(/rotate/i)
    expect(verdict).not.toMatch(/redacted/i)
    expect(verdict).not.toMatch(/never received/i)

    // THE ACTIONABLE PART: the identifier, front and centre.
    const names = screen.getByTestId('audit-secret-names')
    expect(names.textContent).toMatch(/DB_PASSWORD/)
    expect(names.textContent).toMatch(/apiKey/)
    expect(names.textContent).toMatch(/never the value/i)

    expect(screen.getByTestId('audit-rows').textContent).toMatch(/SECRET SENT to a model/)
  })

  it('does not count a code_chunk_sent as a secret, but does show it', async () => {
    ;(window as any).aiSecurity.getStatus = statusWith({ auditEnabled: true })
    ;(window as any).aiSecurity.recentAudit = auditOf([
      {
        ts: new Date().toISOString(),
        agent: 'claude',
        event: 'code_chunk_sent',
        byteCount: 40960,
        notes: 'code-chunk:indentation,punctuation',
      },
    ])
    await openModal()

    expect(screen.getByTestId('audit-verdict').textContent).toMatch(/No secret has reached a model/i)
    expect(screen.queryByTestId('audit-secret-names')).toBeNull()
    const counts = screen.getByTestId('audit-counts').textContent || ''
    expect(counts).toMatch(/Code chunks sent/)
    expect(screen.getByTestId('audit-rows').textContent).toMatch(/Code chunk sent to a model/)
  })

  it('says clean when the log is recording and nothing was found', async () => {
    ;(window as any).aiSecurity.getStatus = statusWith({ auditEnabled: true })
    ;(window as any).aiSecurity.recentAudit = auditOf([
      { ts: new Date().toISOString(), agent: 'claude', event: 'terminal_open' },
    ])
    await openModal()
    expect(screen.getByTestId('audit-verdict').textContent).toMatch(/No secret has reached a model/i)
  })

  it('REFUSES to claim clean when nothing is being recorded', async () => {
    ;(window as any).aiSecurity.getStatus = statusWith({ auditEnabled: false })
    ;(window as any).aiSecurity.recentAudit = auditOf([
      { ts: new Date().toISOString(), agent: 'claude', event: 'terminal_open' },
    ])
    await openModal()

    const verdict = screen.getByTestId('audit-verdict').textContent || ''
    expect(verdict).toMatch(/nothing is being recorded/i)
    expect(verdict).toMatch(/no record was kept/i)
    expect(verdict).not.toMatch(/no secret has reached a model/i) // the dangerous sentence
    expect(screen.getByTestId('audit-coverage').textContent).toMatch(/Recording: OFF/)
  })

  it('never renders prompt watching as a boolean chip — it says it is always on', async () => {
    ;(window as any).aiSecurity.getStatus = statusWith({ auditEnabled: true })
    await openModal()

    const coverage = screen.getByTestId('audit-coverage').textContent || ''
    expect(coverage).not.toMatch(/Prompt scanning/i) // a chip implies it could read OFF

    const banner = screen.getByTestId('audit-watch-always-on').textContent || ''
    expect(banner).toMatch(/always on and cannot be turned off/i)
    expect(banner).toMatch(/unmodified/i)
    expect(banner).toMatch(/recorded/i)
  })

  it('filters to only the security findings, then closes', async () => {
    ;(window as any).aiSecurity.getStatus = statusWith({ auditEnabled: true })
    ;(window as any).aiSecurity.recentAudit = auditOf([
      { ts: new Date().toISOString(), agent: 'claude', event: 'terminal_open' },
      { ts: new Date().toISOString(), agent: 'codex', event: 'commit_blocked', hitCount: 1 },
    ])
    await openModal()
    await waitFor(() => screen.getByTestId('audit-rows'))

    fireEvent.click(screen.getByTestId('audit-only-notable'))
    await waitFor(() => {
      const rows = screen.getByTestId('audit-rows').textContent || ''
      expect(rows).toMatch(/Commit blocked/)
      expect(rows).not.toMatch(/Terminal opened/)
    })

    fireEvent.click(screen.getByTestId('audit-close'))
    await waitFor(() => expect(screen.queryByTestId('audit-log-modal')).toBeNull())
  })
})
