// The Lumopolis home and its dialogs (Plan 4, Task 6): the four ways in, the recent worlds, the clone
// and design-start dialogs, Build it and the toolbar's world switcher. The bridge is mocked; every
// call is checked for what it was handed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import type { WorldEntry, WorldFolderPick, BuildItResult } from '../../../src/shared/world/types'
import { BAD_URL_MESSAGE, BAD_REF_MESSAGE } from '../../../src/shared/world/gitUrl'

const vm = vi.hoisted(() => ({
  status: 'idle' as string, errorMsg: null as string | null, toggle: vi.fn(),
  sink: null as null | ((t: string) => void),
}))
vi.mock('../../../src/renderer/src/hooks/useVoiceInput', () => ({
  useVoiceInput: (...args: unknown[]) => {
    vm.sink = (args[2] as { onTranscript: (t: string) => void }).onTranscript
    return { status: vm.status, errorMsg: vm.errorMsg, toggle: vm.toggle }
  },
}))

import { WorldHome, agoText, targetOf } from '../../../src/renderer/src/components/World/WorldHome'
import { CloneDialog } from '../../../src/renderer/src/components/World/CloneDialog'
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
    expect(props.onOpen).toHaveBeenLastCalledWith({ kind: 'root', root: 'C:/data/a' })
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
    expect(props.onOpen).toHaveBeenCalledWith({ kind: 'root', root: 'C:/picked' })
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
    expect(props.onOpen).toHaveBeenCalledWith({ kind: 'root', root: 'C:/data/clone' })
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
    expect(targetOf(entries()[1])).toEqual({ kind: 'root', root: 'C:/notes' })
  })
})

describe('CloneDialog', () => {
  const mount = () => {
    const props = { onCloned: vi.fn(), onClose: vi.fn() }
    render(<CloneDialog {...props} />)
    return props
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

  it('cancel during clone calls world:clone cancel', async () => {
    const d = deferred<Res<WorldEntry>>()
    const api = bridge({ worldClone: vi.fn(() => d.promise) })
    const props = mount()
    fireEvent.change(url(), { target: { value: 'https://x.dev/a.git' } })
    fireEvent.click(cloneBtn())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.worldCloneCancel).toHaveBeenCalledWith('https://x.dev/a.git', undefined)
    await settle()
    // The cancelled clone's failure is not shown, and the dialog is ready for another try.
    d.resolve(fail('Clone cancelled.'))
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(props.onCloned).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('progressbar')).toBeNull()
    // Not cloning: Cancel closes.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onClose).toHaveBeenCalled()
  })

  it('a cancel that cannot reach main is quiet; a cancelled clone that succeeded anyway is dropped', async () => {
    const d = deferred<Res<WorldEntry>>()
    bridge({ worldClone: vi.fn(() => d.promise), worldCloneCancel: vi.fn(async () => { throw new Error('x') }) })
    const props = mount()
    fireEvent.change(url(), { target: { value: 'https://x.dev/a.git' } })
    fireEvent.change(branch(), { target: { value: 'main' } })
    fireEvent.click(cloneBtn())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await settle()
    d.resolve(ok({ key: 'k', source: { kind: 'git', url: 'u', root: 'r' }, title: 't', lastOpened: 1 }))
    await settle()
    expect(props.onCloned).not.toHaveBeenCalled()
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
    expect(api.worldDesignDraft).toHaveBeenCalledWith('A small shop with a cart', expect.stringMatching(/^draft:[A-Za-z0-9][A-Za-z0-9-]*$/))
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
    expect(api.worldDesignDraft).toHaveBeenCalledWith('A shop with a cart', expect.any(String))
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
    expect(screen.getByRole('button', { name: 'Describe by voice' }).className).toContain('animate-pulse')
  })

  it('Cancel while drafting stops the draft by its key and drops the late result', async () => {
    const d = deferred<Res<{ key: string; doc: unknown; text: string }>>()
    const api = bridge({ worldDesignDraft: vi.fn(() => d.promise) })
    const props = mount()
    fireEvent.change(box(), { target: { value: 'A shop' } })
    fireEvent.click(screen.getByRole('button', { name: 'Design it' }))
    expect(screen.getByRole('status')).toHaveTextContent('Drafting your design…')
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
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'root', root: 'C:/notes' })
    fireEvent.change(sel, { target: { value: 'design:shop' } })
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'design', key: 'design:shop' })
    fireEvent.change(sel, { target: { value: '__home' } })
    expect(onHome).toHaveBeenCalled()
    fireEvent.change(sel, { target: { value: '' } })
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(onHome).toHaveBeenCalledTimes(1)
  })
})
