import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InstallHint } from '../../src/renderer/src/components/InstallHint/InstallHint'
import { __setPlatformForTests } from '../../src/renderer/src/lib/platform'

beforeEach(() => {
  window.open = vi.fn()
  // Instructions are platform-branched now; pin it so tests don't inherit the
  // CI runner's OS. Individual tests override via __setPlatformForTests.
  __setPlatformForTests('win32')
})

afterEach(() => {
  __setPlatformForTests(null)
})

describe('InstallHint', () => {
  it('renders agent name in title', () => {
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={vi.fn()} />)
    expect(screen.getByText('Install Claude Code')).toBeInTheDocument()
  })

  it('shows install steps for the given agent', () => {
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={vi.fn()} />)
    expect(screen.getByText('npm install -g @anthropic-ai/claude-code')).toBeInTheDocument()
    expect(screen.getByText(/claude --version/)).toBeInTheDocument()
  })

  it('calls onClose when "Got it" clicked', () => {
    const onClose = vi.fn()
    render(<InstallHint agentId="codex" agentName="OpenAI Codex" onClose={onClose} />)
    fireEvent.click(screen.getByText('Got it'))
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when close (x) button is clicked', () => {
    const onClose = vi.fn()
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={onClose} />)
    // The x button is the one with &times; content
    const closeButtons = screen.getAllByRole('button')
    const xButton = closeButtons.find(btn => btn.textContent === '\u00d7')
    expect(xButton).toBeDefined()
    fireEvent.click(xButton!)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when backdrop (overlay) is clicked', () => {
    const onClose = vi.fn()
    const { container } = render(<InstallHint agentId="claude" agentName="Claude Code" onClose={onClose} />)
    // Click on the fixed overlay backdrop
    const overlay = container.firstChild as HTMLElement
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalled()
  })

  it('does not call onClose when dialog content is clicked', () => {
    const onClose = vi.fn()
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={onClose} />)
    // Click on the dialog card itself (stopPropagation should prevent onClose)
    const dialog = screen.getByText('Install Claude Code').closest('.bg-\\[\\#252526\\]') as HTMLElement
    fireEvent.click(dialog)
    // onClose should NOT be called from the card click
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows codex install instructions', () => {
    render(<InstallHint agentId="codex" agentName="OpenAI Codex" onClose={vi.fn()} />)
    expect(screen.getByText('npm install -g @openai/codex')).toBeInTheDocument()
    expect(screen.getByText(/codex --version/)).toBeInTheDocument()
  })

  // Gemini's profile launches the Antigravity CLI (`agy`) and agents:detect
  // probes `agy`, so the modal must send users to the Antigravity installer.
  // The old text here said `npm i -g @google/gemini-cli` + `gemini --version`,
  // which installed a binary nothing looks for: the red x never cleared and
  // launching hit "agy: command not found". Guard against a regression to npm.
  it('shows Antigravity install instructions for gemini, not the retired npm package', () => {
    __setPlatformForTests('win32')
    render(<InstallHint agentId="gemini" agentName="Gemini CLI" onClose={vi.fn()} />)
    expect(screen.getByText('irm https://antigravity.google/cli/install.ps1 | iex')).toBeInTheDocument()
    expect(screen.getByText(/agy --version/)).toBeInTheDocument()
    expect(screen.queryByText(/npm install -g @google\/gemini-cli/)).toBeNull()
  })

  it('offers the shell installer for gemini on non-Windows', () => {
    __setPlatformForTests('darwin')
    render(<InstallHint agentId="gemini" agentName="Gemini CLI" onClose={vi.fn()} />)
    expect(screen.getByText('curl -fsSL https://antigravity.google/cli/install.sh | bash')).toBeInTheDocument()
  })

  it('warns that the old gemini npm package will not satisfy detection', () => {
    render(<InstallHint agentId="gemini" agentName="Gemini CLI" onClose={vi.fn()} />)
    const warning = screen.getByTestId('install-hint-warning')
    expect(warning.textContent).toMatch(/@google\/gemini-cli/)
    expect(warning.textContent).toMatch(/agy/)
  })

  // The section renderer only turns a line into a copyable command row when it
  // matches its command regex. Antigravity installs via irm/curl, so a regex
  // that only knew npm/pip/npx left the key command as un-copyable prose.
  it('renders script-based install lines as copyable commands', () => {
    __setPlatformForTests('win32')
    render(<InstallHint agentId="gemini" agentName="Gemini CLI" onClose={vi.fn()} />)
    const cmdLine = screen.getByText(/install\.cmd/)
    expect(cmdLine.className).toMatch(/font-mono/)
  })

  it('shows default instructions for unknown agent', () => {
    render(<InstallHint agentId="unknown-agent" agentName="Unknown" onClose={vi.fn()} />)
    expect(screen.getByText('Install Unknown')).toBeInTheDocument()
    expect(screen.getByText('Check the documentation for install instructions.')).toBeInTheDocument()
  })

  it('shows "not installed" notice text', () => {
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={vi.fn()} />)
    expect(screen.getByText(/not installed on your system/)).toBeInTheDocument()
  })

  it('shows restart notice', () => {
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={vi.fn()} />)
    expect(screen.getByText(/restart Termpolis/)).toBeInTheDocument()
  })

  it('renders Documentation link', () => {
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={vi.fn()} />)
    expect(screen.getByText('Documentation')).toBeInTheDocument()
  })

  it('opens documentation URL in new window when link is clicked', () => {
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Documentation'))
    expect(window.open).toHaveBeenCalledWith('https://docs.anthropic.com/en/docs/claude-code', '_blank')
  })

  it('opens correct URL for codex documentation', () => {
    render(<InstallHint agentId="codex" agentName="OpenAI Codex" onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Documentation'))
    expect(window.open).toHaveBeenCalledWith('https://github.com/openai/codex', '_blank')
  })

  // -----------------------------------------------------------------------
  // Copy button tests
  // -----------------------------------------------------------------------
  it('copies step text to clipboard when copy button is clicked', async () => {
    const clipboardWriteText = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).termpolis = { ...(window as any).termpolis, clipboardWriteText }

    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={vi.fn()} />)
    // Each step row has a copy button with a fa-copy icon
    const copyButtons = screen.getAllByTitle('Copy to clipboard')
    expect(copyButtons.length).toBeGreaterThan(0)
    fireEvent.click(copyButtons[0])
    expect(clipboardWriteText).toHaveBeenCalledWith('npm install -g @anthropic-ai/claude-code')
  })

  it('shows checkmark icon after copying', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={vi.fn()} />)
    const copyButtons = screen.getAllByTitle('Copy to clipboard')
    fireEvent.click(copyButtons[0])
    // After click, the icon should change to fa-check
    const checkIcon = copyButtons[0].querySelector('.fa-check')
    expect(checkIcon).toBeTruthy()
  })

  // -----------------------------------------------------------------------
  // Restart warning banner
  // -----------------------------------------------------------------------
  it('displays the restart warning banner', () => {
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={vi.fn()} />)
    const warning = screen.getByText(/You must restart Termpolis/)
    expect(warning).toBeInTheDocument()
    // Check it has the warning icon
    const warningContainer = warning.closest('div')
    expect(warningContainer).toBeTruthy()
    expect(warningContainer!.querySelector('.fa-triangle-exclamation')).toBeTruthy()
  })

  // -----------------------------------------------------------------------
  // Pricing info per agent
  // -----------------------------------------------------------------------
  it('shows pricing info for claude', () => {
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={vi.fn()} />)
    expect(screen.getByText(/Anthropic API plan/)).toBeInTheDocument()
  })

  // Codex has signed in with a ChatGPT plan for a while; the old copy said an
  // API key with active billing was REQUIRED, pushing users onto a bill they
  // don't need. Both routes must be mentioned, plan first.
  it('shows pricing info for codex covering both ChatGPT plan and API key', () => {
    render(<InstallHint agentId="codex" agentName="OpenAI Codex" onClose={vi.fn()} />)
    const pricing = document.querySelector('.fa-credit-card')!.closest('div')!
    expect(pricing.textContent).toMatch(/ChatGPT Plus/)
    expect(pricing.textContent).toMatch(/OpenAI API key/)
    expect(pricing.textContent).not.toMatch(/Requires an OpenAI API key/)
  })

  it('shows pricing info for gemini', () => {
    render(<InstallHint agentId="gemini" agentName="Gemini CLI" onClose={vi.fn()} />)
    expect(screen.getByText(/Free tier available/)).toBeInTheDocument()
  })

  it('does not show pricing for unknown agent', () => {
    render(<InstallHint agentId="unknown-agent" agentName="Unknown" onClose={vi.fn()} />)
    // No credit card icon should be present since pricing is null
    const pricingIcon = document.querySelector('.fa-credit-card')
    expect(pricingIcon).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Claude Desktop vs CLI warning (users often confuse them)
  // -----------------------------------------------------------------------
  it('shows Claude Desktop app vs CLI warning for claude', () => {
    render(<InstallHint agentId="claude" agentName="Claude Code" onClose={vi.fn()} />)
    const warning = screen.getByTestId('install-hint-warning')
    expect(warning).toBeInTheDocument()
    expect(warning.textContent).toMatch(/Desktop app.*NOT the same.*CLI/)
  })

  it('does not show Desktop-vs-CLI warning for non-claude agents', () => {
    render(<InstallHint agentId="codex" agentName="OpenAI Codex" onClose={vi.fn()} />)
    expect(screen.queryByTestId('install-hint-warning')).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Modal scrollability — the root card must allow vertical scroll so long
  // agent instructions don't overflow screen.
  // -----------------------------------------------------------------------
  it('modal card has max-height and vertical overflow scroll', () => {
    render(<InstallHint agentId="gemini" agentName="Gemini CLI" onClose={vi.fn()} />)
    const modal = screen.getByTestId('install-hint-modal')
    expect(modal.className).toMatch(/max-h-/)
    expect(modal.className).toMatch(/overflow-y-auto/)
  })
})
