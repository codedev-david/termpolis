// The Lumopolis home and its dialogs (Plan 4, Task 6): the four ways in, the recent worlds, the clone
// and design-start dialogs, Build it and the toolbar's world switcher. The bridge is mocked; every
// call is checked for what it was handed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup, within } from '@testing-library/react'
import type { WorldEntry, WorldFolderPick, BuildItResult } from '../../../src/shared/world/types'
import { BAD_URL_MESSAGE, BAD_REF_MESSAGE } from '../../../src/shared/world/gitUrl'

const vm = vi.hoisted(() => ({
  status: 'idle' as string, errorMsg: null as string | null, notice: null as string | null, toggle: vi.fn(),
  sink: null as null | ((t: string) => void),
}))
vi.mock('../../../src/renderer/src/hooks/useVoiceInput', () => ({
  useVoiceInput: (...args: unknown[]) => {
    vm.sink = (args[2] as { onTranscript: (t: string) => void }).onTranscript
    return { status: vm.status, errorMsg: vm.errorMsg, notice: vm.notice, toggle: vm.toggle }
  },
}))

import { WorldHome, agoText, targetOf } from '../../../src/renderer/src/components/World/WorldHome'
import { CloneDialog, CLONE_KEPT_MESSAGE, SIGNING_IN_MESSAGE, STOPPING_MESSAGE, TOKEN_STOPPED_MESSAGE } from '../../../src/renderer/src/components/World/CloneDialog'
import { CLONE_STOPPED_MESSAGE } from '../../../src/shared/world/repoAccess'
import { linkCls, whereOf, UI_FAILED } from '../../../src/renderer/src/components/World/worldTargets'
import { DesignStart } from '../../../src/renderer/src/components/World/DesignStart'
import { BuildItDialog } from '../../../src/renderer/src/components/World/BuildItDialog'
import { WorldSwitcher } from '../../../src/renderer/src/components/World/WorldSwitcher'

type Res<T> = { success: true; data: T } | { success: false; error: string }
const ok = <T,>(data: T): Res<T> => ({ success: true, data })
const fail = (error: string): Res<never> => ({ success: false, error })

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const NOW = 1_800_000_000_000
const entries = (): WorldEntry[] => [
  { key: 'k-proj', source: { kind: 'project', root: 'C:/repo' }, title: 'repo', lastOpened: NOW - 30_000 },
  { key: 'k-dir', source: { kind: 'folder', root: 'C:/notes' }, title: 'notes', lastOpened: NOW - 5 * 60_000 },
  { key: 'k-git', source: { kind: 'git', url: 'https://x.dev/a.git', root: 'C:/data/a' }, title: 'a', lastOpened: NOW - 3 * 3_600_000 },
  { key: 'design:shop', source: { kind: 'design', id: 'shop', title: 'Shop' }, title: 'Shop', lastOpened: NOW - 2 * 86_400_000 },
  { key: 'k-gone', source: { kind: 'folder', root: 'C:/gone' }, title: 'gone', lastOpened: NOW - 40 * 86_400_000, missing: true },
]

function bridge(over: Record<string, unknown> = {}) {
  const api = {
    gitFindRoot: vi.fn(async (cwd: string) => ok<string | null>(`${cwd}-root`)),
    worldMapProject: vi.fn(async (root: string) => ok<WorldEntry>({ key: 'k-new', source: { kind: 'project', root }, title: 'x', lastOpened: NOW })),
    worldOpenFolder: vi.fn(async () => ok<WorldEntry | null>({ key: 'k-f', source: { kind: 'folder', root: 'C:/picked' }, title: 'picked', lastOpened: NOW })),
    worldRemoveSource: vi.fn(async () => ok(true)),
    worldClone: vi.fn(async (url: string) => ok<WorldEntry>({ key: 'k-c', source: { kind: 'git', url, root: 'C:/data/clone' }, title: 'clone', lastOpened: NOW })),
    worldCloneCancel: vi.fn(async () => ok(true)),
    worldDesignDraft: vi.fn(async () => ok({ key: 'design:new', doc: {}, text: 'Drafted.' })),
    worldDesignCancel: vi.fn(async () => ok(true)),
    worldPickFolder: vi.fn(async (): Promise<Res<WorldFolderPick | null>> => ok({ root: 'C:/build', empty: true })),
    worldBuildIt: vi.fn(async (req: { key: string; root: string }): Promise<Res<BuildItResult>> =>
      ok({ root: req.root, key: req.key, title: 'Shop', prompt: 'Build the app.' })),
    ...over,
  }
  ;(window as any).termpolis = api
  return api
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  vm.status = 'idle'
  vm.errorMsg = null
  vm.notice = null
  vm.toggle = vi.fn()
  vm.sink = null
})
afterEach(() => {
  cleanup()
  delete (navigator as any).mediaDevices
})

function home(over: Partial<Parameters<typeof WorldHome>[0]> = {}) {
  const props = { entries: entries(), projectCwd: 'C:/repo/src', onOpen: vi.fn(), onChanged: vi.fn(), now: NOW, ...over }
  render(<WorldHome {...props} />)
  return props
}

describe('WorldHome', () => {
  it('home lists four actions and recents', () => {
    bridge()
    home()
    expect(screen.getByRole('heading', { name: 'Lumopolis' })).toBeInTheDocument()
    expect(screen.getByText('Where AI Worlds Become Human Understanding.')).toBeInTheDocument()
    for (const name of ['Map this project', 'Open a folder…', 'Open a git repository…', 'Design something new']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${name}`) })).toBeInTheDocument()
    }
    const list = screen.getByRole('list', { name: 'Recent worlds' })
    const items = list.querySelectorAll('li')
    expect(items).toHaveLength(5)
    expect(items[0]).toHaveTextContent('repo')
    expect(items[0]).toHaveTextContent('just now')
    expect(items[1]).toHaveTextContent('5 min ago')
    expect(items[2]).toHaveTextContent('3 h ago')
    expect(items[3]).toHaveTextContent('2 days ago')
    expect(items[0].querySelector('.fa-diagram-project')).not.toBeNull()
    expect(items[1].querySelector('.fa-folder')).not.toBeNull()
    expect(items[2].querySelector('.fa-code-branch')).not.toBeNull()
    expect(items[3].querySelector('.fa-pen-ruler')).not.toBeNull()
  })

  it('lays its choices out by the pane width, not the window: two columns where they fit, one in a narrow pane', () => {
    bridge()
    home()
    const grid = screen.getByRole('button', { name: /^Open a folder/ }).parentElement as HTMLElement
    expect(grid.className).not.toMatch(/(^|\s)(sm|md|lg):/)
    expect(grid.style.gridTemplateColumns).toBe('repeat(auto-fit, minmax(min(15rem, 100%), 1fr))')
    expect(screen.getByRole('heading', { name: 'Lumopolis' }).className).toContain('flex-wrap')
  })

  it('missing entry shows Remove', async () => {
    const api = bridge()
    const props = home()
    const gone = screen.getByTestId('world-recent-k-gone')
    expect(gone).toHaveTextContent('missing')
    // A missing world can only be removed, not opened.
    expect(screen.queryByRole('button', { name: 'Open gone' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove gone' }))
    await settle()
    expect(api.worldRemoveSource).toHaveBeenCalledWith('k-gone')
    expect(props.onChanged).toHaveBeenCalled()
    expect(props.onOpen).not.toHaveBeenCalled()
  })

  // WP4b F-R7: a world whose saved copy or folder is gone says what is gone, with a way out.
  it('a missing folder, project or design says what Lumopolis cannot find, with Remove only', () => {
    bridge()
    home({ entries: [
      { key: 'f', source: { kind: 'folder', root: 'C:/gone' }, title: 'gone', lastOpened: NOW, missing: true },
      { key: 'p', source: { kind: 'project', root: 'C:/old' }, title: 'old', lastOpened: NOW, missing: true },
      { key: 'design:d', source: { kind: 'design', id: 'd', title: 'Shop' }, title: 'Shop', lastOpened: NOW, missing: true },
    ] })
    for (const [key, note] of [
      ['f', "Lumopolis can't find this folder. It may have been moved or deleted."],
      ['p', "Lumopolis can't find this folder. It may have been moved or deleted."],
      ['design:d', "Lumopolis can't find this design's saved file."],
    ] as const) {
      const row = screen.getByTestId(`world-recent-${key}`)
      expect(within(row).getByTestId('world-missing-note')).toHaveTextContent(note)
      expect(within(row).getByRole('button', { name: /^Remove / })).toBeInTheDocument()
      expect(within(row).queryByRole('button', { name: /^Clone / })).toBeNull()
    }
  })

  it('a missing cloned repository offers Clone again, which opens the clone dialog filled in and clones it', async () => {
    const api = bridge()
    const props = home({ entries: [
      { key: 'g', source: { kind: 'git', url: 'https://x.dev/a.git', ref: 'dev', root: 'C:/data/a' }, title: 'a', lastOpened: NOW, missing: true },
      { key: 'h', source: { kind: 'git', url: 'https://x.dev/h.git', root: 'C:/data/h' }, title: 'h', lastOpened: NOW, missing: true },
    ] })
    const row = screen.getByTestId('world-recent-g')
    expect(within(row).getByTestId('world-missing-note')).toHaveTextContent("Lumopolis can't find its saved copy of this repository.")
    fireEvent.click(within(row).getByRole('button', { name: 'Clone a again' }))
    expect(screen.getByLabelText('Repository URL')).toHaveValue('https://x.dev/a.git')
    expect(screen.getByLabelText('Branch (optional)')).toHaveValue('dev')
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    await settle()
    expect(api.worldClone).toHaveBeenCalledWith('https://x.dev/a.git', 'dev')
    expect(props.onChanged).toHaveBeenCalled()
    expect(props.onOpen).toHaveBeenCalledTimes(1)
    // One with no branch fills in the address only; Cancel puts the focus back on Clone again.
    const again = within(screen.getByTestId('world-recent-h')).getByRole('button', { name: 'Clone h again' })
    again.focus()
    fireEvent.click(again)
    expect(screen.getByLabelText('Repository URL')).toHaveValue('https://x.dev/h.git')
    expect(screen.getByLabelText('Branch (optional)')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(again).toHaveFocus()
  })

  it('a failed Remove says so', async () => {
    bridge({ worldRemoveSource: vi.fn(async () => fail('Lumopolis couldn\'t update its list of worlds. Try again.')) })
    const props = home()
    fireEvent.click(screen.getByRole('button', { name: 'Remove gone' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("couldn't update its list")
    expect(props.onChanged).not.toHaveBeenCalled()
  })

  it('opens a recent world: a design by key, any other by its folder', () => {
    bridge()
    const props = home()
    fireEvent.click(screen.getByRole('button', { name: 'Open Shop' }))
    expect(props.onOpen).toHaveBeenLastCalledWith({ kind: 'design', key: 'design:shop' })
    fireEvent.click(screen.getByRole('button', { name: 'Open a' }))
    expect(props.onOpen).toHaveBeenLastCalledWith({ kind: 'root', root: 'C:/data/a', key: 'k-git' })
  })

  it('without a pinned clock it counts from now', () => {
    bridge()
    home({ now: undefined, entries: [{ key: 'k', source: { kind: 'folder', root: 'C:/x' }, title: 'x', lastOpened: Date.now() }] })
    expect(screen.getByTestId('world-recent-k')).toHaveTextContent('just now')
  })

  it('with no recent worlds it says so', () => {
    bridge()
    home({ entries: [] })
    expect(screen.queryByRole('list', { name: 'Recent worlds' })).toBeNull()
    expect(screen.getByText(/No worlds yet/)).toBeInTheDocument()
  })

  it('Map this project remembers the git root of the active folder and opens it, following the terminal', async () => {
    const api = bridge()
    const props = home()
    fireEvent.click(screen.getByRole('button', { name: /^Map this project/ }))
    await settle()
    expect(api.gitFindRoot).toHaveBeenCalledWith('C:/repo/src')
    expect(api.worldMapProject).toHaveBeenCalledWith('C:/repo/src-root')
    expect(props.onChanged).toHaveBeenCalled()
    expect(props.onOpen).toHaveBeenCalledWith({ kind: 'root', root: 'C:/repo/src-root', follow: true })
  })

  it('Map this project uses the folder itself outside a repository, and is off with no terminal', async () => {
    const api = bridge({ gitFindRoot: vi.fn(async () => ok(null)) })
    home()
    fireEvent.click(screen.getByRole('button', { name: /^Map this project/ }))
    await settle()
    expect(api.worldMapProject).toHaveBeenCalledWith('C:/repo/src')
    cleanup()
    home({ projectCwd: '' })
    expect(screen.getByRole('button', { name: /^Map this project/ })).toBeDisabled()
  })

  it('a failed Map this project shows the error; a thrown one a fixed message', async () => {
    bridge({ worldMapProject: vi.fn(async () => fail('root required')) })
    const props = home()
    fireEvent.click(screen.getByRole('button', { name: /^Map this project/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('root required')
    expect(props.onOpen).not.toHaveBeenCalled()
    cleanup()
    bridge({ gitFindRoot: vi.fn(async () => { throw new Error('bridge gone') }) })
    home()
    fireEvent.click(screen.getByRole('button', { name: /^Map this project/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Lumopolis couldn't do that. Try again.")
  })

  it('Open a folder opens the chosen folder; a cancelled dialog changes nothing', async () => {
    const api = bridge()
    const props = home()
    fireEvent.click(screen.getByRole('button', { name: /^Open a folder/ }))
    await settle()
    expect(api.worldOpenFolder).toHaveBeenCalled()
    expect(props.onOpen).toHaveBeenCalledWith({ kind: 'root', root: 'C:/picked', key: 'k-f' })
    expect(props.onChanged).toHaveBeenCalledTimes(1)
    api.worldOpenFolder.mockResolvedValueOnce(ok(null))
    fireEvent.click(screen.getByRole('button', { name: /^Open a folder/ }))
    await settle()
    expect(props.onOpen).toHaveBeenCalledTimes(1)
    expect(props.onChanged).toHaveBeenCalledTimes(1)
  })

  it('a failed Open a folder says why', async () => {
    bridge({ worldOpenFolder: vi.fn(async () => fail("Lumopolis couldn't open that folder.")) })
    home()
    fireEvent.click(screen.getByRole('button', { name: /^Open a folder/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent("couldn't open that folder")
  })

  it('Open a git repository opens the clone dialog; a clone opens its folder', async () => {
    const api = bridge()
    const props = home()
    fireEvent.click(screen.getByRole('button', { name: /^Open a git repository/ }))
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://x.dev/b.git' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    await settle()
    expect(api.worldClone).toHaveBeenCalledWith('https://x.dev/b.git', undefined)
    expect(props.onChanged).toHaveBeenCalled()
    expect(props.onOpen).toHaveBeenCalledWith({ kind: 'root', root: 'C:/data/clone', key: 'k-c' })
    expect(screen.queryByRole('dialog', { name: 'Open a git repository' })).toBeNull()
  })

  it('the clone dialog closes without cloning', () => {
    bridge()
    home()
    fireEvent.click(screen.getByRole('button', { name: /^Open a git repository/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Open a git repository' })).toBeNull()
  })

  it('Design something new opens design start; a draft opens the design', async () => {
    const api = bridge()
    const props = home()
    fireEvent.click(screen.getByRole('button', { name: /^Design something new/ }))
    fireEvent.change(screen.getByPlaceholderText('Describe the app you want…'), { target: { value: 'A shop' } })
    fireEvent.click(screen.getByRole('button', { name: 'Design it' }))
    await settle()
    expect(api.worldDesignDraft).toHaveBeenCalled()
    expect(props.onChanged).toHaveBeenCalled()
    expect(props.onOpen).toHaveBeenCalledWith({ kind: 'design', key: 'design:new' })
    // Closing design start without drafting.
    fireEvent.click(screen.getByRole('button', { name: /^Design something new/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Design something new' })).toBeNull()
  })

  it('an open dialog dims the home behind it, held at its top; closed, the home scrolls again', () => {
    bridge()
    home()
    const page = screen.getByTestId('world-home')
    expect(page).toHaveClass('overflow-auto')
    expect(screen.queryByTestId('world-home-scrim')).toBeNull()
    page.scrollTop = 300
    fireEvent.click(screen.getByRole('button', { name: /^Design something new/ }))
    expect(page.scrollTop).toBe(0)
    expect(page).toHaveClass('overflow-hidden')
    const scrim = screen.getByTestId('world-home-scrim')
    expect(scrim).toHaveAttribute('aria-hidden', 'true')
    expect(scrim.nextElementSibling).toBe(screen.getByRole('dialog', { name: 'Design something new' })) // drawn over it
    // Its buttons keep their labels on one line; the row wraps whole buttons.
    const go = screen.getByRole('button', { name: 'Design it' })
    expect(go).toHaveClass('whitespace-nowrap')
    expect(go.parentElement).toHaveClass('flex-wrap')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('world-home-scrim')).toBeNull()
    expect(page).toHaveClass('overflow-auto')
  })
})

describe('agoText and targetOf', () => {
  it('counts back from now, never into the future', () => {
    expect(agoText(NOW + 5000, NOW)).toBe('just now')
    expect(agoText(NOW - 60_000, NOW)).toBe('1 min ago')
    expect(agoText(NOW - 3_600_000, NOW)).toBe('1 h ago')
    expect(agoText(NOW - 86_400_000, NOW)).toBe('1 day ago')
  })

  it('a design entry opens by key; a root entry by folder', () => {
    expect(targetOf(entries()[3])).toEqual({ kind: 'design', key: 'design:shop' })
    expect(targetOf(entries()[1])).toEqual({ kind: 'root', root: 'C:/notes', key: 'k-dir' })
  })
})

describe('CloneDialog', () => {
  const mount = () => {
    const props = { onCloned: vi.fn(), onClose: vi.fn(), onKept: vi.fn() }
    const view = render(<CloneDialog {...props} />)
    return { ...props, view }
  }
  const url = () => screen.getByLabelText('Repository URL')
  const branch = () => screen.getByLabelText('Branch (optional)')
  const cloneBtn = () => screen.getByRole('button', { name: 'Clone' })

  it('clone dialog disables Clone for invalid URL with reason text', () => {
    bridge()
    mount()
    expect(cloneBtn()).toBeDisabled()
    expect(screen.queryByTestId('world-clone-reason')).toBeNull()
    fireEvent.change(url(), { target: { value: 'ftp://nope' } })
    expect(cloneBtn()).toBeDisabled()
    expect(screen.getByTestId('world-clone-reason')).toHaveTextContent(BAD_URL_MESSAGE)
    fireEvent.change(url(), { target: { value: '--upload-pack=x' } })
    expect(cloneBtn()).toBeDisabled()
    fireEvent.change(url(), { target: { value: 'git@x.dev:a/b.git' } })
    expect(cloneBtn()).toBeEnabled()
    expect(screen.queryByTestId('world-clone-reason')).toBeNull()
    fireEvent.change(branch(), { target: { value: '-bad' } })
    expect(cloneBtn()).toBeDisabled()
    expect(screen.getByTestId('world-clone-reason')).toHaveTextContent(BAD_REF_MESSAGE)
  })

  it('clones a branch, showing progress until it is done', async () => {
    const d = deferred<Res<WorldEntry>>()
    const api = bridge({ worldClone: vi.fn(() => d.promise) })
    const props = mount()
    fireEvent.change(url(), { target: { value: 'https://x.dev/a.git' } })
    fireEvent.change(branch(), { target: { value: 'dev' } })
    fireEvent.keyDown(url(), { key: 'Enter' })
    expect(api.worldClone).toHaveBeenCalledWith('https://x.dev/a.git', 'dev')
    expect(screen.getByRole('progressbar', { name: 'Cloning' })).toBeInTheDocument()
    expect((screen.getByRole('progressbar', { name: 'Cloning' }).firstElementChild as Element).className.split(' ')).toContain('motion-safe:animate-pulse') // still under reduced motion
    expect(url()).toBeDisabled()
    // Enter again while cloning starts nothing new.
    fireEvent.keyDown(url(), { key: 'Enter' })
    fireEvent.keyDown(url(), { key: 'a' })
    expect(api.worldClone).toHaveBeenCalledTimes(1)
    const entry: WorldEntry = { key: 'k', source: { kind: 'git', url: 'https://x.dev/a.git', root: 'C:/d' }, title: 'a', lastOpened: 1 }
    d.resolve(ok(entry))
    await settle()
    expect(props.onCloned).toHaveBeenCalledWith(entry)
  })

  it('Cancel during a clone stops it, says it is stopping until main answers, then says it stopped (WP4b F-R5)', async () => {
    const d = deferred<Res<WorldEntry>>()
    const api = bridge({ worldClone: vi.fn(() => d.promise) })
    const props = mount()
    fireEvent.change(url(), { target: { value: 'https://x.dev/a.git' } })
    fireEvent.click(cloneBtn())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.worldCloneCancel).toHaveBeenCalledWith('https://x.dev/a.git', undefined)
    // Until the stopped clone answers, nothing can start another (it would join the run being stopped).
    expect(screen.getByRole('status')).toHaveTextContent(STOPPING_MESSAGE)
    expect(url()).toBeDisabled()
    expect(cloneBtn()).toBeDisabled()
    fireEvent.keyDown(url(), { key: 'Enter' })
    expect(api.worldClone).toHaveBeenCalledTimes(1)
    await act(async () => { d.resolve(fail(CLONE_STOPPED_MESSAGE)) })
    expect(screen.getByRole('alert')).toHaveTextContent(CLONE_STOPPED_MESSAGE)
    expect(screen.queryByRole('status')).toBeNull()
    expect(props.onCloned).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(url()).toBeEnabled()
    // Not cloning: Cancel closes.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onClose).toHaveBeenCalled()
  })

  it('a stopped clone says it stopped whatever main answered, even an unreachable main; a new clone clears it', async () => {
    const d = deferred<Res<WorldEntry>>()
    const api = bridge({ worldClone: vi.fn(() => d.promise) })
    mount()
    fireEvent.change(url(), { target: { value: 'https://x.dev/a.git' } })
    fireEvent.click(cloneBtn())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => { d.reject(new Error('host gone')) })
    expect(screen.getByRole('alert')).toHaveTextContent(CLONE_STOPPED_MESSAGE)
    api.worldClone.mockResolvedValueOnce(fail(UI_FAILED))
    fireEvent.click(cloneBtn())
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(UI_FAILED))
  })

  it('a second Cancel while the clone is stopping closes the dialog, and asks main to stop only once', async () => {
    const d = deferred<Res<WorldEntry>>()
    const api = bridge({ worldClone: vi.fn(() => d.promise) })
    const props = mount()
    fireEvent.change(url(), { target: { value: 'https://x.dev/a.git' } })
    fireEvent.click(cloneBtn())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    props.view.unmount()
    expect(api.worldCloneCancel).toHaveBeenCalledTimes(1)
  })

  it('a cancel that cannot reach main is quiet; a clone that finished before the stop is kept and said so, never opened', async () => {
    const d = deferred<Res<WorldEntry>>()
    bridge({ worldClone: vi.fn(() => d.promise), worldCloneCancel: vi.fn(async () => { throw new Error('x') }) })
    const props = mount()
    fireEvent.change(url(), { target: { value: 'https://x.dev/a.git' } })
    fireEvent.change(branch(), { target: { value: 'main' } })
    fireEvent.click(cloneBtn())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await settle()
    const entry: WorldEntry = { key: 'k', source: { kind: 'git', url: 'u', root: 'r' }, title: 't', lastOpened: 1 }
    await act(async () => { d.resolve(ok(entry)) })
    expect(props.onCloned).not.toHaveBeenCalled()
    expect(props.onKept).toHaveBeenCalledWith(entry)
    expect(screen.getByRole('status')).toHaveTextContent(CLONE_KEPT_MESSAGE)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('closing the dialog while a clone runs stops that clone (WP4b F-R5); one closed after it ended asks nothing', async () => {
    const d = deferred<Res<WorldEntry>>()
    // A stop that cannot reach main is quiet here too.
    const api = bridge({ worldClone: vi.fn(() => d.promise), worldCloneCancel: vi.fn(async () => { throw new Error('x') }) })
    const first = mount()
    fireEvent.change(url(), { target: { value: 'https://x.dev/a.git' } })
    fireEvent.change(branch(), { target: { value: 'dev' } })
    fireEvent.click(cloneBtn())
    first.view.unmount()
    expect(api.worldCloneCancel).toHaveBeenCalledWith('https://x.dev/a.git', 'dev')
    api.worldClone.mockResolvedValueOnce(fail(UI_FAILED))
    const second = mount()
    fireEvent.change(url(), { target: { value: 'https://x.dev/a.git' } })
    fireEvent.click(cloneBtn())
    await screen.findByRole('alert')
    second.view.unmount()
    expect(api.worldCloneCancel).toHaveBeenCalledTimes(1)
  })

  it('a failed clone shows main\'s reason; a thrown one a fixed message', async () => {
    const api = bridge({ worldClone: vi.fn(async () => fail('That repository needs a sign-in.')) })
    mount()
    fireEvent.change(url(), { target: { value: 'https://x.dev/a.git' } })
    fireEvent.click(cloneBtn())
    expect(await screen.findByRole('alert')).toHaveTextContent('needs a sign-in')
    api.worldClone.mockRejectedValueOnce(new Error('gone'))
    fireEvent.click(cloneBtn())
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Lumopolis couldn't clone that repository. Try again."))
  })

  it('a clone that needs a sign-in shows its message and opens nothing', async () => {
    bridge({ worldClone: vi.fn(async () => ok({ needsLogin: { host: 'x.dev', helper: false, message: 'That repository needs you to sign in.' } })) })
    const props = mount()
    fireEvent.change(url(), { target: { value: 'https://x.dev/a.git' } })
    fireEvent.click(cloneBtn())
    expect(await screen.findByRole('alert')).toHaveTextContent('That repository needs you to sign in.')
    expect(props.onCloned).not.toHaveBeenCalled()
  })
})

describe('CloneDialog sign-in choices', () => {
  const NEEDS = (helper: boolean, host = 'github.com') => ok({ needsLogin: { host, helper, message: 'That repository needs you to sign in.' } })
  const GOT: WorldEntry = { key: 'k-c', source: { kind: 'git', url: 'https://github.com/o/r.git', root: 'C:/data/r', login: 'machine' }, title: 'r', lastOpened: NOW }
  const mount = () => {
    const props = { onCloned: vi.fn(), onClose: vi.fn() }
    render(<CloneDialog {...props} />)
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://github.com/o/r.git' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    return props
  }

  it('offers Sign in to GitHub and Use a token when a helper is set up', async () => {
    bridge({ worldClone: vi.fn(async () => NEEDS(true)) })
    mount()
    expect(await screen.findByTestId('world-clone-sign-in')).toHaveTextContent('Sign in to GitHub')
    expect(screen.getByTestId('world-clone-use-token')).toHaveTextContent('Use a token')
  })

  it('offers only Use a token when no helper is set up', async () => {
    bridge({ worldClone: vi.fn(async () => NEEDS(false, 'gitlab.example.com')) })
    mount()
    expect(await screen.findByTestId('world-clone-use-token')).toBeInTheDocument()
    expect(screen.queryByTestId('world-clone-sign-in')).toBeNull()
  })

  it('Sign in retries in machine mode, with its busy text, and opens the repository', async () => {
    const d = deferred<Res<unknown>>()
    const api = bridge({ worldClone: vi.fn().mockResolvedValueOnce(NEEDS(true)).mockImplementationOnce(() => d.promise) })
    const props = mount()
    fireEvent.click(await screen.findByTestId('world-clone-sign-in'))
    expect(api.worldClone).toHaveBeenLastCalledWith('https://github.com/o/r.git', undefined, { mode: 'machine' })
    expect(screen.getByText(SIGNING_IN_MESSAGE)).toBeInTheDocument()
    expect(screen.getByTestId('world-clone-sign-in')).toBeDisabled()
    expect(screen.getByTestId('world-clone-use-token')).toBeDisabled()
    d.resolve(ok(GOT))
    await settle()
    expect(props.onCloned).toHaveBeenCalledWith(GOT)
  })

  it('a second needsLogin after Sign in shows the actions again and does not retry on its own', async () => {
    const api = bridge({ worldClone: vi.fn(async () => NEEDS(true)) })
    mount()
    fireEvent.click(await screen.findByTestId('world-clone-sign-in'))
    await settle()
    expect(screen.getByTestId('world-clone-sign-in')).toBeEnabled()
    expect(screen.queryByText(SIGNING_IN_MESSAGE)).toBeNull()
    expect(api.worldClone).toHaveBeenCalledTimes(2)
  })

  it('Use a token opens the dialog, and a submitted token retries with it', async () => {
    const api = bridge({ worldClone: vi.fn().mockResolvedValueOnce(NEEDS(true)).mockResolvedValueOnce(ok({ ...GOT, source: { ...GOT.source, login: 'token' } })) })
    const props = mount()
    fireEvent.click(await screen.findByTestId('world-clone-use-token'))
    fireEvent.change(screen.getByTestId('world-repo-access-input'), { target: { value: ' ghp_x ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use this token' }))
    await settle()
    expect(api.worldClone).toHaveBeenLastCalledWith('https://github.com/o/r.git', undefined, { mode: 'token', value: 'ghp_x' })
    expect(props.onCloned).toHaveBeenCalled()
  })

  it('a refused token shows main\'s words in the token dialog, which stays open', async () => {
    bridge({ worldClone: vi.fn().mockResolvedValueOnce(NEEDS(true)).mockResolvedValueOnce(fail('That token did not open it.')).mockResolvedValueOnce(NEEDS(true)).mockRejectedValueOnce(new Error('gone')) })
    mount()
    fireEvent.click(await screen.findByTestId('world-clone-use-token'))
    const send = async () => {
      fireEvent.change(screen.getByTestId('world-repo-access-input'), { target: { value: 'ghp_x' } })
      fireEvent.click(screen.getByRole('button', { name: 'Use this token' }))
      await settle()
    }
    await send()
    expect(within(screen.getByTestId('world-repo-access')).getByRole('alert')).toHaveTextContent('That token did not open it.')
    await send()
    expect(within(screen.getByTestId('world-repo-access')).getByRole('alert')).toHaveTextContent('That repository needs you to sign in.')
    await send()
    expect(within(screen.getByTestId('world-repo-access')).getByRole('alert')).toHaveTextContent("Lumopolis couldn't clone that repository. Try again.")
  })

  it('cancelling the token dialog goes back to the choices', async () => {
    bridge({ worldClone: vi.fn(async () => NEEDS(true)) })
    mount()
    fireEvent.click(await screen.findByTestId('world-clone-use-token'))
    fireEvent.click(within(screen.getByTestId('world-repo-access')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('world-repo-access')).toBeNull()
    expect(screen.getByTestId('world-clone-use-token')).toBeInTheDocument()
  })

  it('changing the address or branch takes the sign-in choices away', async () => {
    bridge({ worldClone: vi.fn(async () => NEEDS(true)) })
    mount()
    await screen.findByTestId('world-clone-sign-in')
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://github.com/o/s.git' } })
    expect(screen.queryByTestId('world-clone-sign-in')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    await screen.findByTestId('world-clone-sign-in')
    fireEvent.change(screen.getByLabelText('Branch (optional)'), { target: { value: 'dev' } })
    expect(screen.queryByTestId('world-clone-use-token')).toBeNull()
  })

  it('a failed Sign in shows its error in the alert', async () => {
    bridge({ worldClone: vi.fn().mockResolvedValueOnce(NEEDS(true)).mockResolvedValueOnce(fail('Sign in was closed.')) })
    mount()
    fireEvent.click(await screen.findByTestId('world-clone-sign-in'))
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in was closed.')
  })

  it('F-R11: the machine sign-in words do not claim a window opened', () => {
    expect(SIGNING_IN_MESSAGE).toBe("Signing in with this computer's login… If a sign-in window opens, finish there.")
  })

  it('F-R8: a repository the host could not find shows the address hint first, with the sign-in choices as secondary links', async () => {
    const NOT_FOUND = "Lumopolis couldn't find that repository. Check the address, or sign in if it's private."
    bridge({ worldClone: vi.fn(async () => ok({ needsLogin: { host: 'gitlab.example.com', helper: true, notFound: true, message: NOT_FOUND } })) })
    mount()
    expect(await screen.findByRole('alert')).toHaveTextContent(NOT_FOUND)
    expect(screen.getByTestId('world-clone-sign-in')).toHaveClass(...linkCls.split(' '))
    expect(screen.getByTestId('world-clone-use-token')).toHaveClass(...linkCls.split(' '))
    // A sign-in that is needed (not a maybe) keeps the ordinary buttons.
    cleanup()
    bridge({ worldClone: vi.fn(async () => NEEDS(true)) })
    mount()
    expect(await screen.findByTestId('world-clone-sign-in')).not.toHaveClass('underline')
  })
})

describe('CloneDialog keyboard (F-R13)', () => {
  it('the address field has the focus when the dialog opens', () => {
    bridge()
    render(<CloneDialog onCloned={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByLabelText('Repository URL')).toHaveFocus()
  })

  it('Enter in the branch field clones, as it does in the address field; other keys do not', async () => {
    const api = bridge()
    const onCloned = vi.fn()
    render(<CloneDialog onCloned={onCloned} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://x.dev/a.git' } })
    fireEvent.change(screen.getByLabelText('Branch (optional)'), { target: { value: 'dev' } })
    fireEvent.keyDown(screen.getByLabelText('Branch (optional)'), { key: 'a' })
    expect(api.worldClone).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByLabelText('Branch (optional)'), { key: 'Enter' })
    expect(api.worldClone).toHaveBeenCalledWith('https://x.dev/a.git', 'dev')
    await settle()
    expect(onCloned).toHaveBeenCalled()
  })
})

describe('DesignStart', () => {
  const mount = () => {
    const props = { onDrafted: vi.fn(), onClose: vi.fn() }
    render(<DesignStart {...props} />)
    return props
  }
  const box = () => screen.getByPlaceholderText('Describe the app you want…')

  it('design start submits description', async () => {
    const api = bridge()
    const props = mount()
    expect(screen.getByRole('button', { name: 'Design it' })).toBeDisabled()
    fireEvent.change(box(), { target: { value: '  A small shop with a cart  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Design it' }))
    await settle()
    expect(api.worldDesignDraft).toHaveBeenCalledWith('A small shop with a cart', expect.stringMatching(/^draft:[A-Za-z0-9][A-Za-z0-9-]*$/), undefined)
    expect(props.onDrafted).toHaveBeenCalledWith('design:new')
  })

  it('Ctrl+Enter submits; a spoken description is added to the text', async () => {
    const api = bridge()
    ;(navigator as any).mediaDevices = { getUserMedia: vi.fn() }
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Describe by voice' }))
    expect(vm.toggle).toHaveBeenCalled()
    act(() => vm.sink?.('A shop'))
    expect(box()).toHaveValue('A shop')
    act(() => vm.sink?.('with a cart'))
    expect(box()).toHaveValue('A shop with a cart')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(api.worldDesignDraft).not.toHaveBeenCalled()
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    await settle()
    expect(api.worldDesignDraft).toHaveBeenCalledWith('A shop with a cart', expect.any(String), undefined)
  })

  it('shows the mic listening, transcribing and its error', () => {
    bridge()
    ;(navigator as any).mediaDevices = { getUserMedia: vi.fn() }
    vm.status = 'listening'
    vm.errorMsg = 'No microphone found.'
    mount()
    expect(screen.getByRole('button', { name: 'Stop listening' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('No microphone found.')
    cleanup()
    vm.status = 'transcribing'
    vm.errorMsg = null
    mount()
    expect(screen.getByRole('button', { name: 'Describe by voice' }).className.split(' ')).toContain('motion-safe:animate-pulse') // still under reduced motion
  })

  it('shows the 5-minute cap note quietly, as a status and not an alert, and drops it once the hook clears it', () => {
    bridge()
    ;(navigator as any).mediaDevices = { getUserMedia: vi.fn() }
    vm.notice = 'Recording stopped after 5 minutes. Ask a shorter question, or type it.'
    mount()
    expect(screen.getByRole('status')).toHaveTextContent('Recording stopped after 5 minutes.')
    expect(screen.getByRole('status').className).not.toContain('f14c4c')
    expect(screen.queryByRole('alert')).toBeNull()
    cleanup()
    vm.notice = null // the next start() clears it
    mount()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('Cancel while drafting stops the draft by its key and drops the late result', async () => {
    const d = deferred<Res<{ key: string; doc: unknown; text: string }>>()
    const api = bridge({ worldDesignDraft: vi.fn(() => d.promise) })
    const props = mount()
    fireEvent.change(box(), { target: { value: 'A shop' } })
    fireEvent.click(screen.getByRole('button', { name: 'Design it' }))
    expect(screen.getByRole('status')).toHaveTextContent('Drafting your design…')
    expect(screen.getByRole('status').className.split(' ')).toContain('motion-safe:animate-pulse') // still under reduced motion
    await settle()
    // Ctrl+Enter while drafting starts nothing new.
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    expect(api.worldDesignDraft).toHaveBeenCalledTimes(1)
    const cancelKey = api.worldDesignDraft.mock.calls[0][1]
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.worldDesignCancel).toHaveBeenCalledWith(cancelKey)
    d.resolve(ok({ key: 'design:late', doc: {}, text: '' }))
    await settle()
    expect(props.onDrafted).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onClose).toHaveBeenCalled()
  })

  it('a failed draft shows the reason; a thrown one a fixed message; a cancel that throws is quiet', async () => {
    const api = bridge({ worldDesignDraft: vi.fn(async () => fail('The agent did not answer.')), worldDesignCancel: vi.fn(async () => { throw new Error('x') }) })
    mount()
    fireEvent.change(box(), { target: { value: 'A shop' } })
    fireEvent.click(screen.getByRole('button', { name: 'Design it' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The agent did not answer.')
    api.worldDesignDraft.mockRejectedValueOnce(new Error('gone'))
    fireEvent.click(screen.getByRole('button', { name: 'Design it' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Lumopolis couldn't draft that design. Try again."))
    const d = deferred<Res<never>>()
    api.worldDesignDraft.mockReturnValueOnce(d.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Design it' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await settle()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('BuildItDialog', () => {
  const agents = [{ id: 'claude', name: 'Claude Code' }, { id: 'opus-claude', name: 'Claude (Opus)' }]
  const mount = (over: Record<string, unknown> = {}) => {
    const props = { designKey: 'design:shop', title: 'Shop', agents, defaultAgent: 'claude', onBuilt: vi.fn(), onClose: vi.fn(), ...over }
    render(<BuildItDialog {...props} />)
    return props
  }
  const buildBtn = () => screen.getByRole('button', { name: 'Build it' })

  it('Build it refuses empty folder selection; warns on non-empty; confirm calls world:build-it with key, root, agent', async () => {
    const api = bridge()
    const props = mount()
    expect(screen.getByLabelText('Agent')).toHaveValue('claude')
    // The 2.0 ruling: Build it starts Claude Code, and the dialog says so.
    expect(screen.getByTestId('world-build-claude-only')).toHaveTextContent('Build it starts Claude Code')
    expect(buildBtn()).toBeDisabled()
    // A cancelled folder dialog leaves nothing chosen.
    api.worldPickFolder.mockResolvedValueOnce(ok(null))
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await settle()
    expect(buildBtn()).toBeDisabled()
    expect(screen.queryByTestId('world-build-folder')).toBeNull()
    // A non-empty folder warns, and Build it waits for the user to agree.
    api.worldPickFolder.mockResolvedValueOnce(ok({ root: 'C:/work/app', empty: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await settle()
    expect(screen.getByTestId('world-build-folder')).toHaveTextContent('C:/work/app')
    expect(screen.getByRole('alert')).toHaveTextContent("This folder isn't empty")
    expect(buildBtn()).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Build here anyway'))
    expect(buildBtn()).toBeEnabled()
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'opus-claude' } })
    fireEvent.click(buildBtn())
    await settle()
    expect(api.worldBuildIt).toHaveBeenCalledWith({ key: 'design:shop', root: 'C:/work/app', agent: 'opus-claude', confirmNonEmpty: true })
    expect(props.onBuilt).toHaveBeenCalledWith({ root: 'C:/work/app', key: 'design:shop', title: 'Shop', prompt: 'Build the app.' }, 'opus-claude')
  })

  it('an empty folder builds without asking; with no default the first agent is chosen', async () => {
    const api = bridge()
    mount({ defaultAgent: undefined })
    expect(screen.getByLabelText('Agent')).toHaveValue('claude')
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Choose another folder…' })).toBeInTheDocument()
    fireEvent.click(buildBtn())
    await settle()
    expect(api.worldBuildIt).toHaveBeenCalledWith({ key: 'design:shop', root: 'C:/build', agent: 'claude' })
  })

  it('a default that is not offered falls back to the first agent; with no agent Build it is off', async () => {
    bridge()
    mount({ defaultAgent: 'codex' })
    expect(screen.getByLabelText('Agent')).toHaveValue('claude')
    cleanup()
    mount({ agents: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await settle()
    expect(buildBtn()).toBeDisabled()
    expect(screen.getByText(/Build it needs Claude Code/)).toBeInTheDocument()
  })

  it('failures: the folder dialog, the build, and a bridge that throws', async () => {
    const api = bridge({ worldPickFolder: vi.fn(async () => fail("Lumopolis couldn't open that folder.")) })
    const props = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("couldn't open that folder")
    api.worldPickFolder.mockRejectedValueOnce(new Error('x'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Lumopolis couldn't do that. Try again."))
    api.worldPickFolder.mockResolvedValueOnce(ok({ root: 'C:/b', empty: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await settle()
    api.worldBuildIt.mockResolvedValueOnce(fail("That folder isn't empty."))
    fireEvent.click(buildBtn())
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("That folder isn't empty."))
    api.worldBuildIt.mockRejectedValueOnce(new Error('x'))
    fireEvent.click(buildBtn())
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Lumopolis couldn't do that. Try again."))
    expect(props.onBuilt).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onClose).toHaveBeenCalled()
  })

  it('while building, Build it is off', async () => {
    const d = deferred<Res<BuildItResult>>()
    const api = bridge({ worldBuildIt: vi.fn(() => d.promise) })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await settle()
    fireEvent.click(buildBtn())
    expect(screen.getByRole('button', { name: 'Building…' })).toBeDisabled()
    d.resolve(fail('x'))
    await settle()
    expect(api.worldBuildIt).toHaveBeenCalledTimes(1)
  })
})

describe('WorldSwitcher', () => {
  it('switcher opens chosen world', () => {
    const onOpen = vi.fn()
    const onHome = vi.fn()
    render(<WorldSwitcher entries={entries()} onOpen={onOpen} onHome={onHome} />)
    const sel = screen.getByLabelText('Worlds')
    // Missing worlds are not offered.
    expect(sel.querySelectorAll('option')).toHaveLength(6)
    fireEvent.change(sel, { target: { value: 'k-dir' } })
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'root', root: 'C:/notes', key: 'k-dir' })
    fireEvent.change(sel, { target: { value: 'design:shop' } })
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'design', key: 'design:shop' })
    fireEvent.change(sel, { target: { value: '__home' } })
    expect(onHome).toHaveBeenCalled()
    fireEvent.change(sel, { target: { value: '' } })
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(onHome).toHaveBeenCalledTimes(1)
  })
})

describe('WorldSwitcher where (F-R12)', () => {
  it('each world names where it is in its option title, so two of one name can be told apart', () => {
    render(<WorldSwitcher entries={entries()} onOpen={vi.fn()} onHome={vi.fn()} />)
    const sel = screen.getByLabelText('Worlds')
    expect(sel.querySelector('option[value="k-dir"]')).toHaveAttribute('title', 'C:/')
    expect(sel.querySelector('option[value="k-git"]')).toHaveAttribute('title', 'https://x.dev/a.git')
    expect(sel.querySelector('option[value="design:shop"]')).not.toHaveAttribute('title')
    // A name no other world has is shown alone.
    expect(sel.querySelector('option[value="k-dir"]')).toHaveTextContent(/^notes$/)
  })

  // M10: a macOS select shows no option titles, so two worlds of one name carry where they are in their text.
  it('two open worlds of one name say where each is in the option itself; a missing one, a design and a lone name do not', () => {
    const list: WorldEntry[] = [
      { key: 'a1', source: { kind: 'folder', root: 'C:/work/api' }, title: 'api', lastOpened: NOW },
      { key: 'a2', source: { kind: 'git', url: 'https://x.dev/api.git', ref: 'dev', root: 'C:/data/b' }, title: 'api', lastOpened: NOW - 1 },
      { key: 'a3', source: { kind: 'folder', root: 'api' }, title: 'api', lastOpened: NOW - 2 },
      { key: 'g1', source: { kind: 'folder', root: 'C:/gone/web' }, title: 'web', lastOpened: NOW - 3, missing: true },
      { key: 'w1', source: { kind: 'folder', root: 'C:/work/web' }, title: 'web', lastOpened: NOW - 4 },
      { key: 'design:x', source: { kind: 'design', id: 'x', title: 'api' }, title: 'api', lastOpened: NOW - 5 },
    ]
    render(<WorldSwitcher entries={list} onOpen={vi.fn()} onHome={vi.fn()} />)
    const sel = screen.getByLabelText('Worlds')
    const text = (v: string) => sel.querySelector(`option[value="${v}"]`)?.textContent
    expect(text('a1')).toBe('api \u2014 C:/work')
    expect(text('a2')).toBe('api \u2014 https://x.dev/api.git \u00b7 dev')
    // No folder above it to name, and a design has no place: the name alone.
    expect(text('a3')).toBe('api')
    expect(text('design:x')).toBe('api')
    // The other "web" is missing, so not offered: this one's name is its own.
    expect(text('w1')).toBe('web')
  })
})

describe('whereOf (F-R12)', () => {
  const at = (source: WorldEntry['source']): WorldEntry => ({ key: 'k', source, title: 't', lastOpened: 1 })
  it('a folder or project shows its parent folder, a repository its address and branch, a design nothing', () => {
    expect(whereOf(at({ kind: 'folder', root: 'C:/work/api' }))).toBe('C:/work')
    expect(whereOf(at({ kind: 'project', root: 'D:\\old\\api\\' }))).toBe('D:\\old')
    expect(whereOf(at({ kind: 'folder', root: 'C:/api' }))).toBe('C:/')
    expect(whereOf(at({ kind: 'folder', root: 'C:\\api' }))).toBe('C:\\')
    expect(whereOf(at({ kind: 'folder', root: '/home/u/api' }))).toBe('/home/u')
    expect(whereOf(at({ kind: 'folder', root: '/api' }))).toBe('/')
    expect(whereOf(at({ kind: 'folder', root: 'api' }))).toBe('')
    expect(whereOf(at({ kind: 'git', url: 'https://x.dev/a.git', root: 'C:/data/a' }))).toBe('https://x.dev/a.git')
    expect(whereOf(at({ kind: 'git', url: 'https://x.dev/a.git', ref: 'dev', root: 'C:/data/a' }))).toBe('https://x.dev/a.git · dev')
    expect(whereOf(at({ kind: 'design', id: 'shop', title: 'Shop' }))).toBe('')
  })
})

describe('WorldHome recent worlds (F-R12)', () => {
  it('each world shows where it is on a second line', () => {
    bridge()
    home({ entries: [
      { key: 'a1', source: { kind: 'folder', root: 'C:/work/api' }, title: 'api', lastOpened: NOW },
      { key: 'a2', source: { kind: 'folder', root: 'C:/old/api' }, title: 'api', lastOpened: NOW },
      { key: 'g', source: { kind: 'git', url: 'https://x.dev/a.git', ref: 'dev', root: 'C:/data/a' }, title: 'a', lastOpened: NOW, missing: true },
      { key: 'd', source: { kind: 'design', id: 'shop', title: 'Shop' }, title: 'Shop', lastOpened: NOW },
    ] })
    expect(screen.getByTestId('world-recent-a1')).toHaveTextContent('C:/work')
    expect(screen.getByTestId('world-recent-a2')).toHaveTextContent('C:/old')
    expect(screen.getByTestId('world-recent-g')).toHaveTextContent('https://x.dev/a.git · dev')
    expect(screen.getByTestId('world-recent-d').querySelector('[data-testid="world-where"]')).toBeNull()
  })

  it('a list main could not read says so, with Try again, instead of "No worlds yet"', () => {
    bridge()
    const props = home({ entries: [], listError: true })
    expect(screen.queryByText(/No worlds yet/)).toBeNull()
    expect(screen.getByTestId('world-list-error')).toHaveTextContent("Lumopolis couldn't load your recent worlds.")
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(props.onChanged).toHaveBeenCalledTimes(1)
  })

  it('a list that could not be read again keeps the worlds already shown under the message', () => {
    bridge()
    home({ listError: true })
    expect(screen.getByTestId('world-list-error')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Recent worlds' }).querySelectorAll('li')).toHaveLength(5)
  })
})

describe('WorldHome stale opens (F-R4)', () => {
  const lapsing = () => {
    let live = true
    return { ticket: () => () => live, lapse: () => { live = false } }
  }

  it('Map this project that finishes after the pane moved on does not open it, but the list still reloads', async () => {
    const d = deferred<Res<WorldEntry>>()
    bridge({ worldMapProject: vi.fn(() => d.promise) })
    const t = lapsing()
    const props = home({ ticket: t.ticket })
    fireEvent.click(screen.getByRole('button', { name: /^Map this project/ }))
    await settle()
    t.lapse()
    d.resolve(ok({ key: 'k-new', source: { kind: 'project', root: 'C:/repo/src-root' }, title: 'x', lastOpened: NOW }))
    await settle()
    expect(props.onChanged).toHaveBeenCalled()
    expect(props.onOpen).not.toHaveBeenCalled()
  })

  // R3: the folder the person picks is their newest choice: it opens, whatever moved while the picker was up.
  it('a folder chosen opens even when the pane moved while the picker was up', async () => {
    const d = deferred<Res<WorldEntry | null>>()
    bridge({ worldOpenFolder: vi.fn(() => d.promise) })
    const t = lapsing()
    const props = home({ ticket: t.ticket })
    fireEvent.click(screen.getByRole('button', { name: /^Open a folder/ }))
    t.lapse()
    d.resolve(ok({ key: 'k-f', source: { kind: 'folder', root: 'C:/picked' }, title: 'picked', lastOpened: NOW }))
    await settle()
    expect(props.onChanged).toHaveBeenCalled()
    expect(props.onOpen).toHaveBeenCalledWith({ kind: 'root', root: 'C:/picked', key: 'k-f' })
  })

  it('a clone or a design that finishes after the pane moved on is listed but not opened', async () => {
    const c = deferred<Res<WorldEntry>>()
    bridge({ worldClone: vi.fn(() => c.promise) })
    const t = lapsing()
    const props = home({ ticket: t.ticket })
    fireEvent.click(screen.getByRole('button', { name: /^Open a git repository/ }))
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://x.dev/a.git' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    t.lapse()
    c.resolve(ok({ key: 'k-c', source: { kind: 'git', url: 'https://x.dev/a.git', root: 'C:/data/clone' }, title: 'clone', lastOpened: NOW }))
    await settle()
    expect(props.onChanged).toHaveBeenCalledTimes(1)
    expect(props.onOpen).not.toHaveBeenCalled()
    cleanup()
    const d = deferred<Res<unknown>>()
    bridge({ worldDesignDraft: vi.fn(() => d.promise) })
    const u = lapsing()
    const again = home({ ticket: u.ticket })
    fireEvent.click(screen.getByRole('button', { name: /^Design something new/ }))
    fireEvent.change(screen.getByPlaceholderText('Describe the app you want…'), { target: { value: 'A shop' } })
    fireEvent.click(screen.getByRole('button', { name: 'Design it' }))
    u.lapse()
    d.resolve(ok({ key: 'design:new', doc: {}, text: 'Drafted.' }))
    await settle()
    expect(again.onChanged).toHaveBeenCalledTimes(1)
    expect(again.onOpen).not.toHaveBeenCalled()
  })

  // R3: useOpenWorld's tickets (each one lapses every older one). Only a commit takes one: Clone or Design it pressed, a
  // folder chosen. Opening a dialog or the folder picker and then backing out leaves the earlier open current.
  const panes = () => {
    let moves = 0
    return (): (() => boolean) => {
      const at = ++moves
      return () => moves === at
    }
  }
  const slowMap = (over: Record<string, unknown> = {}) => {
    const d = deferred<Res<WorldEntry>>()
    bridge({ worldMapProject: vi.fn(() => d.promise), ...over })
    const props = home({ ticket: panes() })
    fireEvent.click(screen.getByRole('button', { name: /^Map this project/ }))
    const mapped = async () => {
      d.resolve(ok({ key: 'k-new', source: { kind: 'project', root: 'C:/repo/src-root' }, title: 'x', lastOpened: NOW }))
      await settle()
    }
    return { props, mapped }
  }
  const MAPPED = { kind: 'root', root: 'C:/repo/src-root', follow: true }

  it('a slow map, then Open a git repository and Design something new opened and cancelled: the map opens', async () => {
    const { props, mapped } = slowMap()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Open a git repository/ }))
    fireEvent.click(within(screen.getByTestId('world-clone')).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: /^Design something new/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await mapped()
    expect(props.onOpen).toHaveBeenCalledTimes(1)
    expect(props.onOpen).toHaveBeenCalledWith(MAPPED)
  })

  it('a slow map, then the folder picker cancelled: the map opens', async () => {
    const { props, mapped } = slowMap({ worldOpenFolder: vi.fn(async () => ok(null)) })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Open a folder/ }))
    await settle()
    await mapped()
    expect(props.onOpen).toHaveBeenCalledTimes(1)
    expect(props.onOpen).toHaveBeenCalledWith(MAPPED)
  })

  it('a slow map, then a folder chosen: the folder opens and the map does not', async () => {
    const pick = deferred<Res<WorldEntry | null>>()
    const { props, mapped } = slowMap({ worldOpenFolder: vi.fn(() => pick.promise) })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Open a folder/ }))
    await act(async () => { pick.resolve(ok({ key: 'k-f', source: { kind: 'folder', root: 'C:/picked' }, title: 'picked', lastOpened: NOW })) })
    await settle()
    await mapped()
    expect(props.onOpen).toHaveBeenCalledTimes(1)
    expect(props.onOpen).toHaveBeenCalledWith({ kind: 'root', root: 'C:/picked', key: 'k-f' })
  })

  it('a slow map, then Clone pressed: the clone opens and the map does not', async () => {
    const c = deferred<Res<WorldEntry>>()
    const { props, mapped } = slowMap({ worldClone: vi.fn(() => c.promise) })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Open a git repository/ }))
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://x.dev/a.git' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    await mapped()
    expect(props.onOpen).not.toHaveBeenCalled()
    await act(async () => { c.resolve(ok({ key: 'k-c', source: { kind: 'git', url: 'https://x.dev/a.git', root: 'C:/data/clone' }, title: 'clone', lastOpened: NOW })) })
    await settle()
    expect(props.onOpen).toHaveBeenCalledTimes(1)
    expect(props.onOpen).toHaveBeenCalledWith({ kind: 'root', root: 'C:/data/clone', key: 'k-c' })
  })

  it('a slow map, then Design it pressed: the design opens and the map does not', async () => {
    const d = deferred<Res<unknown>>()
    const { props, mapped } = slowMap({ worldDesignDraft: vi.fn(() => d.promise) })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Design something new/ }))
    fireEvent.change(screen.getByPlaceholderText('Describe the app you want…'), { target: { value: 'A shop' } })
    fireEvent.click(screen.getByRole('button', { name: 'Design it' }))
    await mapped()
    expect(props.onOpen).not.toHaveBeenCalled()
    await act(async () => { d.resolve(ok({ key: 'design:new', doc: {}, text: 'Drafted.' })) })
    await settle()
    expect(props.onOpen).toHaveBeenCalledTimes(1)
    expect(props.onOpen).toHaveBeenCalledWith({ kind: 'design', key: 'design:new' })
  })

  // A map that finishes while the person is choosing waits for that choice, so nothing pulls them out of it (F-R4).
  it('a map that finishes while the clone dialog is up waits: Cancel then opens it', async () => {
    const { props, mapped } = slowMap()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Open a git repository/ }))
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://x.dev/a' } })
    await mapped()
    expect(props.onOpen).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Repository URL')).toHaveValue('https://x.dev/a')
    fireEvent.click(within(screen.getByTestId('world-clone')).getByRole('button', { name: 'Cancel' }))
    expect(props.onOpen).toHaveBeenCalledTimes(1)
    expect(props.onOpen).toHaveBeenCalledWith(MAPPED)
  })

  it('a map that finishes while the design dialog is up, then Design it pressed: only the design opens', async () => {
    const { props, mapped } = slowMap()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Design something new/ }))
    await mapped()
    expect(props.onOpen).not.toHaveBeenCalled()
    fireEvent.change(screen.getByPlaceholderText('Describe the app you want…'), { target: { value: 'A shop' } })
    fireEvent.click(screen.getByRole('button', { name: 'Design it' }))
    await settle()
    expect(props.onOpen).toHaveBeenCalledTimes(1)
    expect(props.onOpen).toHaveBeenCalledWith({ kind: 'design', key: 'design:new' })
  })

  it('a map that waited for a dialog opens nothing once the pane moved meanwhile', async () => {
    const d = deferred<Res<WorldEntry>>()
    bridge({ worldMapProject: vi.fn(() => d.promise) })
    const ticket = panes()
    const props = home({ ticket })
    fireEvent.click(screen.getByRole('button', { name: /^Map this project/ }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Open a git repository/ }))
    d.resolve(ok({ key: 'k-new', source: { kind: 'project', root: 'C:/repo/src-root' }, title: 'x', lastOpened: NOW }))
    await settle()
    ticket()
    fireEvent.click(within(screen.getByTestId('world-clone')).getByRole('button', { name: 'Cancel' }))
    expect(props.onOpen).not.toHaveBeenCalled()
  })

  it('a map that finishes while the folder picker is up waits for it: a cancel or a failed pick opens it then', async () => {
    for (const answer of [ok(null), fail("Lumopolis couldn't open that folder.")]) {
      const pick = deferred<Res<WorldEntry | null>>()
      const { props, mapped } = slowMap({ worldOpenFolder: vi.fn(() => pick.promise) })
      await settle()
      fireEvent.click(screen.getByRole('button', { name: /^Open a folder/ }))
      await mapped()
      expect(props.onOpen).not.toHaveBeenCalled()
      await act(async () => { pick.resolve(answer as Res<WorldEntry | null>) })
      await settle()
      expect(props.onOpen).toHaveBeenCalledTimes(1)
      expect(props.onOpen).toHaveBeenCalledWith(MAPPED)
      cleanup()
    }
  })

  it('a picker that throws lets a map that waited for it open, and says the fixed words', async () => {
    const pick = deferred<Res<WorldEntry | null>>()
    const { props, mapped } = slowMap({ worldOpenFolder: vi.fn(() => pick.promise) })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Open a folder/ }))
    await mapped()
    await act(async () => { pick.reject(new Error('ipc down')) })
    await settle()
    expect(props.onOpen).toHaveBeenCalledWith(MAPPED)
    expect(screen.getByRole('alert')).toHaveTextContent(UI_FAILED)
  })

  it('with a ticket that holds, each of them opens its world as before', async () => {
    bridge()
    const props = home({ ticket: () => () => true })
    fireEvent.click(screen.getByRole('button', { name: /^Open a folder/ }))
    await settle()
    expect(props.onOpen).toHaveBeenLastCalledWith({ kind: 'root', root: 'C:/picked', key: 'k-f' })
  })
})

describe('WorldHome dialog keyboard (F-R13)', () => {
  it('while a dialog is up the home behind it is inert and the pane is told; closing gives the focus back to the button that opened it', () => {
    bridge()
    const onDialog = vi.fn()
    home({ onDialog })
    const content = screen.getByTestId('world-home-content')
    expect(content.inert).not.toBe(true)
    const trigger = screen.getByRole('button', { name: /^Open a git repository/ })
    trigger.focus()
    fireEvent.click(trigger)
    expect(content.inert).toBe(true)
    expect(onDialog).toHaveBeenLastCalledWith(true)
    expect(screen.getByLabelText('Repository URL')).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(content.inert).toBe(false)
    expect(onDialog).toHaveBeenLastCalledWith(false)
    expect(trigger).toHaveFocus()
  })

  it('the design dialog starts in its description box and gives the focus back too', () => {
    bridge()
    home()
    const trigger = screen.getByRole('button', { name: /^Design something new/ })
    fireEvent.click(trigger)
    expect(screen.getByPlaceholderText('Describe the app you want…')).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(trigger).toHaveFocus()
  })

  it("Tab and Shift+Tab go round the dialog's own controls", () => {
    bridge()
    home()
    fireEvent.click(screen.getByRole('button', { name: /^Open a git repository/ }))
    const url = screen.getByLabelText('Repository URL')
    fireEvent.change(url, { target: { value: 'https://x.dev/a.git' } })
    const clone = screen.getByRole('button', { name: 'Clone' })
    clone.focus()
    fireEvent.keyDown(clone, { key: 'Tab' })
    expect(url).toHaveFocus()
    fireEvent.keyDown(url, { key: 'Tab', shiftKey: true })
    expect(clone).toHaveFocus()
    // In between the trap moves the focus itself, one control at a time; other keys are left alone.
    const branch = screen.getByLabelText('Branch (optional)')
    branch.focus()
    expect(fireEvent.keyDown(branch, { key: 'Tab' })).toBe(false)
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(branch).toHaveFocus()
    expect(fireEvent.keyDown(branch, { key: 'x' })).toBe(true)
    expect(branch).toHaveFocus()
  })

  it('a trigger that went away while the dialog was up is not focused', () => {
    bridge()
    const onDialog = vi.fn()
    home({ onDialog })
    const trigger = screen.getByRole('button', { name: /^Open a git repository/ })
    fireEvent.click(trigger)
    trigger.remove()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(trigger).not.toHaveFocus()
    expect(onDialog).toHaveBeenLastCalledWith(false)
  })
})

describe('WorldHome token dialog keyboard (F-R13)', () => {
  const tab = (shiftKey = false): boolean => fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab', shiftKey })
  const SIGN_IN = () => ok({ needsLogin: { host: 'github.com', helper: true, message: 'Sign in please.' } })
  /** The first clone asks for a sign-in; every later one is `then`. */
  const asksFirst = (then: () => Promise<unknown>) => {
    let first = true
    return vi.fn(() => {
      if (first) { first = false; return Promise.resolve(SIGN_IN()) }
      return then()
    })
  }
  const tokenUp = async (worldClone: (...a: unknown[]) => Promise<unknown>, over: Partial<Parameters<typeof WorldHome>[0]> = {}) => {
    bridge({ worldClone })
    const props = home(over)
    fireEvent.click(screen.getByRole('button', { name: /^Open a git repository/ }))
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://github.com/o/r.git' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    const useToken = await screen.findByTestId('world-clone-use-token')
    useToken.focus()
    fireEvent.click(useToken)
    return { props, token: screen.getByTestId('world-repo-access') }
  }

  it('Tab and Shift+Tab go round the token dialog alone, never into the clone dialog under it', async () => {
    const { token } = await tokenUp(vi.fn(async () => SIGN_IN()))
    const make = within(token).getByRole('button', { name: 'Make a token on GitHub' })
    const field = screen.getByTestId('world-repo-access-input')
    const cancel = within(token).getByRole('button', { name: 'Cancel' })
    const use = within(token).getByRole('button', { name: 'Use this token' })
    expect(field).toHaveFocus()
    tab(true)
    expect(make).toHaveFocus()
    tab(true)
    expect(use).toHaveFocus()
    tab()
    expect(make).toHaveFocus()
    tab()
    expect(field).toHaveFocus()
    tab()
    expect(cancel).toHaveFocus()
    for (let i = 0; i < 8; i++) {
      tab(i % 2 === 0)
      expect(token.contains(document.activeElement)).toBe(true)
    }
  })

  it('Use this token turning grey while the token is tried keeps the focus in the token dialog, and Tab goes round what is left', async () => {
    const d = deferred<Res<unknown>>()
    const { token } = await tokenUp(asksFirst(() => d.promise))
    fireEvent.change(screen.getByTestId('world-repo-access-input'), { target: { value: 'ghp_x' } })
    const use = within(token).getByRole('button', { name: 'Use this token' })
    use.focus()
    fireEvent.click(use)
    expect(use).toBeDisabled()
    expect(token).toHaveFocus()
    tab(true)
    expect(within(token).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    tab()
    expect(within(token).getByRole('button', { name: 'Make a token on GitHub' })).toHaveFocus()
    await act(async () => { d.resolve(ok({ needsLogin: { host: 'github.com', helper: true, message: 'That token did not open it.' } })) })
    expect(within(token).getByRole('alert')).toHaveTextContent('That token did not open it.')
  })

  it('Clone, or Enter in the address, turning grey keeps the focus in the clone dialog', async () => {
    const d = deferred<Res<WorldEntry>>()
    bridge({ worldClone: vi.fn(() => d.promise) })
    home()
    fireEvent.click(screen.getByRole('button', { name: /^Open a git repository/ }))
    const url = screen.getByLabelText('Repository URL')
    fireEvent.change(url, { target: { value: 'https://x.dev/a.git' } })
    const clone = screen.getByRole('button', { name: 'Clone' })
    clone.focus()
    fireEvent.click(clone)
    expect(clone).toBeDisabled()
    const dialog = screen.getByTestId('world-clone')
    expect(dialog).toHaveFocus()
    tab()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    tab(true)
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await act(async () => { d.resolve(fail(CLONE_STOPPED_MESSAGE)) })
    url.focus()
    fireEvent.keyDown(url, { key: 'Enter' })
    expect(url).toBeDisabled()
    expect(dialog).toHaveFocus()
  })

  it('cancelling the token dialog while its token is tried stops that clone and says so; the focus stays in the clone dialog', async () => {
    const d = deferred<Res<unknown>>()
    const { props } = await tokenUp(asksFirst(() => d.promise))
    fireEvent.change(screen.getByTestId('world-repo-access-input'), { target: { value: 'ghp_x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use this token' }))
    fireEvent.click(within(screen.getByTestId('world-repo-access')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('world-repo-access')).toBeNull()
    expect(window.termpolis.worldCloneCancel).toHaveBeenCalledWith('https://github.com/o/r.git', undefined)
    // Use a token is grey until the stopped try answers, so the dialog holds the focus (F-R13).
    expect(screen.getByTestId('world-clone-use-token')).toBeDisabled()
    expect(screen.getByTestId('world-clone')).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(STOPPING_MESSAGE)
    await act(async () => { d.resolve(fail(CLONE_STOPPED_MESSAGE)) })
    expect(screen.getByRole('alert')).toHaveTextContent(TOKEN_STOPPED_MESSAGE)
    expect(screen.getByTestId('world-clone-use-token')).toBeEnabled()
    expect(props.onChanged).not.toHaveBeenCalled()
    expect(props.onOpen).not.toHaveBeenCalled()
  })

  it('a token clone that finished before the stop is kept: the home list is refreshed, nothing is opened', async () => {
    const d = deferred<Res<WorldEntry>>()
    const { props } = await tokenUp(asksFirst(() => d.promise))
    fireEvent.change(screen.getByTestId('world-repo-access-input'), { target: { value: 'ghp_x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use this token' }))
    fireEvent.click(within(screen.getByTestId('world-repo-access')).getByRole('button', { name: 'Cancel' }))
    await act(async () => { d.resolve(ok({ key: 'k-c', source: { kind: 'git', url: 'https://github.com/o/r.git', root: 'C:/data/clone' }, title: 'clone', lastOpened: NOW })) })
    await settle()
    expect(props.onChanged).toHaveBeenCalled()
    expect(props.onOpen).not.toHaveBeenCalled()
    expect(screen.getByTestId('world-clone')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(CLONE_KEPT_MESSAGE)
  })

  it('Esc in the token dialog while its token is tried stops that clone too', async () => {
    const d = deferred<Res<WorldEntry>>()
    const escRef = { current: null as (() => boolean) | null }
    await tokenUp(asksFirst(() => d.promise), { escRef })
    fireEvent.change(screen.getByTestId('world-repo-access-input'), { target: { value: 'ghp_x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use this token' }))
    act(() => { (escRef.current as () => boolean)() })
    expect(screen.queryByTestId('world-repo-access')).toBeNull()
    expect(window.termpolis.worldCloneCancel).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('world-clone')).toHaveFocus()
  })
})

describe('CloneDialog token dialog keyboard (F-R13)', () => {
  it('the clone dialog under the token dialog is inert, and closing the token dialog gives the focus back to Use a token', async () => {
    bridge({ worldClone: vi.fn(async () => ok({ needsLogin: { host: 'github.com', helper: true, message: 'Sign in please.' } })) })
    render(<CloneDialog onCloned={vi.fn()} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://github.com/o/r.git' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    fireEvent.click(await screen.findByTestId('world-clone-use-token'))
    expect(screen.getByTestId('world-clone').inert).toBe(true)
    expect(screen.getByTestId('world-repo-access-input')).toHaveFocus()
    fireEvent.click(within(screen.getByTestId('world-repo-access')).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('world-clone').inert).toBe(false)
    expect(screen.getByTestId('world-clone-use-token')).toHaveFocus()
  })

  it('a clone dialog that closes while a token is tried gives the focus to nothing grey', async () => {
    let first = true
    const worldClone = vi.fn(() => {
      if (first) { first = false; return Promise.resolve(ok({ needsLogin: { host: 'github.com', helper: true, message: 'Sign in please.' } })) }
      return new Promise(() => undefined)
    })
    bridge({ worldClone })
    const r = render(<CloneDialog onCloned={vi.fn()} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://github.com/o/r.git' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    const useToken = await screen.findByTestId('world-clone-use-token')
    fireEvent.click(useToken)
    fireEvent.change(screen.getByTestId('world-repo-access-input'), { target: { value: 'ghp_x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use this token' }))
    expect(useToken).toBeDisabled()
    const dialog = screen.getByTestId('world-clone')
    const focused = vi.spyOn(dialog, 'focus')
    r.unmount()
    expect(focused).toHaveBeenCalled()
    expect(useToken).not.toHaveFocus()
  })

  it('a clone dialog that closes with the token dialog still up focuses nothing that has gone', async () => {
    bridge({ worldClone: vi.fn(async () => ok({ needsLogin: { host: 'github.com', helper: true, message: 'Sign in please.' } })) })
    const r = render(<CloneDialog onCloned={vi.fn()} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'https://github.com/o/r.git' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }))
    const useToken = await screen.findByTestId('world-clone-use-token')
    fireEvent.click(useToken)
    r.unmount()
    expect(useToken.isConnected).toBe(false)
    expect(useToken).not.toHaveFocus()
  })
})
