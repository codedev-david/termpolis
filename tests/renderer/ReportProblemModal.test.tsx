import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ReportProblemModal, buildIssueUrl } from '../../src/renderer/src/components/StatusBar/ReportProblemModal'

const fakeDiagnostics = {
  appVersion: '1.11.15',
  platform: 'darwin',
  osRelease: '24.0.0',
  arch: 'arm64',
  electronVersion: '34.0.0',
  nodeVersion: '22.12.0',
  chromeVersion: '132.0.0',
}

describe('buildIssueUrl', () => {
  it('produces a GitHub new-issue URL with title, body, and labels', () => {
    const url = buildIssueUrl({
      title: 'Crash on startup',
      description: 'It crashed.',
      diagnostics: fakeDiagnostics,
    })
    const parsed = new URL(url)
    expect(parsed.origin).toBe('https://github.com')
    expect(parsed.pathname).toBe('/codedev-david/termpolis/issues/new')
    expect(parsed.searchParams.get('title')).toBe('Crash on startup')
    expect(parsed.searchParams.get('labels')).toBe('bug,user-report')
    expect(parsed.searchParams.get('body')).toContain('It crashed.')
    expect(parsed.searchParams.get('body')).toContain('App version:     1.11.15')
  })

  it('substitutes placeholder when description is empty', () => {
    const url = buildIssueUrl({ title: 'Title', description: '', diagnostics: null })
    const body = new URL(url).searchParams.get('body') || ''
    expect(body).toContain('_(no description provided)_')
    expect(body).toContain('_(diagnostics omitted by reporter)_')
  })

  it('trims title and description whitespace', () => {
    const url = buildIssueUrl({ title: '  spaced  ', description: '   ', diagnostics: null })
    expect(new URL(url).searchParams.get('title')).toBe('spaced')
    expect(new URL(url).searchParams.get('body') || '').toContain('_(no description provided)_')
  })

  it('omits diagnostics block when diagnostics is null', () => {
    const url = buildIssueUrl({ title: 'T', description: 'd', diagnostics: null })
    const body = new URL(url).searchParams.get('body') || ''
    expect(body).not.toContain('App version')
    expect(body).toContain('_(diagnostics omitted by reporter)_')
  })
})

describe('ReportProblemModal', () => {
  let openExternal: ReturnType<typeof vi.fn>
  let collectDiagnostics: ReturnType<typeof vi.fn>

  beforeEach(() => {
    openExternal = vi.fn().mockResolvedValue({ success: true })
    collectDiagnostics = vi.fn().mockResolvedValue({ success: true, data: fakeDiagnostics })
    ;(window as any).termpolis = {
      openExternal,
      collectDiagnostics,
    }
  })

  afterEach(() => {
    ;(window as any).termpolis = undefined
  })

  it('renders with title input focused and submit disabled until title entered', async () => {
    render(<ReportProblemModal onClose={vi.fn()} />)
    expect(screen.getByTestId('report-problem-modal')).toBeInTheDocument()
    expect(screen.getByTestId('report-submit')).toBeDisabled()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('report-title-input')))
  })

  it('enables submit once a non-whitespace title is entered', async () => {
    const user = userEvent.setup()
    render(<ReportProblemModal onClose={vi.fn()} />)
    await user.type(screen.getByTestId('report-title-input'), 'Terminal freezes')
    expect(screen.getByTestId('report-submit')).toBeEnabled()
  })

  it('opens the pre-filled URL via openExternal and closes on success', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ReportProblemModal onClose={onClose} />)
    await user.type(screen.getByTestId('report-title-input'), 'Split view crash')
    await user.type(screen.getByTestId('report-description-input'), 'Clicked split, app froze.')
    await waitFor(() => expect(screen.getByTestId('report-diagnostics-preview')).toBeInTheDocument())

    await user.click(screen.getByTestId('report-submit'))

    await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    const urlArg = openExternal.mock.calls[0][0] as string
    const body = new URL(urlArg).searchParams.get('body') || ''
    expect(new URL(urlArg).searchParams.get('title')).toBe('Split view crash')
    expect(body).toContain('Clicked split, app froze.')
    expect(body).toContain('App version:     1.11.15')
    expect(onClose).toHaveBeenCalled()
  })

  it('omits diagnostics when checkbox is unchecked', async () => {
    const user = userEvent.setup()
    render(<ReportProblemModal onClose={vi.fn()} />)
    await user.type(screen.getByTestId('report-title-input'), 'T')
    await waitFor(() => expect(screen.getByTestId('report-diagnostics-preview')).toBeInTheDocument())
    await user.click(screen.getByTestId('report-include-diagnostics'))
    expect(screen.queryByTestId('report-diagnostics-preview')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('report-submit'))
    await waitFor(() => expect(openExternal).toHaveBeenCalled())
    const body = new URL(openExternal.mock.calls[0][0] as string).searchParams.get('body') || ''
    expect(body).toContain('_(diagnostics omitted by reporter)_')
    expect(body).not.toContain('App version')
  })

  it('shows an error and keeps modal open if openExternal fails', async () => {
    openExternal.mockResolvedValueOnce({ success: false, error: 'protocol disallowed' })
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ReportProblemModal onClose={onClose} />)
    await user.type(screen.getByTestId('report-title-input'), 'T')
    await user.click(screen.getByTestId('report-submit'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/protocol disallowed/))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    render(<ReportProblemModal onClose={onClose} />)
    fireEvent.keyDown(screen.getByTestId('report-problem-modal'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('submits on Ctrl+Enter when title is valid', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ReportProblemModal onClose={onClose} />)
    await user.type(screen.getByTestId('report-title-input'), 'quick submit')
    fireEvent.keyDown(screen.getByTestId('report-problem-modal'), { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(openExternal).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
  })

  it('falls back to window.open when openExternal is unavailable', async () => {
    ;(window as any).termpolis = { collectDiagnostics }
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null as any)
    const user = userEvent.setup()
    render(<ReportProblemModal onClose={vi.fn()} />)
    await user.type(screen.getByTestId('report-title-input'), 'Fallback')
    await user.click(screen.getByTestId('report-submit'))
    await waitFor(() => expect(openSpy).toHaveBeenCalled())
    expect(openSpy.mock.calls[0][0]).toContain('github.com/codedev-david/termpolis/issues/new')
    openSpy.mockRestore()
  })

  it('tolerates missing collectDiagnostics — submit still works', async () => {
    ;(window as any).termpolis = { openExternal }
    const user = userEvent.setup()
    render(<ReportProblemModal onClose={vi.fn()} />)
    await user.type(screen.getByTestId('report-title-input'), 'no diag')
    await user.click(screen.getByTestId('report-submit'))
    await waitFor(() => expect(openExternal).toHaveBeenCalled())
    const body = new URL(openExternal.mock.calls[0][0] as string).searchParams.get('body') || ''
    expect(body).toContain('_(diagnostics omitted by reporter)_')
  })

  it('disables submit when title exceeds max length', async () => {
    const user = userEvent.setup()
    render(<ReportProblemModal onClose={vi.fn()} />)
    const input = screen.getByTestId('report-title-input') as HTMLInputElement
    // Force-set via change event because maxLength on the input caps typing.
    const longTitle = 'x'.repeat(200)
    fireEvent.change(input, { target: { value: longTitle } })
    expect(screen.getByTestId('report-submit')).toBeDisabled()
  })

  it('disables submit when description exceeds max length', async () => {
    const user = userEvent.setup()
    render(<ReportProblemModal onClose={vi.fn()} />)
    await user.type(screen.getByTestId('report-title-input'), 'OK title')
    const ta = screen.getByTestId('report-description-input') as HTMLTextAreaElement
    const huge = 'a'.repeat(5000)
    fireEvent.change(ta, { target: { value: huge } })
    expect(screen.getByTestId('report-submit')).toBeDisabled()
  })

  it('points the reporter at the app log, and says secrets are already redacted', () => {
    render(<ReportProblemModal onClose={vi.fn()} />)
    const hint = screen.getByTestId('report-app-log-hint')
    expect(hint).toHaveTextContent('Ctrl+Shift+O')
    expect(hint).toHaveTextContent(/API keys and tokens are redacted/)
  })
})

// Diagnostics collection is a best-effort IPC call. Every failure shape has to leave
// the reporter usable — a user who cannot file the bug because the diagnostics probe
// died is strictly worse off than one who files it without a System block.

describe('ReportProblemModal — diagnostics collection failures', () => {
  let openExternal: ReturnType<typeof vi.fn>

  beforeEach(() => {
    openExternal = vi.fn().mockResolvedValue({ success: true })
  })

  afterEach(() => {
    ;(window as any).termpolis = undefined
  })

  async function fileIssue(title: string): Promise<string> {
    const user = userEvent.setup()
    await user.type(screen.getByTestId('report-title-input'), title)
    await user.click(screen.getByTestId('report-submit'))
    await waitFor(() => expect(openExternal).toHaveBeenCalled())
    return new URL(openExternal.mock.calls[0][0] as string).searchParams.get('body') || ''
  }

  it('survives a rejected collectDiagnostics and still lets the user file the issue', async () => {
    const collectDiagnostics = vi.fn().mockRejectedValue(new Error('ipc bridge down'))
    ;(window as any).termpolis = { openExternal, collectDiagnostics }
    render(<ReportProblemModal onClose={vi.fn()} />)
    await waitFor(() => expect(collectDiagnostics).toHaveBeenCalled())
    expect(screen.queryByTestId('report-diagnostics-preview')).not.toBeInTheDocument()
    expect(await fileIssue('diagnostics blew up')).toContain('_(diagnostics omitted by reporter)_')
  })

  it('ignores an unsuccessful diagnostics response even when it carries data', async () => {
    const collectDiagnostics = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'denied', data: fakeDiagnostics })
    ;(window as any).termpolis = { openExternal, collectDiagnostics }
    render(<ReportProblemModal onClose={vi.fn()} />)
    await waitFor(() => expect(collectDiagnostics).toHaveBeenCalled())
    expect(screen.queryByTestId('report-diagnostics-preview')).not.toBeInTheDocument()
    const body = await fileIssue('denied diag')
    expect(body).toContain('_(diagnostics omitted by reporter)_')
    expect(body).not.toContain('App version')
  })

  it('ignores a successful diagnostics response that carries no payload', async () => {
    const collectDiagnostics = vi.fn().mockResolvedValue({ success: true, data: null })
    ;(window as any).termpolis = { openExternal, collectDiagnostics }
    render(<ReportProblemModal onClose={vi.fn()} />)
    await waitFor(() => expect(collectDiagnostics).toHaveBeenCalled())
    expect(screen.queryByTestId('report-diagnostics-preview')).not.toBeInTheDocument()
    expect(await fileIssue('empty diag')).toContain('_(diagnostics omitted by reporter)_')
  })

  it('ignores a diagnostics call that resolves nothing at all', async () => {
    const collectDiagnostics = vi.fn().mockResolvedValue(undefined)
    ;(window as any).termpolis = { openExternal, collectDiagnostics }
    render(<ReportProblemModal onClose={vi.fn()} />)
    await waitFor(() => expect(collectDiagnostics).toHaveBeenCalled())
    expect(screen.queryByTestId('report-diagnostics-preview')).not.toBeInTheDocument()
    expect(await fileIssue('void diag')).toContain('_(diagnostics omitted by reporter)_')
  })
})

describe('ReportProblemModal — submit guards and browser-open failures', () => {
  let openExternal: ReturnType<typeof vi.fn>

  beforeEach(() => {
    openExternal = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).termpolis = { openExternal }
  })

  afterEach(() => {
    ;(window as any).termpolis = undefined
  })

  function typeTitle(value: string) {
    fireEvent.change(screen.getByTestId('report-title-input'), { target: { value } })
  }

  it('Ctrl+Enter does nothing while the title is still empty', () => {
    // The button is disabled, but the keyboard shortcut bypasses it — handleSubmit
    // has to re-check validity itself or a titleless issue reaches GitHub.
    const onClose = vi.fn()
    render(<ReportProblemModal onClose={onClose} />)
    fireEvent.keyDown(screen.getByTestId('report-problem-modal'), { key: 'Enter', ctrlKey: true })
    expect(openExternal).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('report-problem-modal')).toBeInTheDocument()
  })

  it('Ctrl+Enter is also refused when the description is over the cap', () => {
    render(<ReportProblemModal onClose={vi.fn()} />)
    typeTitle('valid title')
    fireEvent.change(screen.getByTestId('report-description-input'), {
      target: { value: 'a'.repeat(5000) },
    })
    fireEvent.keyDown(screen.getByTestId('report-problem-modal'), { key: 'Enter', ctrlKey: true })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('Cmd+Enter submits on macOS-style keyboards', async () => {
    const onClose = vi.fn()
    render(<ReportProblemModal onClose={onClose} />)
    typeTitle('mac submit')
    fireEvent.keyDown(screen.getByTestId('report-problem-modal'), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    expect(new URL(openExternal.mock.calls[0][0] as string).searchParams.get('title')).toBe('mac submit')
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('a bare Enter belongs to the form, not to submit', () => {
    render(<ReportProblemModal onClose={vi.fn()} />)
    typeTitle('no submit')
    fireEvent.keyDown(screen.getByTestId('report-problem-modal'), { key: 'Enter' })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('ignores keys that are neither Escape nor Enter', () => {
    const onClose = vi.fn()
    render(<ReportProblemModal onClose={onClose} />)
    typeTitle('typing away')
    fireEvent.keyDown(screen.getByTestId('report-problem-modal'), { key: 'a' })
    fireEvent.keyDown(screen.getByTestId('report-problem-modal'), { key: 'Tab' })
    expect(onClose).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('falls back to a generic message when openExternal fails without giving one', async () => {
    openExternal.mockResolvedValueOnce({ success: false })
    render(<ReportProblemModal onClose={vi.fn()} />)
    typeTitle('no reason given')
    fireEvent.click(screen.getByTestId('report-submit'))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not open browser: openExternal failed')
    )
  })

  it('treats a missing openExternal response as a failure rather than a silent close', async () => {
    // A dropped IPC reply must not look like success — closing the modal here would
    // throw away everything the user typed with no issue ever opened.
    openExternal.mockResolvedValueOnce(undefined)
    const onClose = vi.fn()
    render(<ReportProblemModal onClose={onClose} />)
    typeTitle('undefined response')
    fireEvent.click(screen.getByTestId('report-submit'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('openExternal failed'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('report-title-input')).toHaveValue('undefined response')
  })

  it('stringifies a non-Error rejection instead of rendering nothing', async () => {
    openExternal.mockRejectedValueOnce('EPERM opening browser')
    render(<ReportProblemModal onClose={vi.fn()} />)
    typeTitle('string throw')
    fireEvent.click(screen.getByTestId('report-submit'))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not open browser: EPERM opening browser')
    )
  })

  it('survives a null rejection and re-enables submit so the user can retry', async () => {
    openExternal.mockRejectedValueOnce(null)
    render(<ReportProblemModal onClose={vi.fn()} />)
    typeTitle('null throw')
    fireEvent.click(screen.getByTestId('report-submit'))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByTestId('report-submit')).toBeEnabled()

    // The failed attempt must not latch the form shut — retrying goes through.
    fireEvent.click(screen.getByTestId('report-submit'))
    await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('refuses a second submit once the first one succeeded', async () => {
    // onClose is a no-op here, so the modal stays mounted after a successful submit —
    // exactly the window in which a double Ctrl+Enter would file a duplicate issue.
    render(<ReportProblemModal onClose={vi.fn()} />)
    typeTitle('once only')
    fireEvent.click(screen.getByTestId('report-submit'))
    await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('report-submit')).toBeDisabled())

    fireEvent.keyDown(screen.getByTestId('report-problem-modal'), { key: 'Enter', ctrlKey: true })
    expect(openExternal).toHaveBeenCalledTimes(1)
  })
})
