// @vitest-environment jsdom
import React from 'react'
import { render, screen, fireEvent, waitFor, within, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ProcessesSettings } from '../../src/renderer/src/components/SettingsPane/ProcessesSettings'
import { REASON_HINT, describeKillResult, reasonHint } from '../../src/renderer/src/lib/processFormat'
import type { StuckKillResultView, StuckProcessView, StuckScanView } from '../../src/renderer/src/types'

const ok = <T,>(data: T) => ({ success: true as const, data })
const fail = (error: string) => ({ success: false as const, error })

/** A promise the test settles by hand, to look at the panel while a call is still in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const SCANNED_AT = Date.UTC(2026, 8, 25, 14, 30, 5)
const MB = 1024 * 1024

/** The bare minimum main sends: no agent, no chips, no children, no ports, no detail. */
const proc = (over: Partial<StuckProcessView> = {}): StuckProcessView => ({
  pid: 1,
  created: 1_000,
  name: 'jq.exe',
  category: 'leftover',
  reasons: [],
  owner: 'external',
  stuck: false,
  serving: [],
  ageMs: 0,
  cpuSec: 0,
  memBytes: 0,
  command: 'jq -r .version',
  treeSize: 1,
  ...over,
})

// A headless Claude Code run whose scheduler exited: stuck, and two children go with it.
const CLAUDE = proc({
  pid: 4242,
  created: 1_700_000_000_000,
  name: 'node.exe',
  category: 'agent',
  agent: 'claude',
  reasons: ['headless', 'orphaned'],
  owner: 'orphaned',
  stuck: true,
  ageMs: (3 * 60 + 20) * 60_000,
  cpuSec: 7.9,
  memBytes: 150 * MB,
  command: 'node cli.js -p "nightly triage"',
  detail: 'scheduled task: nightly-triage',
  treeSize: 3,
})

// Codex started from Termpolis and serving MCP on two ports: listed, but NOT stuck.
const CODEX = proc({
  pid: 5151,
  created: 1_700_000_100_000,
  name: 'codex.exe',
  category: 'agent',
  agent: 'codex',
  mcp: true,
  reasons: ['headless'],
  owner: 'termpolis',
  stuck: false,
  serving: [3000, 8080],
  ageMs: 45_000,
  cpuSec: 0.02,
  memBytes: 96 * MB,
  command: 'codex exec --json',
  treeSize: 2,
})

// A git frozen under Git Bash for two days.
const GIT = proc({
  pid: 777,
  created: 1_700_000_200_000,
  name: 'git.exe',
  category: 'git',
  reasons: ['suspended', 'long-running'],
  owner: 'external',
  parentName: 'bash.exe',
  stuck: true,
  ageMs: (2 * 24 + 4) * 3_600_000,
  cpuSec: 0,
  memBytes: 8 * MB,
  command: 'git status --porcelain',
  detail: 'C:\\repos\\termpolis',
  treeSize: 1,
})

// The bash a hook left behind.
const BASH = proc({
  pid: 888,
  created: 1_700_000_300_000,
  name: 'bash.exe',
  category: 'leftover',
  reasons: ['orphaned'],
  owner: 'orphaned',
  stuck: true,
  ageMs: 45 * 60_000,
  cpuSec: 75,
  memBytes: 3 * MB,
  command: 'bash -c "git status"',
  treeSize: 1,
})

const scan = (over: Partial<StuckScanView> = {}): StuckScanView => ({
  processes: [CLAUDE, CODEX, GIT, BASH],
  scannedAt: SCANNED_AT,
  platform: 'win32',
  totalProcesses: 412,
  warnings: [],
  ...over,
})

const NOTHING_KILLED: StuckKillResultView = { killed: [], failed: [], skipped: [] }

function mockApi(over: Record<string, unknown> = {}) {
  const api = {
    processesScanStuck: vi.fn().mockResolvedValue(ok(scan())),
    processesKillStuck: vi.fn().mockResolvedValue(ok(NOTHING_KILLED)),
    ...over,
  }
  ;(window as any).termpolis = api
  return api
}

const text = (testId: string) => screen.getByTestId(testId).textContent
/** The question the confirmation asks — its first paragraph. */
const confirmQuestion = () => screen.getByTestId('processes-confirm').querySelector('p')?.textContent
/** What the confirmation warns will happen — its second paragraph. */
const confirmWarning = () => screen.getByTestId('processes-confirm').querySelectorAll('p')[1].textContent
const infoLine = (row: HTMLElement) => within(row).getByText(/ · up /).textContent
const GREEN = 'text-[#98c379]'
const AMBER = 'text-[#e5c07b]'
const RED = 'text-[#e06c75]'

describe('ProcessesSettings', () => {
  afterEach(() => {
    cleanup()
    delete (window as any).termpolis
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('before there is a list', () => {
    it('says so when the bridge does not expose process cleanup', () => {
      ;(window as any).termpolis = {}
      render(<ProcessesSettings />)
      expect(screen.getByText('Process cleanup is not available in this build.')).toBeInTheDocument()
      expect(screen.queryByTestId('processes-loading')).toBeNull()
      expect(screen.queryByTestId('processes-refresh')).toBeNull()
    })

    it('says so when there is no bridge at all', () => {
      delete (window as any).termpolis
      render(<ProcessesSettings />)
      expect(screen.getByTestId('processes-settings').textContent).toContain(
        'Process cleanup is not available in this build.',
      )
      expect(screen.queryByTestId('processes-loading')).toBeNull()
    })

    it('shows Scanning… until the first scan lands', async () => {
      const first = deferred<unknown>()
      mockApi({ processesScanStuck: vi.fn().mockReturnValue(first.promise) })
      render(<ProcessesSettings />)

      expect(text('processes-loading')).toBe('Scanning…')
      // Nothing to refresh or kill until there is a list.
      expect(screen.queryByTestId('processes-refresh')).toBeNull()
      expect(screen.queryByTestId('processes-kill-stuck')).toBeNull()

      await act(async () => {
        first.resolve(ok(scan()))
      })
      expect(screen.queryByTestId('processes-loading')).toBeNull()
      expect(screen.getByTestId('processes-summary')).toBeInTheDocument()
    })

    it('scans when the tab opens and on Refresh — never on a timer', async () => {
      vi.useFakeTimers()
      const api = mockApi()
      render(<ProcessesSettings />)
      await act(async () => {})
      expect(screen.getByTestId('processes-summary')).toBeInTheDocument()
      expect(api.processesScanStuck).toHaveBeenCalledTimes(1)
      expect(api.processesScanStuck).toHaveBeenCalledWith()

      act(() => {
        vi.advanceTimersByTime(60 * 60_000)
      })
      expect(api.processesScanStuck).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByTestId('processes-refresh'))
      await act(async () => {})
      expect(api.processesScanStuck).toHaveBeenCalledTimes(2)
      expect(text('processes-refresh')).toBe('Refresh')
    })
  })

  describe('scan failures', () => {
    it('shows a refused first scan in place of the list, and Refresh retries it', async () => {
      const api = mockApi({
        processesScanStuck: vi
          .fn()
          .mockResolvedValueOnce(fail('Could not list processes: PowerShell returned nothing'))
          .mockResolvedValueOnce(ok(scan())),
      })
      render(<ProcessesSettings />)

      expect((await screen.findByTestId('processes-error')).textContent).toBe(
        'Could not list processes: PowerShell returned nothing',
      )
      // Nothing to act on — and certainly not a false "nothing stuck".
      expect(screen.queryByTestId('processes-loading')).toBeNull()
      expect(screen.queryByTestId('processes-summary')).toBeNull()
      expect(screen.queryByTestId('processes-kill-selected')).toBeNull()
      expect(screen.queryByTestId('processes-kill-stuck')).toBeNull()
      expect(screen.queryByTestId('processes-empty')).toBeNull()
      expect(screen.queryByTestId('processes-warning')).toBeNull()
      expect(screen.queryByTestId('processes-result')).toBeNull()
      expect(screen.queryAllByTestId(/^processes-group-/)).toHaveLength(0)

      const refresh = screen.getByTestId('processes-refresh')
      expect(refresh.textContent).toBe('Refresh')
      expect(refresh).toBeEnabled()
      fireEvent.click(refresh)

      await screen.findByTestId('processes-group-agent')
      // A good scan clears the error line.
      expect(screen.queryByTestId('processes-error')).toBeNull()
      expect(api.processesScanStuck).toHaveBeenCalledTimes(2)
    })

    it.each([
      ['an Error', new Error('spawn powershell.exe EPERM'), 'spawn powershell.exe EPERM'],
      ['something that is not an Error', 'bridge torn down', 'bridge torn down'],
      ['an Error with no message', new Error(''), 'Unknown error'],
      ['an empty string', '', 'Unknown error'],
    ])('shows a scan that throws %s', async (_kind, thrown, shown) => {
      mockApi({ processesScanStuck: vi.fn().mockRejectedValue(thrown) })
      render(<ProcessesSettings />)
      expect((await screen.findByTestId('processes-error')).textContent).toBe(shown)
      expect(screen.queryByTestId('processes-summary')).toBeNull()
    })

    it('never shows a blank error line: a refusal with no reason still says the scan failed', async () => {
      mockApi({ processesScanStuck: vi.fn().mockResolvedValue(fail('')) })
      render(<ProcessesSettings />)
      const error = await screen.findByRole('alert')
      expect(error).toBe(screen.getByTestId('processes-error'))
      expect(error.textContent).toBe('Scan failed.')
    })

    it('keeps the last good list on screen when a rescan fails', async () => {
      mockApi({
        processesScanStuck: vi.fn().mockResolvedValueOnce(ok(scan())).mockResolvedValueOnce(fail('scan timed out')),
      })
      render(<ProcessesSettings />)
      await screen.findByTestId('processes-row-4242')

      fireEvent.click(screen.getByTestId('processes-refresh'))
      expect((await screen.findByTestId('processes-error')).textContent).toBe('scan timed out')
      expect(screen.getByTestId('processes-row-4242')).toBeInTheDocument()
      expect(screen.getByTestId('processes-summary')).toBeInTheDocument()
      expect(text('processes-refresh')).toBe('Refresh')
    })
  })

  describe('the list', () => {
    it('shows each scan warning, and how many processes were scanned when', async () => {
      const warnings = [
        'Could not read which processes are listening on ports, so nothing was marked stuck.',
        'Termpolis could not find itself in the process list, so nothing was flagged.',
      ]
      mockApi({ processesScanStuck: vi.fn().mockResolvedValue(ok(scan({ warnings, totalProcesses: 412 }))) })
      render(<ProcessesSettings />)

      expect((await screen.findByTestId('processes-summary')).textContent).toBe(
        `412 processes scanned at ${new Date(SCANNED_AT).toLocaleTimeString()}`,
      )
      expect(screen.getAllByTestId('processes-warning').map((w) => w.textContent)).toEqual(warnings)
      expect(screen.queryByTestId('processes-error')).toBeNull()
    })

    it('says nothing is stuck when the scan comes back clean', async () => {
      mockApi({ processesScanStuck: vi.fn().mockResolvedValue(ok(scan({ processes: [] }))) })
      render(<ProcessesSettings />)

      expect((await screen.findByTestId('processes-empty')).textContent).toBe(
        'Nothing stuck. No headless agents, frozen git or orphaned leftovers were found.',
      )
      expect(screen.queryAllByTestId(/^processes-group-/)).toHaveLength(0)
      expect(screen.queryByTestId('processes-warning')).toBeNull()
      expect(text('processes-kill-selected')).toBe('Kill selected (0)')
      expect(screen.getByTestId('processes-kill-selected')).toBeDisabled()
      expect(text('processes-kill-stuck')).toBe('Kill all stuck (0)')
      expect(screen.getByTestId('processes-kill-stuck')).toBeDisabled()
    })

    it('files rows under their group, in a fixed order, each titled with a count', async () => {
      mockApi()
      render(<ProcessesSettings />)

      const agents = await screen.findByTestId('processes-group-agent')
      const git = screen.getByTestId('processes-group-git')
      const leftover = screen.getByTestId('processes-group-leftover')
      expect(screen.getAllByTestId(/^processes-group-/)).toEqual([agents, git, leftover])

      expect(agents.querySelector('label')?.textContent).toBe('Headless AI agents (2)')
      expect(git.querySelector('label')?.textContent).toBe('Git (1)')
      expect(leftover.querySelector('label')?.textContent).toBe('Leftover shells & tools (1)')
      expect(agents.textContent).toContain('Claude Code, Codex and Gemini CLI runs with no window')

      expect(within(agents).getAllByTestId(/^processes-row-/).map((r) => r.dataset.testid)).toEqual([
        'processes-row-4242',
        'processes-row-5151',
      ])
      expect(within(git).getAllByTestId(/^processes-row-/).map((r) => r.dataset.testid)).toEqual(['processes-row-777'])
      expect(within(leftover).getAllByTestId(/^processes-row-/).map((r) => r.dataset.testid)).toEqual([
        'processes-row-888',
      ])

      expect(screen.getByRole('checkbox', { name: 'Select all Headless AI agents' })).toBe(
        screen.getByTestId('processes-select-all-agent'),
      )
      expect(screen.getByTestId('processes-select-all-git')).toHaveAttribute('aria-label', 'Select all Git')
      expect(screen.getByTestId('processes-select-all-leftover')).toHaveAttribute(
        'aria-label',
        'Select all Leftover shells & tools',
      )
    })

    it('leaves out a group with nothing in it', async () => {
      mockApi({ processesScanStuck: vi.fn().mockResolvedValue(ok(scan({ processes: [GIT] }))) })
      render(<ProcessesSettings />)

      await screen.findByTestId('processes-group-git')
      expect(screen.queryByTestId('processes-group-agent')).toBeNull()
      expect(screen.queryByTestId('processes-group-leftover')).toBeNull()
      expect(screen.queryByTestId('processes-empty')).toBeNull()
    })

    it('shows everything a row knows about a stuck agent', async () => {
      mockApi()
      render(<ProcessesSettings />)
      const row = await screen.findByTestId('processes-row-4242')
      const r = within(row)

      // Named for the CLI, not for the node.exe that hosts it.
      expect(r.getByText('Claude Code')).toBeInTheDocument()
      expect(r.queryByText('node.exe')).toBeNull()
      expect(r.getByText('pid 4242')).toBeInTheDocument()
      expect(r.getByText('STUCK')).toHaveAttribute('title', 'Safe to kill: serves no TCP port, nobody is using it, and it is frozen or orphaned.')
      expect(r.getByText('headless')).toHaveAttribute('title', REASON_HINT.headless)
      expect(r.getByText('orphaned')).toHaveAttribute('title', REASON_HINT.orphaned)
      expect(r.queryByText('MCP')).toBeNull()
      expect(infoLine(row)).toBe('parent exited · up 3h 20m · CPU 7s · 150 MB · +2 child processes')
      expect(r.getByRole('button', { name: CLAUDE.command })).toBe(screen.getByTestId('processes-command-4242'))
      expect(r.getByRole('button', { name: `↳ ${CLAUDE.detail}` })).toBe(screen.getByTestId('processes-detail-4242'))
      expect(r.getByRole('checkbox', { name: 'Select Claude Code (pid 4242)' })).toBe(
        screen.getByTestId('processes-check-4242'),
      )
    })

    it('opens the whole command line on click, never in a tooltip', async () => {
      mockApi()
      render(<ProcessesSettings />)
      const command = await screen.findByTestId('processes-command-4242')
      const detail = screen.getByTestId('processes-detail-4242')

      // Masking is best effort, and Sentry copies a clicked element's title into its breadcrumbs,
      // so the line lives only in the text — and Sentry names the element by a fixed label instead.
      expect(screen.getByTestId('processes-settings').querySelector('[title*="nightly"]')).toBeNull()
      expect(command).not.toHaveAttribute('title')
      expect(detail).not.toHaveAttribute('title')
      expect(command).toHaveAttribute('type', 'button')
      expect(command).toHaveAttribute('data-sentry-element', 'process-command')
      expect(detail).toHaveAttribute('data-sentry-element', 'process-detail')
      expect(command).toHaveAttribute('aria-expanded', 'false')
      expect(detail).toHaveAttribute('aria-expanded', 'false')
      expect(command).toHaveClass('truncate')
      expect(detail).toHaveClass('truncate')

      // One switch for the row: the command and the detail open and close together.
      fireEvent.click(command)
      expect(command).toHaveAttribute('aria-expanded', 'true')
      expect(detail).toHaveAttribute('aria-expanded', 'true')
      expect(command).toHaveClass('whitespace-pre-wrap', 'break-all')
      expect(command).not.toHaveClass('truncate')
      expect(detail).toHaveClass('whitespace-pre-wrap', 'break-all')
      // Other rows stay as they were.
      expect(screen.getByTestId('processes-command-5151')).toHaveAttribute('aria-expanded', 'false')

      fireEvent.click(detail)
      expect(command).toHaveAttribute('aria-expanded', 'false')
      expect(detail).toHaveAttribute('aria-expanded', 'false')
      expect(command).toHaveClass('truncate')
    })

    it('shows an MCP server that is listed but not stuck, with its one child and its ports', async () => {
      mockApi()
      render(<ProcessesSettings />)
      const row = await screen.findByTestId('processes-row-5151')
      const r = within(row)

      expect(r.getByText('Codex')).toBeInTheDocument()
      expect(r.queryByText('STUCK')).toBeNull()
      expect(r.getByText('MCP')).toBeInTheDocument()
      expect(r.getByText('headless')).toHaveAttribute('title', REASON_HINT.headless)
      expect(infoLine(row)).toBe(
        'started from Termpolis · up 45s · CPU <1s · 96.0 MB · +1 child process · serving port 3000, 8080',
      )
      expect(r.getByText(CODEX.command)).toBeInTheDocument()
      expect(r.queryByText(/^↳/)).toBeNull()
      expect(screen.getByTestId('processes-check-5151')).toHaveAttribute('aria-label', 'Select Codex (pid 5151)')
    })

    it('names a process that is not an agent by its executable, and says who owns it', async () => {
      mockApi()
      render(<ProcessesSettings />)
      const row = await screen.findByTestId('processes-row-777')
      const r = within(row)

      expect(r.getByText('git.exe')).toBeInTheDocument()
      expect(r.getByText('STUCK')).toBeInTheDocument()
      expect(r.getByText('suspended')).toHaveAttribute('title', REASON_HINT.suspended)
      expect(r.getByText('long-running')).toHaveAttribute('title', REASON_HINT['long-running'])
      expect(infoLine(row)).toBe('under bash.exe · up 2d 4h · CPU 0s · 8.0 MB')
      expect(r.getByText('↳ C:\\repos\\termpolis')).toBeInTheDocument()
      expect(screen.getByTestId('processes-check-777')).toHaveAttribute('aria-label', 'Select git.exe (pid 777)')
    })

    it.each(['linux', 'darwin'])('on %s, explains "suspended" as a stopped job, not a frozen one', async (platform) => {
      mockApi({ processesScanStuck: vi.fn().mockResolvedValue(ok(scan({ platform }))) })
      render(<ProcessesSettings />)
      const r = within(await screen.findByTestId('processes-row-777'))

      expect(r.getByText('suspended')).toHaveAttribute(
        'title',
        'Stopped (e.g. Ctrl+Z): it will not run again until something resumes it.',
      )
      expect(r.getByText('suspended')).toHaveAttribute('title', reasonHint('suspended', platform))
      // Only "suspended" means something else there.
      expect(r.getByText('long-running')).toHaveAttribute('title', REASON_HINT['long-running'])
    })

    it('renders a row that carries only the required fields', async () => {
      const bare = proc({ pid: 31337 })
      mockApi({ processesScanStuck: vi.fn().mockResolvedValue(ok(scan({ processes: [bare] }))) })
      render(<ProcessesSettings />)
      const row = await screen.findByTestId('processes-row-31337')
      const r = within(row)

      expect(r.getByText('jq.exe')).toBeInTheDocument()
      expect(r.getByText('pid 31337')).toBeInTheDocument()
      expect(r.queryByText('STUCK')).toBeNull()
      expect(r.queryByText('MCP')).toBeNull()
      // No chips at all: the only spans left are the name and the pid.
      expect(row.querySelectorAll('span')).toHaveLength(2)
      expect(infoLine(row)).toBe('under another program · up — · CPU 0s · 0 B')
      expect(r.getByText('jq -r .version')).toBeInTheDocument()
      expect(r.queryByText(/^↳/)).toBeNull()
      expect(text('processes-kill-stuck')).toBe('Kill all stuck (0)')
      expect(screen.getByTestId('processes-kill-stuck')).toBeDisabled()
    })

    it('explains what counts as stuck behind the info tip', async () => {
      mockApi()
      render(<ProcessesSettings />)
      const tip = await screen.findByRole('button', { name: 'What counts as stuck' })
      expect(tip).toBe(screen.getByTestId('processes-info'))

      expect(screen.queryByTestId('processes-info-text')).toBeNull()
      fireEvent.click(tip)
      const explained = screen.getByTestId('processes-info-text').textContent
      expect(explained).toContain(
        'Stuck means it serves no TCP port and is either frozen (Windows only: every thread suspended for at ' +
          'least a minute) or orphaned: the program that started it has exited (a headless agent only after an hour).',
      )
      expect(explained).toContain(
        'Also listed, but not marked stuck: headless agents still attached to whatever started them or orphaned ' +
          'for under an hour, git that has run for over 30 minutes, and anything listening on a TCP port',
      )
      expect(explained).toContain('On macOS and Linux a stopped (Ctrl+Z) job is never counted as frozen.')
      expect(explained).toContain(
        'Anything someone is using — an agent CLI open in a terminal, or git waiting on a pager or an editor — is ' +
          'left alone: it is never marked stuck, and an orphaned or long-running tree that holds one is not listed.',
      )
      expect(explained).toContain('its own windows and terminal shells are never listed')
      expect(explained).toContain(
        "Processes in other Windows sessions (other users' processes on macOS and Linux) are not listed; " +
          'elevated ones can only be killed from an elevated Termpolis.',
      )
    })

    it('explains each group in a line under its title', async () => {
      mockApi()
      render(<ProcessesSettings />)
      await screen.findByTestId('processes-group-leftover')

      expect(screen.getByTestId('processes-group-git').textContent).toContain(
        'Git that is frozen (Windows), lost the program that started it, or has run for more than 30 minutes.',
      )
      expect(screen.getByTestId('processes-group-leftover').textContent).toContain(
        'Shells, wrappers, MCP servers and tools whose parent is gone, or that are frozen (Windows).',
      )
    })
  })

  describe('selecting', () => {
    it('selects rows one at a time and counts them on Kill selected', async () => {
      mockApi()
      render(<ProcessesSettings />)
      const claude = await screen.findByTestId('processes-check-4242')
      const git = screen.getByTestId('processes-check-777')

      expect(text('processes-kill-selected')).toBe('Kill selected (0)')
      expect(screen.getByTestId('processes-kill-selected')).toBeDisabled()
      expect(text('processes-kill-stuck')).toBe('Kill all stuck (3)')
      expect(screen.getByTestId('processes-kill-stuck')).toBeEnabled()

      fireEvent.click(claude)
      expect(claude).toBeChecked()
      expect(text('processes-kill-selected')).toBe('Kill selected (1)')
      expect(screen.getByTestId('processes-kill-selected')).toBeEnabled()

      fireEvent.click(git)
      expect(text('processes-kill-selected')).toBe('Kill selected (2)')

      fireEvent.click(claude)
      expect(claude).not.toBeChecked()
      expect(git).toBeChecked()
      expect(text('processes-kill-selected')).toBe('Kill selected (1)')
    })

    it('ticks the group box once every row in the group is ticked by hand', async () => {
      mockApi()
      render(<ProcessesSettings />)
      const all = await screen.findByTestId('processes-select-all-agent')

      fireEvent.click(screen.getByTestId('processes-check-4242'))
      expect(all).not.toBeChecked()
      fireEvent.click(screen.getByTestId('processes-check-5151'))
      expect(all).toBeChecked()
    })

    it('shows the group box as partly ticked while only some of its rows are', async () => {
      mockApi()
      render(<ProcessesSettings />)
      const all = (await screen.findByTestId('processes-select-all-agent')) as HTMLInputElement
      const git = screen.getByTestId('processes-select-all-git') as HTMLInputElement
      expect(all.indeterminate).toBe(false)

      fireEvent.click(screen.getByTestId('processes-check-4242'))
      expect(all.indeterminate).toBe(true)
      expect(all).not.toBeChecked()
      expect(git.indeterminate).toBe(false)

      fireEvent.click(screen.getByTestId('processes-check-5151'))
      expect(all.indeterminate).toBe(false)
      expect(all).toBeChecked()

      fireEvent.click(all)
      expect(all.indeterminate).toBe(false)
      expect(all).not.toBeChecked()
    })

    it('selects a whole group at once — only that group — and unselects it again', async () => {
      mockApi()
      render(<ProcessesSettings />)
      const all = await screen.findByTestId('processes-select-all-agent')
      const claude = screen.getByTestId('processes-check-4242')
      const codex = screen.getByTestId('processes-check-5151')

      // One of two picked by hand; the group box then selects the rest rather than toggling.
      fireEvent.click(codex)
      fireEvent.click(all)
      expect(claude).toBeChecked()
      expect(codex).toBeChecked()
      expect(all).toBeChecked()
      expect(screen.getByTestId('processes-check-777')).not.toBeChecked()
      expect(screen.getByTestId('processes-select-all-git')).not.toBeChecked()
      expect(text('processes-kill-selected')).toBe('Kill selected (2)')

      fireEvent.click(all)
      expect(claude).not.toBeChecked()
      expect(codex).not.toBeChecked()
      expect(all).not.toBeChecked()
      expect(text('processes-kill-selected')).toBe('Kill selected (0)')
      expect(screen.getByTestId('processes-kill-selected')).toBeDisabled()
    })

    it('keeps a selection across a rescan while the same process is still there', async () => {
      mockApi()
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-check-777'))

      fireEvent.click(screen.getByTestId('processes-refresh'))
      await waitFor(() => expect(text('processes-refresh')).toBe('Refresh'))
      expect(screen.getByTestId('processes-check-777')).toBeChecked()
      expect(text('processes-kill-selected')).toBe('Kill selected (1)')
    })

    it('drops a selection whose pid now belongs to a different process', async () => {
      // Same pid, new start time: Windows handed the number to something else.
      const reborn = { ...GIT, created: GIT.created + 60_000 }
      mockApi({
        processesScanStuck: vi
          .fn()
          .mockResolvedValueOnce(ok(scan()))
          .mockResolvedValueOnce(ok(scan({ processes: [CLAUDE, CODEX, reborn, BASH] }))),
      })
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-check-777'))
      expect(text('processes-kill-selected')).toBe('Kill selected (1)')

      fireEvent.click(screen.getByTestId('processes-refresh'))
      await waitFor(() => expect(text('processes-kill-selected')).toBe('Kill selected (0)'))
      expect(screen.getByTestId('processes-check-777')).not.toBeChecked()
      expect(screen.getByTestId('processes-kill-selected')).toBeDisabled()
    })

    // Main allows the same drift when it re-checks a kill: 2s on Windows, 5s where start times are
    // only approximate (macOS and Linux).
    it.each([
      ['win32', 2_000, true],
      ['win32', -2_000, true],
      ['win32', 3_000, false],
      ['linux', 3_000, true],
      ['linux', 5_000, true],
      ['linux', 6_000, false],
      ['darwin', -4_000, true],
      ['darwin', -6_000, false],
    ])('on %s, a start time that moved %ims between scans keeps the selection: %s', async (platform, drift, kept) => {
      const drifted = { ...GIT, created: GIT.created + drift }
      mockApi({
        processesScanStuck: vi
          .fn()
          .mockResolvedValueOnce(ok(scan({ platform })))
          .mockResolvedValueOnce(ok(scan({ platform, processes: [CLAUDE, CODEX, drifted, BASH] }))),
      })
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-check-777'))

      fireEvent.click(screen.getByTestId('processes-refresh'))
      await waitFor(() => expect(text('processes-refresh')).toBe('Refresh'))
      expect((screen.getByTestId('processes-check-777') as HTMLInputElement).checked).toBe(kept)
      expect(text('processes-kill-selected')).toBe(`Kill selected (${kept ? 1 : 0})`)
    })

    it('re-keys a carried-over selection, so the kill names the start time just scanned', async () => {
      const drifted = { ...GIT, created: GIT.created + 3_000 }
      const api = mockApi({
        processesScanStuck: vi
          .fn()
          .mockResolvedValueOnce(ok(scan({ platform: 'linux' })))
          .mockResolvedValueOnce(ok(scan({ platform: 'linux', processes: [CLAUDE, CODEX, drifted, BASH] })))
          .mockResolvedValueOnce(ok(scan({ platform: 'linux', processes: [CLAUDE, CODEX, BASH] }))),
      })
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-check-777'))
      fireEvent.click(screen.getByTestId('processes-refresh'))
      await waitFor(() => expect(text('processes-refresh')).toBe('Refresh'))

      fireEvent.click(screen.getByTestId('processes-kill-selected'))
      fireEvent.click(screen.getByTestId('processes-confirm-kill'))
      expect(api.processesKillStuck).toHaveBeenCalledWith([{ pid: GIT.pid, created: drifted.created }], {
        stuckOnly: false,
      })
      await screen.findByTestId('processes-result')
    })

    it('keeps an opened command line open across a rescan that nudges the start time', async () => {
      const drifted = { ...GIT, created: GIT.created + 3_000 }
      mockApi({
        processesScanStuck: vi
          .fn()
          .mockResolvedValueOnce(ok(scan({ platform: 'linux' })))
          .mockResolvedValueOnce(ok(scan({ platform: 'linux', processes: [CLAUDE, CODEX, drifted, BASH] }))),
      })
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-command-777'))
      expect(screen.getByTestId('processes-command-777')).toHaveAttribute('aria-expanded', 'true')

      fireEvent.click(screen.getByTestId('processes-refresh'))
      await waitFor(() => expect(text('processes-refresh')).toBe('Refresh'))
      expect(screen.getByTestId('processes-command-777')).toHaveAttribute('aria-expanded', 'true')
    })

    it('forgets a selection once its process drops off the list, even if it is listed again later', async () => {
      mockApi({
        processesScanStuck: vi
          .fn()
          .mockResolvedValueOnce(ok(scan()))
          // The git is not listed this time...
          .mockResolvedValueOnce(ok(scan({ processes: [CLAUDE, CODEX, BASH] })))
          // ...and is back on the next scan, same pid and same start time.
          .mockResolvedValueOnce(ok(scan())),
      })
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-check-777'))

      fireEvent.click(screen.getByTestId('processes-refresh'))
      await waitFor(() => expect(screen.queryByTestId('processes-row-777')).toBeNull())
      expect(text('processes-kill-selected')).toBe('Kill selected (0)')

      fireEvent.click(screen.getByTestId('processes-refresh'))
      await waitFor(() => expect(text('processes-refresh')).toBe('Refresh'))
      // It has to be ticked again, on purpose, before a kill can reach it.
      expect(screen.getByTestId('processes-check-777')).not.toBeChecked()
      expect(text('processes-kill-selected')).toBe('Kill selected (0)')
      expect(screen.getByTestId('processes-select-all-git')).not.toBeChecked()
    })
  })

  describe('confirming', () => {
    it('asks before killing, and Cancel backs out without killing anything', async () => {
      const api = mockApi()
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-check-777'))
      expect(screen.queryByTestId('processes-confirm')).toBeNull()

      fireEvent.click(screen.getByTestId('processes-kill-selected'))
      expect(screen.getByRole('alertdialog', { name: 'Confirm kill' })).toBe(screen.getByTestId('processes-confirm'))
      expect(confirmQuestion()).toBe('Kill 1 process?')
      expect(text('processes-confirm-kill')).toBe('Kill 1')
      expect(text('processes-confirm-cancel')).toBe('Cancel')
      expect(screen.getByTestId('processes-confirm').textContent).toContain('.git/index.lock')

      fireEvent.click(screen.getByTestId('processes-confirm-cancel'))
      expect(screen.queryByTestId('processes-confirm')).toBeNull()
      expect(api.processesKillStuck).not.toHaveBeenCalled()
      // Backing out keeps the selection, so the same kill is one click away.
      expect(screen.getByTestId('processes-check-777')).toBeChecked()

      fireEvent.click(screen.getByTestId('processes-kill-selected'))
      expect(confirmQuestion()).toBe('Kill 1 process?')
    })

    it('counts the processes, and the children that go with them, in the right number', async () => {
      mockApi()
      render(<ProcessesSettings />)
      await screen.findByTestId('processes-row-4242')
      const tick = (pid: number) => fireEvent.click(screen.getByTestId(`processes-check-${pid}`))
      const ask = (button: string) => {
        fireEvent.click(screen.getByTestId(button))
        const question = confirmQuestion()
        const confirmLabel = text('processes-confirm-kill')
        fireEvent.click(screen.getByTestId('processes-confirm-cancel'))
        return [question, confirmLabel]
      }

      tick(777)
      expect(ask('processes-kill-selected')).toEqual(['Kill 1 process?', 'Kill 1'])

      tick(888)
      expect(ask('processes-kill-selected')).toEqual(['Kill 2 processes?', 'Kill 2'])

      tick(777)
      tick(888)
      tick(5151)
      expect(ask('processes-kill-selected')).toEqual(['Kill 1 process, plus 1 child process under it?', 'Kill 1'])

      tick(4242)
      expect(ask('processes-kill-selected')).toEqual(['Kill 2 processes, plus 3 child processes under them?', 'Kill 2'])

      // Every stuck row: Claude (3 in its tree), git and bash — two children between them.
      expect(ask('processes-kill-stuck')).toEqual(['Kill 3 processes, plus 2 child processes under them?', 'Kill 3'])
    })

    it('warns what a kill costs, and that Kill all stuck also skips whatever is no longer stuck', async () => {
      mockApi()
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-check-777'))

      fireEvent.click(screen.getByTestId('processes-kill-selected'))
      expect(confirmWarning()).toBe(
        'Whatever they were doing is lost. A git killed mid-write can leave a stale .git/index.lock — delete it ' +
          'if the next git command complains. Each one is checked again first: anything that has exited, or whose ' +
          'pid now belongs to a different process, is skipped. Anything still running is ended with its current ' +
          'child processes.',
      )
      fireEvent.click(screen.getByTestId('processes-confirm-cancel'))

      fireEvent.click(screen.getByTestId('processes-kill-stuck'))
      expect(confirmWarning()).toContain(
        'anything that has exited, is no longer stuck, or whose pid now belongs to a different process, is skipped.',
      )
    })

    it('is described to a screen reader by its question and its warning', async () => {
      mockApi()
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-kill-stuck'))

      const dialog = screen.getByRole('alertdialog', { name: 'Confirm kill' })
      const [question, warning] = dialog.querySelectorAll('p')
      expect(dialog.getAttribute('aria-describedby')).toBe(`${question.id} ${warning.id}`)
      expect(question.id).not.toBe(warning.id)
      expect(dialog).toHaveAccessibleDescription(
        /^Kill 3 processes, plus 2 child processes under them\? Whatever they were doing is lost\./,
      )
      expect(dialog).toHaveAccessibleDescription(/is no longer stuck/)
    })

    it('puts focus on Cancel, and Escape backs out to the button that asked', async () => {
      const api = mockApi()
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-check-777'))
      const opener = screen.getByTestId('processes-kill-selected')
      fireEvent.click(opener)
      const cancel = screen.getByTestId('processes-confirm-cancel')
      expect(document.activeElement).toBe(cancel)

      // Other keys pass through; Escape is kept from closing Settings behind the dialog.
      const outside = vi.fn()
      document.addEventListener('keydown', outside)
      try {
        fireEvent.keyDown(cancel, { key: 'Enter' })
        expect(screen.getByTestId('processes-confirm')).toBeInTheDocument()
        expect(outside).toHaveBeenCalledTimes(1)

        fireEvent.keyDown(cancel, { key: 'Escape' })
        expect(screen.queryByTestId('processes-confirm')).toBeNull()
        expect(outside).toHaveBeenCalledTimes(1)
      } finally {
        document.removeEventListener('keydown', outside)
      }
      expect(document.activeElement).toBe(opener)
      expect(api.processesKillStuck).not.toHaveBeenCalled()
      expect(screen.getByTestId('processes-check-777')).toBeChecked()
    })

    it('Cancel hands focus back to the button that asked', async () => {
      mockApi()
      render(<ProcessesSettings />)
      const opener = await screen.findByTestId('processes-kill-stuck')
      fireEvent.click(opener)
      fireEvent.click(screen.getByTestId('processes-confirm-cancel'))
      expect(document.activeElement).toBe(opener)
    })

    it('follows the live list while it is open, and goes when a rescan leaves nothing to kill', async () => {
      const api = mockApi({
        processesScanStuck: vi
          .fn()
          .mockResolvedValueOnce(ok(scan()))
          // Claude and bash ended on their own while the question was up...
          .mockResolvedValueOnce(ok(scan({ processes: [CODEX, GIT] })))
          // ...then the git did too...
          .mockResolvedValueOnce(ok(scan({ processes: [CODEX] })))
          // ...and a fresh one froze.
          .mockResolvedValueOnce(ok(scan())),
      })
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-kill-stuck'))
      expect(confirmQuestion()).toBe('Kill 3 processes, plus 2 child processes under them?')

      fireEvent.click(screen.getByTestId('processes-refresh'))
      await waitFor(() => expect(confirmQuestion()).toBe('Kill 1 process?'))
      expect(text('processes-confirm-kill')).toBe('Kill 1')

      fireEvent.click(screen.getByTestId('processes-refresh'))
      await waitFor(() => expect(screen.queryByTestId('processes-confirm')).toBeNull())
      expect(text('processes-refresh')).toBe('Refresh')
      // Nobody closed it, so focus is not moved anywhere on the user's behalf.
      expect(document.activeElement).toBe(document.body)

      // Something stuck again does not bring back a question nobody asked this time.
      fireEvent.click(screen.getByTestId('processes-refresh'))
      await waitFor(() => expect(text('processes-kill-stuck')).toBe('Kill all stuck (3)'))
      expect(screen.queryByTestId('processes-confirm')).toBeNull()
      expect(api.processesKillStuck).not.toHaveBeenCalled()
    })

    it('kills only what the open question names after a rescan changed the list', async () => {
      const api = mockApi({
        processesScanStuck: vi
          .fn()
          .mockResolvedValueOnce(ok(scan()))
          .mockResolvedValueOnce(ok(scan({ processes: [CODEX, GIT] })))
          .mockResolvedValueOnce(ok(scan({ processes: [CODEX] }))),
      })
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-kill-stuck'))
      fireEvent.click(screen.getByTestId('processes-refresh'))
      await waitFor(() => expect(confirmQuestion()).toBe('Kill 1 process?'))

      fireEvent.click(screen.getByTestId('processes-confirm-kill'))
      expect(api.processesKillStuck).toHaveBeenCalledWith([{ pid: GIT.pid, created: GIT.created }], {
        stuckOnly: true,
      })
      await screen.findByTestId('processes-result')
    })
  })

  describe('killing', () => {
    it('kills the selection, rescans, then reports — keeping only selections still alive', async () => {
      const rescan = deferred<unknown>()
      const outcome: StuckKillResultView = {
        killed: [CLAUDE.pid],
        failed: [{ pid: GIT.pid, error: 'access denied' }],
        skipped: [],
      }
      const api = mockApi({
        processesScanStuck: vi.fn().mockResolvedValueOnce(ok(scan())).mockReturnValueOnce(rescan.promise),
        processesKillStuck: vi.fn().mockResolvedValue(ok(outcome)),
      })
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-check-4242'))
      fireEvent.click(screen.getByTestId('processes-check-777'))
      fireEvent.click(screen.getByTestId('processes-kill-selected'))
      fireEvent.click(screen.getByTestId('processes-confirm-kill'))

      // The dialog goes at once; the kill names each target by pid AND start time.
      expect(screen.queryByTestId('processes-confirm')).toBeNull()
      expect(api.processesKillStuck).toHaveBeenCalledTimes(1)
      // A hand-picked kill is not narrowed to what is still stuck: the user chose these rows.
      expect(api.processesKillStuck).toHaveBeenCalledWith(
        [
          { pid: CLAUDE.pid, created: CLAUDE.created },
          { pid: GIT.pid, created: GIT.created },
        ],
        { stuckOnly: false },
      )
      await waitFor(() => expect(api.processesScanStuck).toHaveBeenCalledTimes(2))
      expect(api.processesKillStuck.mock.invocationCallOrder[0]).toBeLessThan(
        api.processesScanStuck.mock.invocationCallOrder[1],
      )

      // Until the rescan lands there is no verdict, and nothing can be pressed twice.
      expect(screen.queryByTestId('processes-result')).toBeNull()
      expect(text('processes-refresh')).toBe('Scanning…')
      expect(screen.getByTestId('processes-refresh')).toBeDisabled()
      expect(screen.getByTestId('processes-kill-selected')).toBeDisabled()
      expect(screen.getByTestId('processes-kill-stuck')).toBeDisabled()
      expect(screen.getByTestId('processes-check-777')).toBeDisabled()
      expect(screen.getByTestId('processes-select-all-agent')).toBeDisabled()

      await act(async () => {
        rescan.resolve(ok(scan({ processes: [CODEX, GIT] })))
      })

      expect(text('processes-result')).toBe(describeKillResult(outcome))
      expect(text('processes-result')).toBe('Killed 1 process. 1 could not be killed: access denied.')
      // Part of it was not ended: amber, not green.
      expect(screen.getByTestId('processes-result')).toHaveClass(AMBER)
      expect(screen.queryByTestId('processes-error')).toBeNull()
      expect(screen.queryByTestId('processes-row-4242')).toBeNull()
      // The git that refused to die is still there, and still selected; the dead agent is not.
      expect(screen.getByTestId('processes-check-777')).toBeChecked()
      expect(text('processes-kill-selected')).toBe('Kill selected (1)')
      expect(text('processes-refresh')).toBe('Refresh')
      expect(screen.getByTestId('processes-refresh')).toBeEnabled()
      // Focus waited out the kill and its rescan, then went back to the button that asked.
      expect(document.activeElement).toBe(screen.getByTestId('processes-kill-selected'))
    })

    it('announces the verdict in a live region', async () => {
      mockApi({
        processesKillStuck: vi.fn().mockResolvedValue(ok({ killed: [GIT.pid], failed: [], skipped: [] })),
      })
      render(<ProcessesSettings />)
      const status = await screen.findByRole('status')
      expect(status).toBe(screen.getByTestId('processes-status'))
      expect(status).toHaveAttribute('aria-live', 'polite')
      // Mounted and empty before there is anything to say, so the first verdict is heard.
      expect(status).toBeEmptyDOMElement()

      fireEvent.click(screen.getByTestId('processes-check-777'))
      fireEvent.click(screen.getByTestId('processes-kill-selected'))
      fireEvent.click(screen.getByTestId('processes-confirm-kill'))
      const result = await screen.findByTestId('processes-result')
      expect(status).toContainElement(result)
      expect(result.textContent).toBe('Killed 1 process.')
    })

    it('shows red when nothing could be killed', async () => {
      mockApi({
        processesKillStuck: vi.fn().mockResolvedValue(
          ok({
            killed: [],
            failed: [
              { pid: GIT.pid, error: 'access denied — elevated or owned by another user' },
              { pid: BASH.pid, error: 'access denied — elevated or owned by another user' },
            ],
            skipped: [],
          }),
        ),
      })
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-check-777'))
      fireEvent.click(screen.getByTestId('processes-check-888'))
      fireEvent.click(screen.getByTestId('processes-kill-selected'))
      fireEvent.click(screen.getByTestId('processes-confirm-kill'))

      const result = await screen.findByTestId('processes-result')
      // One reason for both, said once.
      expect(result.textContent).toBe(
        'Nothing was killed. 2 could not be killed: access denied — elevated or owned by another user.',
      )
      expect(result).toHaveClass(RED)
      expect(result).not.toHaveClass(GREEN)
    })

    it('locks the panel while the kill itself runs, and rescans only once it has finished', async () => {
      const killing = deferred<unknown>()
      const api = mockApi({
        processesScanStuck: vi
          .fn()
          .mockResolvedValueOnce(ok(scan()))
          .mockResolvedValueOnce(ok(scan({ processes: [CODEX] }))),
        processesKillStuck: vi.fn().mockReturnValue(killing.promise),
      })
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-kill-stuck'))
      fireEvent.click(screen.getByTestId('processes-confirm-kill'))

      // Ending a process tree takes a while, and nothing may be pressed twice meanwhile.
      expect(text('processes-refresh')).toBe('Scanning…')
      expect(screen.getByTestId('processes-refresh')).toBeDisabled()
      expect(screen.getByTestId('processes-kill-stuck')).toBeDisabled()
      expect(screen.getByTestId('processes-select-all-agent')).toBeDisabled()
      expect(screen.getByTestId('processes-check-888')).toBeDisabled()
      // A scan taken now would still list the processes being ended.
      await act(async () => {})
      expect(api.processesScanStuck).toHaveBeenCalledTimes(1)
      expect(screen.queryByTestId('processes-result')).toBeNull()

      await act(async () => {
        killing.resolve(ok({ killed: [CLAUDE.pid, GIT.pid, BASH.pid], failed: [], skipped: [] }))
      })
      expect(api.processesScanStuck).toHaveBeenCalledTimes(2)
      expect(text('processes-result')).toBe('Killed 3 processes.')
      expect(screen.getByTestId('processes-result')).toHaveClass(GREEN)
      expect(screen.queryByTestId('processes-row-4242')).toBeNull()
      expect(text('processes-refresh')).toBe('Refresh')
      // Nothing is stuck now, so the button that asked is disabled: focus lands on Refresh instead.
      expect(screen.getByTestId('processes-kill-stuck')).toBeDisabled()
      expect(document.activeElement).toBe(screen.getByTestId('processes-refresh'))
    })

    it('Kill all stuck targets exactly the rows marked stuck', async () => {
      const outcome: StuckKillResultView = { killed: [CLAUDE.pid, GIT.pid, BASH.pid], failed: [], skipped: [] }
      const api = mockApi({
        processesScanStuck: vi
          .fn()
          .mockResolvedValueOnce(ok(scan()))
          .mockResolvedValueOnce(ok(scan({ processes: [CODEX] }))),
        processesKillStuck: vi.fn().mockResolvedValue(ok(outcome)),
      })
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-kill-stuck'))
      fireEvent.click(screen.getByTestId('processes-confirm-kill'))

      expect((await screen.findByTestId('processes-result')).textContent).toBe('Killed 3 processes.')
      // Codex is listed but not stuck, so it is not in the kill — and main re-checks "stuck" too.
      expect(api.processesKillStuck).toHaveBeenCalledWith(
        [
          { pid: CLAUDE.pid, created: CLAUDE.created },
          { pid: GIT.pid, created: GIT.created },
          { pid: BASH.pid, created: BASH.created },
        ],
        { stuckOnly: true },
      )
      expect(screen.getByTestId('processes-row-5151')).toBeInTheDocument()
      expect(text('processes-kill-stuck')).toBe('Kill all stuck (0)')
      expect(screen.getByTestId('processes-kill-stuck')).toBeDisabled()
    })

    it('shows a refused kill after the rescan, which would otherwise clear the error line', async () => {
      const api = mockApi({
        processesKillStuck: vi.fn().mockResolvedValue(fail('Each process to end needs a pid and a start time')),
      })
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-kill-stuck'))
      fireEvent.click(screen.getByTestId('processes-confirm-kill'))

      // Let the whole kill settle. The rescan still ran, and it succeeded, so it cleared the error line...
      await waitFor(() => expect(text('processes-refresh')).toBe('Refresh'))
      expect(api.processesScanStuck).toHaveBeenCalledTimes(2)
      // ...and the refusal is written after it, so it is still on screen.
      expect(text('processes-error')).toBe('Each process to end needs a pid and a start time')
      expect(screen.queryByTestId('processes-result')).toBeNull()
    })

    it('shows a kill that throws, after rescanning anyway', async () => {
      const api = mockApi({ processesKillStuck: vi.fn().mockRejectedValue(new Error('IPC channel closed')) })
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-check-888'))
      fireEvent.click(screen.getByTestId('processes-kill-selected'))
      fireEvent.click(screen.getByTestId('processes-confirm-kill'))

      await waitFor(() => expect(text('processes-refresh')).toBe('Refresh'))
      expect(api.processesScanStuck).toHaveBeenCalledTimes(2)
      expect(text('processes-error')).toBe('IPC channel closed')
      expect(screen.queryByTestId('processes-result')).toBeNull()
    })

    it.each([
      ['refused with no reason', () => Promise.resolve(fail('')), 'Kill failed.'],
      ['thrown with no message', () => Promise.reject(new Error('')), 'Unknown error'],
    ])('never shows a blank error line for a kill %s', async (_kind, killing, shown) => {
      mockApi({ processesKillStuck: vi.fn(killing) })
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-kill-stuck'))
      fireEvent.click(screen.getByTestId('processes-confirm-kill'))

      await waitFor(() => expect(text('processes-refresh')).toBe('Refresh'))
      expect(screen.getByRole('alert').textContent).toBe(shown)
      expect(screen.queryByTestId('processes-result')).toBeNull()
    })

    it('reports a kill that worked alongside a rescan that failed after it', async () => {
      const outcome: StuckKillResultView = {
        killed: [BASH.pid],
        failed: [],
        skipped: [{ pid: GIT.pid, reason: 'changed' }],
      }
      mockApi({
        processesScanStuck: vi.fn().mockResolvedValueOnce(ok(scan())).mockResolvedValueOnce(fail('scan timed out')),
        processesKillStuck: vi.fn().mockResolvedValue(ok(outcome)),
      })
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-check-888'))
      fireEvent.click(screen.getByTestId('processes-check-777'))
      fireEvent.click(screen.getByTestId('processes-kill-selected'))
      fireEvent.click(screen.getByTestId('processes-confirm-kill'))

      expect((await screen.findByTestId('processes-result')).textContent).toBe(describeKillResult(outcome))
      expect(text('processes-error')).toBe('scan timed out')
    })

    it('Refresh clears the last kill result at once and scans again', async () => {
      const api = mockApi({
        processesKillStuck: vi.fn().mockResolvedValue(ok({ killed: [GIT.pid], failed: [], skipped: [] })),
      })
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-check-777'))
      fireEvent.click(screen.getByTestId('processes-kill-selected'))
      fireEvent.click(screen.getByTestId('processes-confirm-kill'))
      expect((await screen.findByTestId('processes-result')).textContent).toBe('Killed 1 process.')

      fireEvent.click(screen.getByTestId('processes-refresh'))
      // Gone before the scan lands: an old verdict must not sit next to a new list.
      expect(screen.queryByTestId('processes-result')).toBeNull()
      await waitFor(() => expect(text('processes-refresh')).toBe('Refresh'))
      expect(api.processesScanStuck).toHaveBeenCalledTimes(3)
      expect(screen.queryByTestId('processes-result')).toBeNull()
    })

    it('clears the last verdict as soon as the next kill starts', async () => {
      const rescan = deferred<unknown>()
      mockApi({
        processesScanStuck: vi
          .fn()
          .mockResolvedValueOnce(ok(scan()))
          .mockResolvedValueOnce(ok(scan({ processes: [CLAUDE, CODEX, BASH] })))
          .mockReturnValueOnce(rescan.promise),
        processesKillStuck: vi
          .fn()
          .mockResolvedValueOnce(ok({ killed: [GIT.pid], failed: [], skipped: [] }))
          .mockResolvedValueOnce(ok({ killed: [], failed: [], skipped: [{ pid: BASH.pid, reason: 'exited' }] })),
      })
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-check-777'))
      fireEvent.click(screen.getByTestId('processes-kill-selected'))
      fireEvent.click(screen.getByTestId('processes-confirm-kill'))
      expect((await screen.findByTestId('processes-result')).textContent).toBe('Killed 1 process.')

      fireEvent.click(screen.getByTestId('processes-check-888'))
      fireEvent.click(screen.getByTestId('processes-kill-selected'))
      fireEvent.click(screen.getByTestId('processes-confirm-kill'))
      // The first kill's verdict must not sit beside the second kill while it runs.
      expect(screen.queryByTestId('processes-result')).toBeNull()

      await act(async () => {
        rescan.resolve(ok(scan({ processes: [CLAUDE, CODEX] })))
      })
      expect(text('processes-result')).toBe('Nothing was killed. 1 was skipped: exited.')
      expect(screen.getByTestId('processes-result')).toHaveClass(AMBER)
    })

    it('reads Scanning… and locks every control while a rescan is in flight', async () => {
      const rescan = deferred<unknown>()
      mockApi({
        processesScanStuck: vi.fn().mockResolvedValueOnce(ok(scan())).mockReturnValueOnce(rescan.promise),
      })
      render(<ProcessesSettings />)
      fireEvent.click(await screen.findByTestId('processes-check-777'))
      fireEvent.click(screen.getByTestId('processes-kill-selected'))
      const refresh = screen.getByTestId('processes-refresh')
      expect(refresh.textContent).toBe('Refresh')

      fireEvent.click(refresh)
      expect(refresh.textContent).toBe('Scanning…')
      expect(refresh).toBeDisabled()
      // Disabled although one row is selected and three are stuck.
      expect(screen.getByTestId('processes-kill-selected')).toBeDisabled()
      expect(screen.getByTestId('processes-kill-stuck')).toBeDisabled()
      expect(screen.getByTestId('processes-confirm-kill')).toBeDisabled()
      expect(screen.getByTestId('processes-confirm-cancel')).toBeEnabled()
      expect(screen.getByTestId('processes-select-all-git')).toBeDisabled()
      expect(screen.getByTestId('processes-check-777')).toBeDisabled()

      await act(async () => {
        rescan.resolve(ok(scan()))
      })
      expect(refresh.textContent).toBe('Refresh')
      expect(refresh).toBeEnabled()
      expect(screen.getByTestId('processes-kill-selected')).toBeEnabled()
      expect(screen.getByTestId('processes-confirm-kill')).toBeEnabled()
      expect(screen.getByTestId('processes-check-777')).toBeEnabled()
    })
  })
})
