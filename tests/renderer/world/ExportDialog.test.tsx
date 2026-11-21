import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import type { WorldExportInfo, WorldExportProgressEvent } from '../../../src/shared/world/types'
import { NO_MODEL } from '../../../src/shared/world/exportMeta'
import { ExportDialog, ExportToast } from '../../../src/renderer/src/components/World/ExportDialog'
import { formatMb, savedAtText } from '../../../src/renderer/src/components/World/exportFormat'
import { UI_FAILED } from '../../../src/renderer/src/components/World/worldTargets'

// The export dialog asks main what the world holds (world:export-info), lets the person choose smart Ask and a
// proposal, runs one export with its own id (world:export), follows that export's progress and cancels it on
// Cancel, on Esc (the pane unmounts the dialog) or when the pane closes. A saved file goes to onSaved: the pane
// shows the toast (ExportToast) in its notice slot.

type Res<T> = { success: true; data: T } | { success: false; error: string }
const ok = <T,>(data: T): Res<T> => ({ success: true, data })
const fail = (error: string): Res<never> => ({ success: false, error })
const MB = 1024 * 1024

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const info = (over: Partial<WorldExportInfo> = {}): WorldExportInfo => ({
  title: 'termpolis', savedAt: new Date(2026, 10, 21, 9, 41).getTime(), smartDefault: true, buildings: 0.9, lines: 0.85,
  smartBytes: 37 * MB, keywordBytes: 1.1 * MB, smartAvailable: true, proposals: [], ...over,
})

type ExportRes = Res<{ path: string; bytes: number } | { cancelled: true }> & { keywordOnly?: true }

function bridge(over: Record<string, unknown> = {}) {
  const listeners = new Set<(e: WorldExportProgressEvent) => void>()
  const api = {
    worldExportInfo: vi.fn(async (_req: unknown): Promise<Res<WorldExportInfo>> => ok(info())),
    worldExport: vi.fn(async (_req: unknown): Promise<ExportRes> => ok({ path: 'C:/Users/me/Documents/termpolis.html', bytes: 37 * MB })),
    worldExportCancel: vi.fn(async (_id: string) => ok(true)),
    onWorldExportProgress: vi.fn((cb: (e: WorldExportProgressEvent) => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }),
    worldShowFile: vi.fn(async (_p: string): Promise<Res<boolean>> => ok(true)),
    worldOpenFile: vi.fn(async (_p: string): Promise<Res<boolean>> => ok(true)),
    ...over,
  }
  ;(window as any).termpolis = api
  return {
    api,
    progress: (e: Partial<WorldExportProgressEvent>) => act(() => { for (const cb of listeners) cb({ exportId: 'id-1', step: 'prepare', done: 0, total: 1, ...e }) }),
    listeners: () => listeners.size,
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
}

async function mount(props: Partial<{ root: string; designKey: string; mapRun: 'describing' | 'updating' | null; describeOn: boolean }> = {}) {
  const onClose = vi.fn()
  const onSaved = vi.fn()
  const utils = render(
    <ExportDialog
      root={'designKey' in props ? undefined : props.root ?? '/repo'}
      designKey={props.designKey}
      mapRun={props.mapRun ?? null}
      describeOn={props.describeOn ?? true}
      onClose={onClose}
      onSaved={onSaved}
    />,
  )
  await settle()
  return { ...utils, onClose, onSaved }
}

const smart = () => screen.getByLabelText('Include smart Ask (works offline, adds ~35 MB)') as HTMLInputElement
const exportBtn = () => screen.getByRole('button', { name: /^Export…$|^Exporting…$/ })
const steps = () => Array.from(screen.getByTestId('world-export-steps').querySelectorAll('li')).map((li) => `${li.getAttribute('data-state')}:${li.textContent}`)

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('id-1' as ReturnType<typeof crypto.randomUUID>)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('formatMb and savedAtText', () => {
  it('rounds to one decimal under 10 MB (never below 0.1) and to whole MB above', () => {
    expect(formatMb(1.14 * MB)).toBe('1.1')
    expect(formatMb(9.96 * MB)).toBe('10')
    expect(formatMb(36.6 * MB)).toBe('37')
    expect(formatMb(2000)).toBe('0.1')
    expect(formatMb(0)).toBe('0.1')
  })

  it('a save today is its time; an older one also names the day', () => {
    const saved = new Date(2026, 10, 21, 9, 41)
    const time = saved.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    expect(savedAtText(saved.getTime(), new Date(2026, 10, 21, 18, 0).getTime())).toBe(time)
    expect(savedAtText(saved.getTime(), new Date(2026, 10, 22, 8, 0).getTime())).toBe(`${saved.toLocaleDateString()} ${time}`)
  })
})

describe('ExportDialog', () => {
  it('asks for the world it names and shows the dialog with the spec copy, smart Ask on when it is the default', async () => {
    const b = bridge()
    await mount()
    expect(b.api.worldExportInfo).toHaveBeenCalledWith({ root: '/repo', designKey: undefined })
    const dialog = screen.getByRole('dialog', { name: 'Export Lumopolis world' })
    expect(dialog).toHaveAttribute('data-testid', 'world-export-dialog')
    expect(screen.getByRole('heading')).toHaveTextContent('Export Lumopolis world')
    expect(smart().checked).toBe(true)
    expect(smart().disabled).toBe(false)
    expect(dialog).toHaveTextContent('Finds the parts that match a question by meaning.')
    expect(dialog).toHaveTextContent('Includes cards, tours, layers and themes. Not included: your conversation, and file paths outside the project.')
    expect(screen.queryByTestId('world-export-note')).toBeNull()
    expect(screen.queryByTestId('world-export-keyword')).toBeNull()
    expect(screen.queryByTestId('world-export-saved-at')).toBeNull()
    expect(screen.getByTestId('world-export-size')).toHaveTextContent('About 37 MB')
    // No proposals: no choice of scope.
    expect(screen.queryByLabelText('Whole world')).toBeNull()
    expect(exportBtn()).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('shows that it is reading the world until the info arrives, with Export off', async () => {
    const pending = deferred<Res<WorldExportInfo>>()
    bridge({ worldExportInfo: vi.fn(() => pending.promise) })
    await mount()
    expect(screen.getByTestId('world-export-loading')).toHaveTextContent('Reading the world…')
    expect(exportBtn()).toBeDisabled()
    expect(screen.queryByTestId('world-export-size')).toBeNull()
    await act(async () => { pending.resolve(ok(info())) })
    expect(screen.queryByTestId('world-export-loading')).toBeNull()
    expect(exportBtn()).toBeEnabled()
  })

  it('a design is named by its key', async () => {
    const b = bridge()
    await mount({ designKey: 'design:d1' })
    expect(b.api.worldExportInfo).toHaveBeenCalledWith({ root: undefined, designKey: 'design:d1' })
    fireEvent.click(exportBtn())
    expect(b.api.worldExport).toHaveBeenCalledWith({ exportId: 'id-1', root: undefined, designKey: 'design:d1', smart: true, proposalId: undefined })
  })

  it('a low-described world starts with smart Ask off and the note; switching it on keeps the note, and the size follows the switch', async () => {
    bridge({ worldExportInfo: vi.fn(async () => ok(info({ smartDefault: false }))) })
    await mount()
    expect(smart().checked).toBe(false)
    expect(screen.getByTestId('world-export-note')).toHaveTextContent(
      "Most parts aren't described yet, so smart Ask would mostly match file names. Press Re-layout to have Lumopolis describe them, or export with keyword Ask.",
    )
    expect(screen.getByTestId('world-export-size')).toHaveTextContent('About 1.1 MB')
    fireEvent.click(smart())
    expect(smart().checked).toBe(true)
    expect(screen.getByTestId('world-export-size')).toHaveTextContent('About 37 MB')
    expect(screen.getByTestId('world-export-note')).toBeInTheDocument()
    fireEvent.click(smart())
    expect(screen.getByTestId('world-export-size')).toHaveTextContent('About 1.1 MB')
  })

  it.each([
    ['still describing its parts', 'describing', 'Lumopolis is still describing its parts.'],
    ['updating the map in any other way', 'updating', 'Lumopolis is still updating it.'],
  ] as const)('while Lumopolis is %s it says which saved map it uses, and what is still going', async (_what, mapRun, tail) => {
    bridge()
    await mount({ mapRun })
    expect(screen.getByTestId('world-export-saved-at')).toHaveTextContent(`Uses the map as it was saved at ${savedAtText(info().savedAt)}; ${tail}`)
  })

  it.each([
    ['a run is going', { mapRun: 'describing' as const }, 'Wait for Lumopolis to finish updating the map, or export with keyword Ask.'],
    ['a compile with no describing is going', { mapRun: 'updating' as const }, 'Wait for Lumopolis to finish updating the map, or export with keyword Ask.'],
    ['describing parts with AI is off', { describeOn: false }, 'Turn on Describe parts with AI in Settings, then press Re-layout, or export with keyword Ask.'],
    ['describing is off, even while a run is going', { describeOn: false, mapRun: 'updating' as const }, 'Turn on Describe parts with AI in Settings, then press Re-layout, or export with keyword Ask.'],
    ['the world is a design', { designKey: 'design:d1', describeOn: false }, 'Ask Lumopolis to say what each part does, or export with keyword Ask.'],
  ])('the low-description note says what to do when %s', async (_what, props, tail) => {
    bridge({ worldExportInfo: vi.fn(async () => ok(info({ smartDefault: false }))) })
    await mount(props)
    expect(screen.getByTestId('world-export-note')).toHaveTextContent(
      `Most parts aren't described yet, so smart Ask would mostly match file names. ${tail}`,
    )
  })

  it('without the smart Ask model the switch is off and disabled, with main\'s sentence', async () => {
    bridge({ worldExportInfo: vi.fn(async () => ok(info({ smartDefault: false, smartAvailable: false }))) })
    await mount()
    expect(smart().checked).toBe(false)
    expect(smart().disabled).toBe(true)
    expect(screen.getByTestId('world-export-keyword')).toHaveTextContent(NO_MODEL)
    // The low-description note is about smart Ask, which this copy can't offer.
    expect(screen.queryByTestId('world-export-note')).toBeNull()
    expect(screen.getByTestId('world-export-size')).toHaveTextContent('About 1.1 MB')
  })

  it('an info error shows its sentence and Export stays off; a thrown info says Lumopolis could not', async () => {
    bridge({ worldExportInfo: vi.fn(async () => fail("This world can't be exported.")) })
    await mount()
    expect(screen.getByRole('alert')).toHaveTextContent("This world can't be exported.")
    expect(exportBtn()).toBeDisabled()
    expect(screen.queryByTestId('world-export-loading')).toBeNull()
    cleanup()
    bridge({ worldExportInfo: vi.fn(async () => { throw new Error('bridge down') }) })
    await mount()
    expect(screen.getByRole('alert')).toHaveTextContent(UI_FAILED)
    expect(exportBtn()).toBeDisabled()
  })

  it('with proposals the person exports the whole world or one proposal', async () => {
    const b = bridge({ worldExportInfo: vi.fn(async () => ok(info({ proposals: [{ id: 'p1', title: 'Plan one' }, { id: 'p2', title: 'Plan two' }] }))) })
    await mount()
    const whole = screen.getByLabelText('Whole world') as HTMLInputElement
    // The choice is labelled What (spec 5.2), and read out as one group.
    const what = screen.getByRole('radiogroup', { name: 'What' })
    expect(what).toHaveTextContent(/^What/)
    const one = screen.getByLabelText('Proposal:') as HTMLInputElement
    const pick = screen.getByLabelText('Proposal to export') as HTMLSelectElement
    expect(whole.checked).toBe(true)
    expect(pick.disabled).toBe(true)
    expect(pick.value).toBe('p1')
    fireEvent.click(one)
    expect(pick.disabled).toBe(false)
    fireEvent.change(pick, { target: { value: 'p2' } })
    fireEvent.click(exportBtn())
    expect(b.api.worldExport).toHaveBeenLastCalledWith({ exportId: 'id-1', root: '/repo', designKey: undefined, smart: true, proposalId: 'p2' })
  })

  it('the whole world sends no proposal, and smart off sends smart false', async () => {
    const b = bridge({ worldExportInfo: vi.fn(async () => ok(info({ proposals: [{ id: 'p1', title: 'Plan one' }] }))) })
    await mount()
    fireEvent.click(screen.getByLabelText('Proposal:'))
    fireEvent.click(screen.getByLabelText('Whole world'))
    fireEvent.click(smart())
    fireEvent.click(exportBtn())
    expect(b.api.worldExport).toHaveBeenLastCalledWith({ exportId: 'id-1', root: '/repo', designKey: undefined, smart: false, proposalId: undefined })
  })

  it('progress for this export advances the steps and the bar; another export\'s progress is ignored', async () => {
    const run = deferred<ExportRes>()
    const b = bridge({ worldExport: vi.fn(() => run.promise) })
    const m = await mount()
    fireEvent.click(exportBtn())
    expect(exportBtn()).toHaveTextContent('Exporting…')
    expect(exportBtn()).toBeDisabled()
    expect(smart().disabled).toBe(true)
    expect(steps()).toEqual(['current:Preparing the map', 'pending:Indexing parts for smart Ask', 'pending:Writing the file'])
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
    b.progress({ step: 'prepare', done: 1, total: 1 })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    b.progress({ step: 'index', done: 0, total: 697 })
    expect(steps()).toEqual(['done:Preparing the map', 'current:Indexing 697 parts for smart Ask', 'pending:Writing the file'])
    b.progress({ step: 'index', done: 300, total: 697 })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '43')
    expect(screen.getByTestId('world-export-count')).toHaveTextContent('300 of 697')
    b.progress({ exportId: 'someone-else', step: 'write', done: 0, total: 1 })
    expect(steps()[1]).toBe('current:Indexing 697 parts for smart Ask')
    b.progress({ step: 'write', done: 0, total: 1 })
    expect(steps()).toEqual(['done:Preparing the map', 'done:Indexing 697 parts for smart Ask', 'current:Writing the file'])
    expect(screen.queryByTestId('world-export-count')).toBeNull()
    await act(async () => { run.resolve(ok({ path: 'C:\\out\\termpolis.html', bytes: 37 * MB })) })
    expect(m.onSaved).toHaveBeenCalledWith({ path: 'C:\\out\\termpolis.html', bytes: 37 * MB })
    expect(m.onClose).toHaveBeenCalledTimes(1)
  })

  it('a keyword export has no indexing step, and a step with no total yet shows an empty bar', async () => {
    const b = bridge({ worldExport: vi.fn(() => new Promise(() => undefined)) })
    await mount()
    fireEvent.click(smart())
    fireEvent.click(exportBtn())
    expect(steps()).toEqual(['current:Preparing the map', 'pending:Writing the file'])
    b.progress({ step: 'write', done: 0, total: 0 })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
  })

  it('Cancel while exporting cancels that export by its id and closes; the unmount does not cancel twice', async () => {
    const b = bridge({ worldExport: vi.fn(() => new Promise(() => undefined)) })
    const m = await mount()
    fireEvent.click(exportBtn())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(b.api.worldExportCancel).toHaveBeenCalledWith('id-1')
    expect(m.onClose).toHaveBeenCalledTimes(1)
    m.unmount()
    expect(b.api.worldExportCancel).toHaveBeenCalledTimes(1)
    expect(b.listeners()).toBe(0)
  })

  it('Cancel leaves the dialog idle, so a parent that keeps it mounted shows Export again, not Exporting', async () => {
    const b = bridge({ worldExport: vi.fn(() => new Promise(() => undefined)) })
    const m = await mount()
    fireEvent.click(exportBtn())
    expect(exportBtn()).toHaveTextContent('Exporting…')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(m.onClose).toHaveBeenCalledTimes(1)
    expect(exportBtn()).toHaveTextContent('Export…')
    expect(exportBtn()).toBeEnabled()
    expect(screen.queryByTestId('world-export-steps')).toBeNull()
    // A second run after the cancel is a new export with its own id.
    fireEvent.click(exportBtn())
    expect(b.api.worldExport).toHaveBeenCalledTimes(2)
    expect(exportBtn()).toHaveTextContent('Exporting…')
  })

  it('Cancel before exporting only closes', async () => {
    const b = bridge()
    const m = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(m.onClose).toHaveBeenCalledTimes(1)
    expect(b.api.worldExportCancel).not.toHaveBeenCalled()
  })

  it('unmounting mid-export (Esc, or the pane closing) cancels it and stops listening; a cancel that throws is ignored', async () => {
    const b = bridge({ worldExport: vi.fn(() => new Promise(() => undefined)), worldExportCancel: vi.fn(async () => { throw new Error('gone') }) })
    const m = await mount()
    expect(b.listeners()).toBe(1)
    fireEvent.click(exportBtn())
    m.unmount()
    await settle()
    expect(b.api.worldExportCancel).toHaveBeenCalledWith('id-1')
    expect(b.listeners()).toBe(0)
  })

  it('unmounting while idle cancels nothing', async () => {
    const b = bridge()
    const m = await mount()
    m.unmount()
    expect(b.api.worldExportCancel).not.toHaveBeenCalled()
    expect(b.listeners()).toBe(0)
  })

  it('a cancel that lost the race still reports the saved file', async () => {
    const run = deferred<ExportRes>()
    bridge({ worldExport: vi.fn(() => run.promise) })
    const m = await mount()
    fireEvent.click(exportBtn())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    m.unmount()
    await act(async () => { run.resolve(ok({ path: '/out/termpolis.html', bytes: 2 * MB })) })
    expect(m.onSaved).toHaveBeenCalledWith({ path: '/out/termpolis.html', bytes: 2 * MB })
  })

  it('a cancelled export that ends in an error or a throw, after Cancel, shows nothing', async () => {
    const first = deferred<ExportRes>()
    const second = deferred<ExportRes>()
    bridge({ worldExport: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) })
    const m = await mount()
    fireEvent.click(exportBtn())
    // The pane would unmount the dialog on close; here it stays, so a late answer has a dialog to reach.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => { first.resolve(fail('Export was cancelled.')) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(exportBtn()).toHaveTextContent('Export…')
    m.unmount()
    const n = await mount()
    fireEvent.click(exportBtn())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => { second.reject(new Error('late')) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(m.onSaved).not.toHaveBeenCalled()
    expect(n.onSaved).not.toHaveBeenCalled()
  })

  it('a closed save dialog returns to the dialog with Export on again', async () => {
    const b = bridge({ worldExport: vi.fn(async () => ok({ cancelled: true as const })) })
    const m = await mount()
    fireEvent.click(exportBtn())
    await settle()
    expect(m.onClose).not.toHaveBeenCalled()
    expect(m.onSaved).not.toHaveBeenCalled()
    expect(screen.queryByTestId('world-export-steps')).toBeNull()
    expect(exportBtn()).toHaveTextContent('Export…')
    expect(exportBtn()).toBeEnabled()
    // Progress after the run is over is not shown.
    b.progress({ step: 'write', done: 0, total: 1 })
    expect(screen.queryByTestId('world-export-steps')).toBeNull()
  })

  it('an export error shows its sentence and the dialog stays; a thrown export says Lumopolis could not', async () => {
    const b = bridge({ worldExport: vi.fn().mockResolvedValueOnce(fail("There isn't enough space on that drive to save the file.")).mockRejectedValueOnce(new Error('x')) })
    const m = await mount()
    fireEvent.click(exportBtn())
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent("There isn't enough space on that drive to save the file.")
    expect(exportBtn()).toBeEnabled()
    expect(smart().checked).toBe(true)
    fireEvent.click(exportBtn())
    // A new run clears the last error.
    expect(screen.queryByRole('alert')).toBeNull()
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent(UI_FAILED)
    expect(m.onClose).not.toHaveBeenCalled()
    expect(b.api.worldExport).toHaveBeenCalledTimes(2)
  })

  it('a smart export that can only use keyword Ask says why, turns smart Ask off and lets a second click export with keywords', async () => {
    const KEYWORD_ONLY = "Smart Ask couldn't index this world, so this export can use keyword Ask only."
    const b = bridge({
      worldExport: vi.fn()
        .mockResolvedValueOnce({ success: false, error: KEYWORD_ONLY, keywordOnly: true })
        .mockResolvedValueOnce(ok({ path: '/out/termpolis.html', bytes: 1.1 * MB })),
    })
    const m = await mount()
    fireEvent.click(exportBtn())
    await settle()
    expect(screen.getByTestId('world-export-keyword')).toHaveTextContent(KEYWORD_ONLY)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(smart().checked).toBe(false)
    expect(smart().disabled).toBe(true)
    expect(screen.getByTestId('world-export-size')).toHaveTextContent('About 1.1 MB')
    expect(exportBtn()).toBeEnabled()
    expect(m.onClose).not.toHaveBeenCalled()
    fireEvent.click(exportBtn())
    expect(b.api.worldExport).toHaveBeenLastCalledWith(expect.objectContaining({ smart: false }))
    await settle()
    expect(m.onSaved).toHaveBeenCalledWith({ path: '/out/termpolis.html', bytes: 1.1 * MB })
  })
})

describe('ExportToast', () => {
  const file = { path: 'C:\\Users\\me\\Documents\\termpolis.html', bytes: 36.6 * MB }

  it('names the saved file and its size, and its buttons show it in its folder and open it', async () => {
    const b = bridge()
    const onDismiss = vi.fn()
    render(<ExportToast file={file} onDismiss={onDismiss} />)
    expect(screen.getByTestId('world-export-toast')).toHaveTextContent('Exported termpolis.html (37 MB)')
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }))
    expect(b.api.worldShowFile).toHaveBeenCalledWith(file.path)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(b.api.worldOpenFile).toHaveBeenCalledWith(file.path)
    await settle()
    expect(screen.getByTestId('world-export-toast')).toHaveTextContent('Exported termpolis.html (37 MB)')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('a forward-slash path is named by its last part too', () => {
    bridge()
    render(<ExportToast file={{ path: '/home/me/termpolis docs.html', bytes: 40_000 }} onDismiss={vi.fn()} />)
    expect(screen.getByTestId('world-export-toast')).toHaveTextContent('Exported termpolis docs.html (0.1 MB)')
  })

  it('a refusal shows its sentence; a thrown call says Lumopolis could not', async () => {
    bridge({
      worldShowFile: vi.fn(async () => fail("Termpolis couldn't open that file.")),
      worldOpenFile: vi.fn(async () => { throw new Error('x') }),
    })
    render(<ExportToast file={file} onDismiss={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }))
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent("Termpolis couldn't open that file.")
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent(UI_FAILED)
  })
})
