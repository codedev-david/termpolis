import React from 'react'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ClaudeNotesPanel } from '../../src/renderer/src/components/SettingsPane/ClaudeNotesPanel'

// Settings > Memory > Claude Code's saved notes. The bridge is faked at window.termpolis, as the sibling
// panels' tests do; what is under test is what the user sees and what each click sends.

type View = {
  indexClaudeNotes: boolean
  shareNotesAcrossProjects: boolean
  connected: boolean
  locked?: boolean
  status: { notes: number; chunks: number; projects: number; lastAt: number | null; noProject: number; secretsRedacted: number; pending: number }
}

const view = (over: Partial<View> = {}, status: Partial<View['status']> = {}): View => ({
  indexClaudeNotes: true,
  shareNotesAcrossProjects: false,
  connected: true,
  status: { notes: 0, chunks: 0, projects: 0, lastAt: null, noProject: 0, secretsRedacted: 0, pending: 0, ...status },
  ...over,
})

let live: View
let getSettings: ReturnType<typeof vi.fn>
let setSettings: ReturnType<typeof vi.fn>
let removeNotes: ReturnType<typeof vi.fn>

function mockApi(initial: View = view()) {
  live = initial
  getSettings = vi.fn(async () => ({ success: true, data: live }))
  setSettings = vi.fn(async (p: Partial<View>) => {
    live = { ...live, ...p }
    return { success: true, data: live }
  })
  removeNotes = vi.fn(async () => {
    live = { ...live, indexClaudeNotes: false, status: { ...live.status, notes: 0, chunks: 0, projects: 0 } }
    return { success: true, data: { removed: 7, failed: 0, settings: live } }
  })
  ;(window as any).termpolis = { memoryGetNotesSettings: getSettings, memorySetNotesSettings: setSettings, memoryRemoveImportedNotes: removeNotes }
}

beforeEach(() => { mockApi() })
afterEach(() => { cleanup(); delete (window as any).termpolis; vi.useRealTimers(); vi.restoreAllMocks() })

const flush = () => act(async () => { await Promise.resolve() })
const open = async (props: { refreshToken?: number } = {}) => {
  const r = render(<ClaudeNotesPanel {...props} />)
  await screen.findByTestId('claude-notes-panel')
  return r
}
const pressed = (id: string) => screen.getByTestId(id).getAttribute('aria-pressed')

describe('ClaudeNotesPanel: what is shown', () => {
  it('says what it reads, what it writes (nothing back), and where a note can go', async () => {
    await open()
    const text = screen.getByTestId('claude-notes-panel').textContent!
    expect(text).toContain("Claude Code’s saved notes")
    expect(text).toContain('~/.claude/projects/')
    expect(text).toContain('reads')
    expect(text).toContain('Nothing is ever written back')
    expect(text).toContain('Secrets in a note are redacted')
  })

  // Termpolis itself sends nothing anywhere, but the point of the feature is that Codex and the Antigravity CLI read what Claude
  // kept private to Claude, and an agent passes what it reads to its own provider. "Nothing leaves this computer" was not true of that.
  it('does not say the notes stay on this computer: an agent that finds one passes it to its own provider', async () => {
    await open()
    const text = screen.getByTestId('claude-notes-panel').textContent!
    expect(text).not.toMatch(/nothing leaves this computer/i)
    expect(text).toContain('Termpolis sends nothing off this computer')
    expect(text).toContain('passes its text on to its own provider')
  })

  it('says what the sharing switch covers, and that a search that names no project is given no note', async () => {
    await open()
    const text = screen.getByTestId('claude-notes-panel').textContent!
    expect(text).toContain('Notes about one project’s own state never leave it')
    expect(text).toContain('A search that names no project returns no saved note')
  })

  // A session run in the home folder has no project (the store does not call the home folder one), so what it saved has no
  // project to come from, and is not lent to a search that names one. The row says so; PRIVACY.md and DOCUMENTATION say it too.
  it('says that notes from sessions run in the home folder are not lent', async () => {
    await open()
    const text = (screen.getByTestId('claude-notes-panel').textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('Notes from sessions run in your home folder belong to no project, so a search that names a project is not lent them')
  })

  it('shows the notes switch on and the sharing switch off, as they are by default', async () => {
    await open()
    expect(pressed('claude-notes-index-toggle')).toBe('true')
    expect(pressed('claude-notes-share-toggle')).toBe('false')
    expect(screen.getByTestId('claude-notes-share-toggle').getAttribute('aria-label')).toBe('Let general notes help in other projects')
    expect(screen.getByTestId('claude-notes-index-toggle').getAttribute('aria-label')).toBe("Include Claude Code's saved notes in memory")
  })

  it('says nothing has been imported before the first pass', async () => {
    await open()
    expect(screen.getByTestId('claude-notes-status').textContent).toBe('Nothing imported yet.')
  })

  it('counts what was imported, with the singular where it applies, and when it last ran', async () => {
    mockApi(view({}, { notes: 1, chunks: 1, projects: 1, lastAt: Date.UTC(2026, 9, 31, 12, 0, 0) }))
    await open()
    const t = screen.getByTestId('claude-notes-status').textContent!
    expect(t).toContain('1 note from 1 project is in memory (1 chunk)')
    expect(t).toContain('Last checked:')
    expect(t).not.toContain('not yet')
    cleanup()
    mockApi(view({}, { notes: 69, chunks: 120, projects: 3, lastAt: 5 }))
    await open()
    expect(screen.getByTestId('claude-notes-status').textContent).toContain('69 notes from 3 projects are in memory (120 chunks)')
  })

  it('says "not yet" when notes are counted but no run time is recorded (a hand-edited manifest)', async () => {
    mockApi(view({}, { notes: 2, chunks: 3, projects: 1, lastAt: null }))
    await open()
    expect(screen.getByTestId('claude-notes-status').textContent).toContain('2 notes from 1 project are in memory (3 chunks). Last checked: not yet.')
  })

  it('keeps what it showed, and says so, when a refresh cannot read the settings', async () => {
    mockApi(view({}, { notes: 5, chunks: 5, projects: 2, lastAt: 1 }))
    const { rerender } = await open()
    getSettings.mockImplementationOnce(async () => ({ success: false, error: 'host restarting' }))
    rerender(<ClaudeNotesPanel refreshToken={1} />)
    expect((await screen.findByTestId('claude-notes-error')).textContent).toBe('host restarting')
    expect(screen.getByTestId('claude-notes-status').textContent).toContain('5 notes from 2 projects') // the old numbers stay
  })

  it('reads a run that has happened but found no notes as "0 notes", not as "nothing imported yet"', async () => {
    mockApi(view({}, { lastAt: 1700000000000 }))
    await open()
    expect(screen.getByTestId('claude-notes-status').textContent).toContain('0 notes from 0 projects')
  })

  it('shows a date it cannot format as "not yet", not as a crash', async () => {
    mockApi(view({}, { notes: 2, chunks: 2, projects: 1, lastAt: Number.POSITIVE_INFINITY }))
    await open()
    expect(screen.getByTestId('claude-notes-status').textContent).toMatch(/Last checked: (Invalid Date|not yet)/)
    vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(() => { throw new Error('no locale') })
    cleanup()
    await open()
    expect(screen.getByTestId('claude-notes-status').textContent).toContain('Last checked: not yet')
  })

  it('mentions left-out notes, redacted secrets and waiting removals only when there are some', async () => {
    await open()
    for (const id of ['claude-notes-noproject', 'claude-notes-redacted', 'claude-notes-pending']) expect(screen.queryByTestId(id)).toBeNull()
    cleanup()
    mockApi(view({}, { notes: 4, chunks: 4, projects: 1, lastAt: 1, noProject: 2, secretsRedacted: 1, pending: 3 }))
    await open()
    expect(screen.getByTestId('claude-notes-noproject').textContent).toContain('2 notes were left out')
    expect(screen.getByTestId('claude-notes-redacted').textContent).toContain('1 secret was redacted')
    expect(screen.getByTestId('claude-notes-pending').textContent).toContain('3 removals are waiting')
    cleanup()
    mockApi(view({}, { notes: 4, chunks: 4, projects: 1, lastAt: 1, noProject: 1, secretsRedacted: 2, pending: 1 }))
    await open()
    expect(screen.getByTestId('claude-notes-noproject').textContent).toContain('1 note was left out')
    expect(screen.getByTestId('claude-notes-redacted').textContent).toContain('2 secrets were redacted')
    expect(screen.getByTestId('claude-notes-pending').textContent).toContain('1 removal is waiting')
  })

  it('says plainly that no note is read while the agents are not connected, only when the switch is on', async () => {
    mockApi(view({ connected: false }))
    await open()
    const banner = screen.getByTestId('claude-notes-waiting').textContent ?? ''
    expect(banner).toContain('Your agents are not connected')
    expect(banner).toContain('so no note is read')
    // Connecting does not start a pass; the next check does (about every 30 minutes), and the banner must not promise sooner.
    expect(banner).toContain('picked up at the next check (about every 30 minutes)')
    expect(banner).not.toContain('as soon as')
    cleanup()
    mockApi(view({ connected: false, indexClaudeNotes: false }))
    await open()
    expect(screen.queryByTestId('claude-notes-waiting')).toBeNull()
    cleanup()
    mockApi(view({ connected: true }))
    await open()
    expect(screen.queryByTestId('claude-notes-waiting')).toBeNull()
  })
})

describe('ClaudeNotesPanel: it must be free to look at', () => {
  it('NEVER polls: one read on open, and one more only when the refresh token changes', async () => {
    vi.useFakeTimers()
    const { rerender } = render(<ClaudeNotesPanel />)
    await flush()
    expect(getSettings).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(10 * 60_000) })
    expect(getSettings).toHaveBeenCalledTimes(1)
    rerender(<ClaudeNotesPanel refreshToken={1} />)
    await flush()
    expect(getSettings).toHaveBeenCalledTimes(2)
    rerender(<ClaudeNotesPanel refreshToken={1} />)
    await flush()
    expect(getSettings).toHaveBeenCalledTimes(2)
  })

  it('shows a loading line until the first answer', async () => {
    ;(window as any).termpolis = { memoryGetNotesSettings: vi.fn(() => new Promise(() => {})) }
    render(<ClaudeNotesPanel />)
    expect(screen.getByTestId('claude-notes-loading').textContent).toContain('Reading the saved-notes settings')
  })

  it.each<[string, () => unknown, string]>([
    ['an error from main', async () => ({ success: false, error: 'store offline' }), 'store offline'],
    ['an answer with no error text', async () => ({ success: false }), 'Could not read the saved-notes settings'],
    ['a thrown error', async () => { throw new Error('bridge died') }, 'bridge died'],
    ['a thrown error with no message', async () => { throw new Error('') }, 'Could not read the saved-notes settings'],
  ])('reports a failed read: %s', async (_label, impl, expected) => {
    ;(window as any).termpolis = { memoryGetNotesSettings: vi.fn(impl) }
    render(<ClaudeNotesPanel />)
    expect((await screen.findByTestId('claude-notes-error')).textContent).toBe(expected)
  })

  it('renders (as loading) when the bridge is missing altogether, and does not throw', async () => {
    delete (window as any).termpolis
    render(<ClaudeNotesPanel />)
    expect(await screen.findByTestId('claude-notes-error')).toBeTruthy()
  })

  it('does not set state after it is gone', async () => {
    let release: (v: unknown) => void = () => {}
    ;(window as any).termpolis = { memoryGetNotesSettings: vi.fn(() => new Promise((r) => { release = r })) }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(<ClaudeNotesPanel />)
    unmount()
    await act(async () => { release({ success: true, data: view() }) })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('ClaudeNotesPanel: the switches', () => {
  it('turning the notes off sends exactly that, and the switch shows what main now holds', async () => {
    await open()
    fireEvent.click(screen.getByTestId('claude-notes-index-toggle'))
    await waitFor(() => expect(pressed('claude-notes-index-toggle')).toBe('false'))
    expect(setSettings).toHaveBeenCalledWith({ indexClaudeNotes: false })
  })

  it('turning sharing on sends exactly that', async () => {
    await open()
    fireEvent.click(screen.getByTestId('claude-notes-share-toggle'))
    await waitFor(() => expect(pressed('claude-notes-share-toggle')).toBe('true'))
    expect(setSettings).toHaveBeenCalledWith({ shareNotesAcrossProjects: true })
    fireEvent.click(screen.getByTestId('claude-notes-share-toggle'))
    await waitFor(() => expect(pressed('claude-notes-share-toggle')).toBe('false'))
    expect(setSettings).toHaveBeenLastCalledWith({ shareNotesAcrossProjects: false })
  })

  it('shows what main holds, not what was asked for, when main refuses', async () => {
    setSettings.mockImplementationOnce(async () => ({ success: true, data: view({ indexClaudeNotes: true }) })) // main kept it on
    await open()
    fireEvent.click(screen.getByTestId('claude-notes-index-toggle'))
    await waitFor(() => expect(setSettings).toHaveBeenCalled())
    await flush()
    expect(pressed('claude-notes-index-toggle')).toBe('true')
  })

  it.each<[string, () => unknown, string]>([
    ['an error from main', async () => ({ success: false, error: 'settings file is read-only' }), 'settings file is read-only'],
    ['an answer with no error text', async () => ({ success: false }), 'Could not change the setting'],
    ['a thrown error', async () => { throw new Error('bridge died') }, 'bridge died'],
    ['a thrown error with no message', async () => { throw new Error('') }, 'Could not change the setting'],
  ])('says why a switch did not move: %s', async (_label, impl, expected) => {
    await open()
    setSettings.mockImplementationOnce(impl)
    fireEvent.click(screen.getByTestId('claude-notes-share-toggle'))
    expect((await screen.findByTestId('claude-notes-action-error')).textContent).toBe(expected)
    expect(pressed('claude-notes-share-toggle')).toBe('false') // unchanged
  })

  it('keeps the failure on screen after the panel is refreshed, and clears it on the next attempt', async () => {
    const { rerender } = await open()
    setSettings.mockImplementationOnce(async () => ({ success: false, error: 'nope' }))
    fireEvent.click(screen.getByTestId('claude-notes-share-toggle'))
    await screen.findByTestId('claude-notes-action-error')
    rerender(<ClaudeNotesPanel refreshToken={1} />)
    await flush()
    expect(screen.getByTestId('claude-notes-action-error').textContent).toBe('nope')
    fireEvent.click(screen.getByTestId('claude-notes-share-toggle'))
    await waitFor(() => expect(screen.queryByTestId('claude-notes-action-error')).toBeNull())
  })

  it('marks both switches busy and disables the remove button while a change is in flight, so a second click cannot start another', async () => {
    let release: (v: unknown) => void = () => {}
    await open()
    setSettings.mockImplementationOnce(() => new Promise((r) => { release = r }))
    fireEvent.click(screen.getByTestId('claude-notes-share-toggle'))
    await waitFor(() => expect(screen.getByTestId('claude-notes-index-toggle').getAttribute('aria-disabled')).toBe('true'))
    expect(screen.getByTestId('claude-notes-share-toggle').getAttribute('aria-disabled')).toBe('true')
    expect((screen.getByTestId('claude-notes-remove') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('claude-notes-share-toggle'))
    fireEvent.click(screen.getByTestId('claude-notes-index-toggle'))
    expect(setSettings).toHaveBeenCalledTimes(1) // neither second click did anything
    await act(async () => { release({ success: true, data: view({ shareNotesAcrossProjects: true }) }) })
    expect(screen.getByTestId('claude-notes-index-toggle').getAttribute('aria-disabled')).toBeNull()
    expect((screen.getByTestId('claude-notes-remove') as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not touch its state if it is closed while a change is still in flight', async () => {
    let release: (v: unknown) => void = () => {}
    const { unmount } = await open()
    setSettings.mockImplementationOnce(() => new Promise((r) => { release = r }))
    fireEvent.click(screen.getByTestId('claude-notes-share-toggle'))
    unmount()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => { release({ success: true, data: view({ shareNotesAcrossProjects: true }) }) })
    expect(spy).not.toHaveBeenCalled()
  })

  it('works when the bridge lacks the setter (an older preload): it reports a failure instead of throwing', async () => {
    await open()
    delete (window as any).termpolis.memorySetNotesSettings
    fireEvent.click(screen.getByTestId('claude-notes-share-toggle'))
    expect((await screen.findByTestId('claude-notes-action-error')).textContent).toBe('Could not change the setting')
  })
})

describe('ClaudeNotesPanel: Remove imported notes', () => {
  it('asks before it does anything, and Cancel does nothing', async () => {
    await open()
    fireEvent.click(screen.getByTestId('claude-notes-remove'))
    expect(screen.getByTestId('claude-notes-panel').textContent).toContain('Remove every imported note from memory and turn the import off?')
    expect(removeNotes).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('claude-notes-remove-cancel'))
    expect(removeNotes).not.toHaveBeenCalled()
    expect(screen.getByTestId('claude-notes-remove')).toBeTruthy()
    expect(screen.queryByTestId('claude-notes-remove-confirm')).toBeNull()
  })

  it('removes after Remove is confirmed, shows the import off, and says what was done', async () => {
    mockApi(view({}, { notes: 7, chunks: 7, projects: 2, lastAt: 1 }))
    await open()
    fireEvent.click(screen.getByTestId('claude-notes-remove'))
    fireEvent.click(screen.getByTestId('claude-notes-remove-confirm'))
    await waitFor(() => expect(removeNotes).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(pressed('claude-notes-index-toggle')).toBe('false'))
    expect(screen.getByTestId('claude-notes-notice').textContent).toBe('Removed 7 note chunks from memory. The import is off; turn it on to bring them back.')
    expect(screen.getByTestId('claude-notes-status').textContent).toContain('0 notes')
    expect(screen.getByTestId('claude-notes-remove')).toBeTruthy() // the confirmation is gone
  })

  it('says how many could not be removed, and that they will be retried', async () => {
    removeNotes.mockImplementationOnce(async () => ({ success: true, data: { removed: 1, failed: 2, settings: view({ indexClaudeNotes: false }, { pending: 2 }) } }))
    await open()
    fireEvent.click(screen.getByTestId('claude-notes-remove'))
    fireEvent.click(screen.getByTestId('claude-notes-remove-confirm'))
    const notice = (await screen.findByTestId('claude-notes-notice')).textContent!
    expect(notice).toContain('Removed 1 note chunk.')
    expect(notice).toContain('2 chunks could not be removed yet')
    expect(screen.getByTestId('claude-notes-pending').textContent).toContain('2 removals are waiting')
  })

  it.each<[string, () => unknown, string]>([
    ['an error from main', async () => ({ success: false, error: 'memory is locked' }), 'memory is locked'],
    ['an answer with no error text', async () => ({ success: false }), 'Could not remove the imported notes'],
    ['a thrown error', async () => { throw new Error('bridge died') }, 'bridge died'],
    ['a thrown error with no message', async () => { throw new Error('') }, 'Could not remove the imported notes'],
  ])('says why it could not remove: %s', async (_label, impl, expected) => {
    removeNotes.mockImplementationOnce(impl)
    await open()
    fireEvent.click(screen.getByTestId('claude-notes-remove'))
    fireEvent.click(screen.getByTestId('claude-notes-remove-confirm'))
    expect((await screen.findByTestId('claude-notes-action-error')).textContent).toBe(expected)
  })

  it('ignores a second confirm while the first is running, and a bridge without the call', async () => {
    let release: (v: unknown) => void = () => {}
    await open()
    removeNotes.mockImplementationOnce(() => new Promise((r) => { release = r }))
    fireEvent.click(screen.getByTestId('claude-notes-remove'))
    fireEvent.click(screen.getByTestId('claude-notes-remove-confirm'))
    await waitFor(() => expect(removeNotes).toHaveBeenCalledTimes(1))
    await act(async () => { release({ success: true, data: { removed: 0, failed: 0, settings: view({ indexClaudeNotes: false }) } }) })
    delete (window as any).termpolis.memoryRemoveImportedNotes
    fireEvent.click(screen.getByTestId('claude-notes-remove'))
    fireEvent.click(screen.getByTestId('claude-notes-remove-confirm'))
    expect((await screen.findByTestId('claude-notes-action-error')).textContent).toBe('Could not remove the imported notes')
  })

  it('does not touch its state if it is closed while the removal is still running', async () => {
    let release: (v: unknown) => void = () => {}
    removeNotes.mockImplementationOnce(() => new Promise((r) => { release = r }))
    const { unmount } = await open()
    fireEvent.click(screen.getByTestId('claude-notes-remove'))
    fireEvent.click(screen.getByTestId('claude-notes-remove-confirm'))
    await waitFor(() => expect(removeNotes).toHaveBeenCalled())
    unmount()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => { release({ success: true, data: { removed: 1, failed: 0, settings: view() } }) })
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not touch its state if it is closed while the removal fails', async () => {
    let fail: (e: Error) => void = () => {}
    removeNotes.mockImplementationOnce(() => new Promise((_r, rej) => { fail = rej }))
    const { unmount } = await open()
    fireEvent.click(screen.getByTestId('claude-notes-remove'))
    fireEvent.click(screen.getByTestId('claude-notes-remove-confirm'))
    await waitFor(() => expect(removeNotes).toHaveBeenCalled())
    unmount()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => { fail(new Error('late')) })
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not touch its state if it is closed while a switch change fails', async () => {
    let fail: (e: Error) => void = () => {}
    const { unmount } = await open()
    setSettings.mockImplementationOnce(() => new Promise((_r, rej) => { fail = rej }))
    fireEvent.click(screen.getByTestId('claude-notes-share-toggle'))
    unmount()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => { fail(new Error('late')) })
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not touch its state if it is closed while the first read fails', async () => {
    let fail: (e: Error) => void = () => {}
    ;(window as any).termpolis = { memoryGetNotesSettings: vi.fn(() => new Promise((_r, rej) => { fail = rej })) }
    const { unmount } = render(<ClaudeNotesPanel />)
    unmount()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => { fail(new Error('late')) })
    expect(spy).not.toHaveBeenCalled()
  })
})

// The panel is operated from the keyboard and read by a screen reader as well as by a mouse. The switches are buttons (so Space and
// Enter work); what is left is that a click on the words beside a switch flips it, that focus is never dropped on the floor when
// the confirm step opens and closes, and that what the panel says after an action is announced.
describe('ClaudeNotesPanel: keyboard and screen reader', () => {
  it('flips a switch from a click on the words beside it, and tells the switch apart by its label', async () => {
    await open()
    for (const [id, text] of [
      ['claude-notes-index-toggle', 'Include Claude Code’s saved notes in memory'],
      ['claude-notes-share-toggle', 'Let general notes help in other projects'],
    ] as const) {
      const label = screen.getByText(text, { selector: 'label' })
      expect(label.getAttribute('for')).toBe(screen.getByTestId(id).id)
      expect(screen.getByTestId(id).id).not.toBe('')
    }
    const before = pressed('claude-notes-share-toggle')
    fireEvent.click(screen.getByText('Let general notes help in other projects', { selector: 'label' }))
    await flush()
    expect(setSettings).toHaveBeenCalledWith({ shareNotesAcrossProjects: before !== 'true' })
  })

  it('puts focus on the safe choice when the confirm step opens, and back on the button that opened it', async () => {
    await open()
    fireEvent.click(screen.getByTestId('claude-notes-remove'))
    expect(document.activeElement).toBe(screen.getByTestId('claude-notes-remove-cancel')) // not on Remove: a held key must not confirm
    fireEvent.click(screen.getByTestId('claude-notes-remove-cancel'))
    await flush()
    expect(document.activeElement).toBe(screen.getByTestId('claude-notes-remove'))
  })

  it('puts focus back on the button once a removal has finished, not before: a button in flight is disabled', async () => {
    await open()
    fireEvent.click(screen.getByTestId('claude-notes-remove'))
    fireEvent.click(screen.getByTestId('claude-notes-remove-confirm'))
    await flush(); await flush()
    expect(removeNotes).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(screen.getByTestId('claude-notes-remove'))
  })

  it('does not take focus on first render or while nothing is being confirmed', async () => {
    await open()
    expect(document.activeElement).toBe(document.body)
  })

  // A switch that went disabled while it held focus handed focus to the page, so a person flipping it with the keyboard lost their
  // place and heard nothing of the new state. It is now busy, not disabled, and keeps focus through the change.
  it('keeps keyboard focus on a switch through the change it makes', async () => {
    let release: (v: unknown) => void = () => {}
    await open()
    const toggle = screen.getByTestId('claude-notes-share-toggle')
    toggle.focus()
    setSettings.mockImplementationOnce(() => new Promise((r) => { release = r }))
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-disabled')).toBe('true'))
    expect(document.activeElement).toBe(toggle) // in flight
    await act(async () => { release({ success: true, data: view({ shareNotesAcrossProjects: true }) }) })
    expect(document.activeElement).toBe(toggle) // and after
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
  })

  it('leaves focus where the person put it when a switch is used while the removal is being confirmed', async () => {
    await open()
    fireEvent.click(screen.getByTestId('claude-notes-remove'))
    expect(document.activeElement).toBe(screen.getByTestId('claude-notes-remove-cancel'))
    const toggle = screen.getByTestId('claude-notes-share-toggle')
    toggle.focus()
    fireEvent.click(toggle)
    await flush(); await flush()
    expect(setSettings).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(toggle) // not pulled back to Cancel when the change finished
    expect(screen.getByTestId('claude-notes-remove-confirm')).toBeTruthy() // the question is still open
  })

  it('closes the confirm step on Escape, back on the button that opened it, and does nothing on Escape otherwise', async () => {
    await open()
    fireEvent.keyDown(screen.getByTestId('claude-notes-remove'), { key: 'Escape' })
    expect(screen.queryByTestId('claude-notes-remove-confirm')).toBeNull() // nothing was open
    fireEvent.click(screen.getByTestId('claude-notes-remove'))
    const outer = vi.fn()
    document.addEventListener('keydown', outer)
    fireEvent.keyDown(screen.getByTestId('claude-notes-remove-cancel'), { key: 'Escape' })
    document.removeEventListener('keydown', outer)
    expect(screen.queryByTestId('claude-notes-remove-confirm')).toBeNull()
    expect(outer).not.toHaveBeenCalled() // the Settings pane does not also close
    await flush()
    expect(document.activeElement).toBe(screen.getByTestId('claude-notes-remove'))
    expect(removeNotes).not.toHaveBeenCalled()
  })

  it('leaves other keys alone while the confirm step is open', async () => {
    await open()
    fireEvent.click(screen.getByTestId('claude-notes-remove'))
    fireEvent.keyDown(screen.getByTestId('claude-notes-remove-cancel'), { key: 'a' })
    expect(screen.getByTestId('claude-notes-remove-confirm')).toBeTruthy()
  })

  it('announces the result of a removal politely, and a failure at once', async () => {
    await open()
    fireEvent.click(screen.getByTestId('claude-notes-remove'))
    fireEvent.click(screen.getByTestId('claude-notes-remove-confirm'))
    await flush(); await flush()
    expect(screen.getByTestId('claude-notes-notice').getAttribute('role')).toBe('status')

    removeNotes.mockImplementationOnce(async () => ({ success: false, error: 'memory is locked' }))
    fireEvent.click(screen.getByTestId('claude-notes-remove'))
    fireEvent.click(screen.getByTestId('claude-notes-remove-confirm'))
    await flush(); await flush()
    expect(screen.getByTestId('claude-notes-action-error').getAttribute('role')).toBe('alert')
  })

  it('announces that the agents are not connected, and a failed read', async () => {
    mockApi(view({ connected: false }))
    await open()
    expect(screen.getByTestId('claude-notes-waiting').getAttribute('role')).toBe('status')
    // An install an older version connected, that nobody has asked, reads as not connected here too: the banner says so.
    expect(screen.getByTestId('claude-notes-waiting').textContent).toMatch(/earlier version connected them and you have not been asked yet/)
    cleanup()
    getSettings = vi.fn(async () => ({ success: false, error: 'no host' }))
    ;(window as any).termpolis.memoryGetNotesSettings = getSettings
    render(<ClaudeNotesPanel />) // there is no panel to wait for when the read fails
    expect((await screen.findByTestId('claude-notes-error')).getAttribute('role')).toBe('alert')
  })

  it('says it with the right verb for one note and for many', async () => {
    mockApi(view({}, { notes: 1, chunks: 2, projects: 1 }))
    await open()
    expect(screen.getByTestId('claude-notes-status').textContent).toContain('1 note from 1 project is in memory')
    cleanup()
    mockApi(view({}, { notes: 2, chunks: 3, projects: 1 }))
    await open()
    expect(screen.getByTestId('claude-notes-status').textContent).toContain('2 notes from 1 project are in memory')
  })
})

describe('ClaudeNotesPanel: memory is locked', () => {
  it('says so, instead of leaving a switch that does nothing and a status that gives no reason', async () => {
    mockApi(view({ locked: true }))
    await open()
    const banner = screen.getByTestId('claude-notes-locked')
    expect(banner.getAttribute('role')).toBe('status')
    expect(banner.textContent).toContain('Memory is locked')
    expect(banner.textContent).toContain('nothing is read or removed')
    expect(banner.textContent).toContain('Memory panel')
  })

  it('says nothing when memory is open, or when the answer does not say', async () => {
    mockApi(view({ locked: false }))
    await open()
    expect(screen.queryByTestId('claude-notes-locked')).toBeNull()
    cleanup()
    mockApi(view())
    await open()
    expect(screen.queryByTestId('claude-notes-locked')).toBeNull()
  })

  it('can be shown with the agents-not-connected note: they are two separate reasons', async () => {
    mockApi(view({ locked: true, connected: false }))
    await open()
    expect(screen.getByTestId('claude-notes-locked')).toBeTruthy()
    expect(screen.getByTestId('claude-notes-waiting')).toBeTruthy()
  })
})
