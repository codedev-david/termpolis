// Branch backfill for three modules whose DEFENSIVE paths the happy-path suites
// never reach: WorkflowDesigner (the renderer canvas), artifactInstaller (Safe
// Import's install stage) and terminalStore (the renderer's zustand store).
//
// The common theme is "input that only a human-edited file or a third-party
// archive produces": a workflow.yaml with a bare `trigger: schedule` and no
// config, a zip entry with an empty path, an MCP env block whose values are
// numbers. The UI never generates those, so the happy-path tests never see
// them — which is exactly why they are worth pinning down.
//
// artifactInstaller is main-process code but imports nothing from electron and
// only touches the fs through injected deps, so it runs fine in jsdom.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { join } from 'path'

import { WorkflowDesigner, looksLikeCron } from '../../src/renderer/src/components/Workflow/WorkflowDesigner'
import {
  classifyArtifact,
  installArtifact,
  type Artifact,
  type InstallerDeps,
} from '../../src/main/artifactInstaller'
import { useTerminalStore, buildPaneTree } from '../../src/renderer/src/store/terminalStore'
import type { PaneNode, TerminalSession, Workflow, CustomKeybinding } from '../../src/renderer/src/types'
import type { ConversationTurn } from '../../src/renderer/src/lib/conversationParser'

// ---------------------------------------------------------------------------
// WorkflowDesigner
// ---------------------------------------------------------------------------

const cmdStep = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'a', type: 'command', name: 'A', source: 'inline', command: '', ...over,
})

const wfWith = (over: Partial<Workflow> = {}): Workflow => ({
  id: 'x', name: 'X', version: 1, trigger: { type: 'manual' }, steps: [], ...over,
} as Workflow)

describe('WorkflowDesigner — inputs the UI never produces', () => {
  beforeEach(() => {
    ;(window as unknown as { termpolis: unknown }).termpolis = {
      saveWorkflow: vi.fn().mockResolvedValue({ success: true }),
    }
  })

  describe('looksLikeCron', () => {
    // The designer always hands it a string, but the same helper guards a value
    // read straight out of a hand-edited YAML file, where a missing `cron:` key
    // arrives as undefined. Nullish input must read as "not a cron", not throw.
    it('treats a missing expression as invalid instead of throwing', () => {
      expect(looksLikeCron(undefined as unknown as string)).toBe(false)
      expect(looksLikeCron(null as unknown as string)).toBe(false)
    })

    it('treats a whitespace-only expression as invalid', () => {
      // ' \t ' survives the `expr ?? ''` guard but trims to empty — without the
      // early return it would split into a single "field" and read as malformed
      // rather than empty, which is the same answer by luck, not by design.
      expect(looksLikeCron('   \t ')).toBe(false)
      expect(looksLikeCron('')).toBe(false)
    })
  })

  it('a schedule trigger with no config at all shows an empty cron and warns', () => {
    // `trigger: { type: schedule }` with no `config:` is what a hand-written
    // workflow.yaml gives you. Every field must fall back rather than crash on
    // `config.cron`, and the "this can never fire" warning must be up front.
    render(<WorkflowDesigner workflow={wfWith({ trigger: { type: 'schedule' } })} cwd="/r" onSaved={() => {}} />)

    expect((screen.getByLabelText('Cron') as HTMLInputElement).value).toBe('')
    expect(screen.getByText(/Needs 5 fields/)).toBeTruthy()

    // Typing into that field is the other half: setTriggerCfg has to synthesise
    // the missing config object instead of spreading `undefined`.
    fireEvent.change(screen.getByLabelText('Cron'), { target: { value: '0 9 * * 1' } })
    expect((screen.getByLabelText('Cron') as HTMLInputElement).value).toBe('0 9 * * 1')
    expect(screen.queryByText(/Needs 5 fields/)).toBeNull()
  })

  it('editing one step leaves its siblings untouched', () => {
    render(
      <WorkflowDesigner
        workflow={wfWith({ steps: [cmdStep({ id: 's1', name: 'First' }), cmdStep({ id: 's2', name: 'Second' })] as never })}
        cwd="/r"
        onSaved={() => {}}
      />
    )
    const names = () => screen.getAllByLabelText('Step name') as HTMLInputElement[]
    fireEvent.change(names()[1], { target: { value: 'Renamed' } })

    expect(names()[0].value).toBe('First')
    expect(names()[1].value).toBe('Renamed')
  })

  it('editing one input leaves its siblings untouched', () => {
    render(
      <WorkflowDesigner
        workflow={wfWith({ inputs: [{ name: 'env' }, { name: 'tag' }] })}
        cwd="/r"
        onSaved={() => {}}
      />
    )
    fireEvent.change(screen.getByLabelText('Input 2 name'), { target: { value: 'release' } })

    expect((screen.getByLabelText('Input 1 name') as HTMLInputElement).value).toBe('env')
    expect((screen.getByLabelText('Input 2 name') as HTMLInputElement).value).toBe('release')
  })

  it('renders a generic icon for a step type it does not recognise', () => {
    // A workflow.yaml can name any step type; an older build reading a newer
    // file must still draw the card (with a placeholder glyph) rather than
    // render `undefined` into the class list.
    render(
      <WorkflowDesigner
        workflow={wfWith({ steps: [cmdStep({ id: 's1', name: 'From the future', type: 'quantum' })] as never })}
        cwd="/r"
        onSaved={() => {}}
      />
    )
    const icon = screen.getByTestId('step-card').querySelector('i')
    expect(icon?.className).toContain('fa-cube')
    expect((screen.getByLabelText('Step name') as HTMLInputElement).value).toBe('From the future')
  })

  it('shows a generic message when a failed save reports no reason', async () => {
    // The main-process handler can reject with `{ success: false }` and no
    // `error` (e.g. a rejected promise mapped to a bare failure). Silently
    // showing nothing would read as a successful save.
    const onSaved = vi.fn()
    ;(window as unknown as { termpolis: { saveWorkflow: unknown } }).termpolis = {
      saveWorkflow: vi.fn().mockResolvedValue({ success: false }),
    }
    render(<WorkflowDesigner workflow={wfWith()} cwd="/r" onSaved={onSaved} />)

    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(screen.getByText('Failed to save workflow')).toBeTruthy())
    expect(onSaved).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// artifactInstaller — hostile / malformed third-party archives
// ---------------------------------------------------------------------------

const HOME = '/home/dev'

function fakeFs(home = HOME) {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const deps: InstallerDeps = {
    home: () => home,
    readFile: (p) => (files.has(p) ? (files.get(p) as string) : null),
    writeFile: (p, data) => { files.set(p, data) },
    mkdirp: (p) => { dirs.add(p) },
    exists: (p) => files.has(p) || dirs.has(p),
    rm: (p) => { files.delete(p) },
  }
  return { deps, files }
}

describe('artifactInstaller — malformed archives still land safely', () => {
  it('classifies an entry with an empty path and falls back to the name "mcp"', () => {
    // Some zip readers emit a directory-ish entry with a blank path. Every path
    // helper has to tolerate it, and with no filename and no server key left to
    // name the artifact after, the last-resort literal is what we install as.
    expect(classifyArtifact([{ path: '', content: '{"mcpServers":{}}' }])).toEqual({
      kind: 'mcp',
      name: 'mcp',
    })
  })

  it('names a bare SKILL.md with no frontmatter "skill"', () => {
    // No parent directory to borrow a name from, and an empty file has no
    // frontmatter to read one out of — it still has to classify, because
    // refusing here would reject a legitimate (if lazy) one-file skill.
    expect(classifyArtifact([{ path: 'SKILL.md', content: '' }])).toEqual({
      kind: 'skill',
      name: 'skill',
    })
  })

  it('ignores frontmatter lines that are not key: value pairs', () => {
    // The bare word `tools` is NOT the `tools:` key. If the line parser were
    // loose enough to accept it, this markdown would gain a `tools` entry and
    // get misfiled as a subagent — installed to ~/.claude/agents instead of
    // ~/.claude/commands, where the user would never find it.
    expect(
      classifyArtifact([{ path: 'deploy.md', content: '---\nname: deploy\ndescription: Ship it\ntools\n\n---\nbody' }])
    ).toEqual({ kind: 'command', name: 'deploy' })
  })

  it('gives a nameless artifact a safe deterministic name instead of an empty path', () => {
    // `name` comes from the third party. Punctuation-only and empty names both
    // sanitise to nothing — writing `~/.claude/commands/.md` would be an
    // invisible dotfile, so the installer substitutes a literal instead.
    const { deps, files } = fakeFs()
    const a: Artifact = {
      kind: 'command',
      name: '',
      files: [{ path: 'x.md', content: '---\ndescription: hi\n---\nbody' }],
    }
    expect(installArtifact(a, ['claude'], deps)).toEqual([
      { target: 'claude', path: join(HOME, '.claude', 'commands', 'artifact.md') },
    ])
    expect(files.has(join(HOME, '.claude', 'commands', 'artifact.md'))).toBe(true)
  })

  it('sanitises a punctuation-only name down to the same literal', () => {
    const { deps } = fakeFs()
    const a: Artifact = {
      kind: 'command',
      name: '@@@',
      files: [{ path: 'x.md', content: '---\ndescription: hi\n---\nbody' }],
    }
    expect(installArtifact(a, ['claude'], deps)).toEqual([
      { target: 'claude', path: join(HOME, '.claude', 'commands', 'artifact.md') },
    ])
  })

  it('emits a valid Gemini TOML for a command whose markdown is empty', () => {
    // primaryMarkdown only refuses a MISSING markdown (null), so a present-but-
    // empty file reaches the TOML renderer. It must still produce a parseable
    // block — a half-written `prompt = ` would corrupt the user's commands dir.
    const { deps, files } = fakeFs()
    const a: Artifact = { kind: 'command', name: 'blank', files: [{ path: 'blank.md', content: '' }] }
    installArtifact(a, ['gemini'], deps)

    const toml = files.get(join(HOME, '.gemini', 'commands', 'blank.toml')) as string
    expect(toml).toContain('prompt = """')
    expect(toml).not.toContain('description =')
  })

  it('drops non-string env values from an MCP server rather than writing them through', () => {
    // A hand-written .mcp.json commonly has `"PORT": 8080` (a number). The
    // agent configs expect string env values, so a numeric one is dropped — and
    // when that empties the map the key is omitted entirely instead of written
    // as `"env": {}`.
    const { deps, files } = fakeFs()
    const a: Artifact = {
      kind: 'mcp',
      name: 'srv',
      files: [{
        path: '.mcp.json',
        content: JSON.stringify({ mcpServers: { srv: { command: 'node', env: { PORT: 8080 } } } }),
      }],
    }
    installArtifact(a, ['claude'], deps)

    const settings = JSON.parse(files.get(join(HOME, '.claude', 'settings.json')) as string)
    expect(settings.mcpServers.srv).toEqual({ command: 'node' })
  })

  it('keeps the string env values alongside a dropped numeric one', () => {
    // The partial case matters more than the empty one: dropping the whole
    // block because ONE value was a number would silently break the server.
    const { deps, files } = fakeFs()
    const a: Artifact = {
      kind: 'mcp',
      name: 'srv',
      files: [{
        path: '.mcp.json',
        content: JSON.stringify({ mcpServers: { srv: { command: 'node', env: { PORT: 8080, TOKEN: 'abc' } } } }),
      }],
    }
    installArtifact(a, ['claude'], deps)

    const settings = JSON.parse(files.get(join(HOME, '.claude', 'settings.json')) as string)
    expect(settings.mcpServers.srv.env).toEqual({ TOKEN: 'abc' })
  })
})

// ---------------------------------------------------------------------------
// terminalStore
// ---------------------------------------------------------------------------

function makeTerminal(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: 't1',
    name: 'Terminal 1',
    color: '#00ff00',
    shellType: 'bash',
    cwd: '/home/user',
    fontSize: 14,
    theme: 'dark',
    fontFamily: 'monospace',
    ...overrides,
  }
}

function makeTurn(over: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    role: 'user',
    content: 'hello',
    timestamp: 1,
    terminalId: 'a',
    terminalName: 'A',
    agentName: 'claude',
    ...over,
  }
}

const splitOf = (leftId: string, rightId: string): PaneNode => ({
  type: 'split',
  direction: 'horizontal',
  ratio: 0.5,
  children: [
    { type: 'terminal', terminalId: leftId },
    { type: 'terminal', terminalId: rightId },
  ],
})

const initialState = useTerminalStore.getState()

describe('terminalStore — sibling-preserving updates and pane-tree guards', () => {
  beforeEach(() => {
    useTerminalStore.setState({ ...initialState }, true)
  })

  it('updateTerminal rewrites only the addressed terminal', () => {
    useTerminalStore.getState().addTerminal(makeTerminal({ id: 'a', name: 'Alpha' }))
    useTerminalStore.getState().addTerminal(makeTerminal({ id: 'b', name: 'Beta' }))
    const before = useTerminalStore.getState().terminals.find(t => t.id === 'b')

    useTerminalStore.getState().updateTerminal('a', { name: 'Renamed' })

    const after = useTerminalStore.getState().terminals
    expect(after.find(t => t.id === 'a')!.name).toBe('Renamed')
    // Same object, not a re-spread copy — the untouched row must not re-render.
    expect(after.find(t => t.id === 'b')).toBe(before)
  })

  it('updateCustomKeybinding rewrites only the addressed binding', () => {
    const one: CustomKeybinding = { id: 'k1', label: 'Grep', combo: 'Ctrl+Alt+G', text: 'rg ', runOnSend: false }
    const two: CustomKeybinding = { id: 'k2', label: 'Build', combo: 'Ctrl+Alt+B', text: 'npm run build', runOnSend: true }
    useTerminalStore.getState().addCustomKeybinding(one)
    useTerminalStore.getState().addCustomKeybinding(two)

    useTerminalStore.getState().updateCustomKeybinding('k2', { combo: 'Ctrl+Alt+K' })

    const all = useTerminalStore.getState().customKeybindings
    expect(all.find(k => k.id === 'k1')).toEqual(one)
    expect(all.find(k => k.id === 'k2')!.combo).toBe('Ctrl+Alt+K')
  })

  it('addConversationTurn appends to the addressed conversation only', () => {
    useTerminalStore.getState().addConversationTurn('a', 'A', 'claude', makeTurn())
    useTerminalStore.getState().addConversationTurn('b', 'B', 'codex', makeTurn({ terminalId: 'b', content: 'first-b' }))

    useTerminalStore.getState().addConversationTurn('a', 'A', 'claude', makeTurn({ content: 'second-a' }))

    const convos = useTerminalStore.getState().conversations
    expect(convos.find(c => c.terminalId === 'a')!.turns.map(t => t.content)).toEqual(['hello', 'second-a'])
    expect(convos.find(c => c.terminalId === 'b')!.turns.map(t => t.content)).toEqual(['first-b'])
  })

  it('removeTerminal prunes the surviving pane tree while in tabs mode', () => {
    // Leaving split mode KEEPS paneTree (toggleViewMode only rebuilds on the way
    // in), so a close while in tabs must prune the retained tree rather than
    // rebuild it — otherwise toggling back would show a pane for a dead pty.
    useTerminalStore.setState({
      terminals: [makeTerminal({ id: 'a' }), makeTerminal({ id: 'b' })],
      activeTerminalId: 'b',
      viewMode: 'tabs',
      paneTree: splitOf('a', 'b'),
    })

    useTerminalStore.getState().removeTerminal('a')

    expect(useTerminalStore.getState().paneTree).toEqual({ type: 'terminal', terminalId: 'b' })
  })

  it('splitTerminal replaces the left leaf of a split without disturbing the right', () => {
    useTerminalStore.setState({ paneTree: splitOf('a', 'b') })
    useTerminalStore.getState().splitTerminal('a', 'vertical', 'a2')

    const tree = useTerminalStore.getState().paneTree as PaneNode & { type: 'split' }
    expect(tree.children[0]).toEqual({
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      children: [
        { type: 'terminal', terminalId: 'a' },
        { type: 'terminal', terminalId: 'a2' },
      ],
    })
    expect(tree.children[1]).toEqual({ type: 'terminal', terminalId: 'b' })
    expect(useTerminalStore.getState().activeTerminalId).toBe('a2')
  })

  it('splitTerminal replaces the right leaf of a split without disturbing the left', () => {
    useTerminalStore.setState({ paneTree: splitOf('a', 'b') })
    useTerminalStore.getState().splitTerminal('b', 'horizontal', 'b2')

    const tree = useTerminalStore.getState().paneTree as PaneNode & { type: 'split' }
    expect(tree.children[0]).toEqual({ type: 'terminal', terminalId: 'a' })
    expect(tree.children[1]).toEqual({
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        { type: 'terminal', terminalId: 'b' },
        { type: 'terminal', terminalId: 'b2' },
      ],
    })
  })

  describe('buildPaneTree null-subtree guards', () => {
    // With a real string[] both halves of the split are non-empty for any
    // length >= 2, so these guards cannot fire from the app. They exist so a
    // null subtree collapses to its sibling instead of producing a split node
    // with a null child (which the pane renderer would crash on), and the only
    // way to prove that is to hand the recursion an array-like that yields an
    // empty half.
    const fakeIds = (len: number, left: string[], right: string[]): string[] => {
      let call = 0
      return {
        length: len,
        slice: () => (call++ === 0 ? left : right),
      } as unknown as string[]
    }

    it('collapses to the right subtree when the left half comes back empty', () => {
      expect(buildPaneTree(fakeIds(2, [], ['b']))).toEqual({ type: 'terminal', terminalId: 'b' })
    })

    it('collapses to the left subtree when the right half comes back empty', () => {
      expect(buildPaneTree(fakeIds(2, ['a'], []))).toEqual({ type: 'terminal', terminalId: 'a' })
    })
  })
})

describe('terminalStore — defaultShell follows the host platform', () => {
  const storePath = '../../src/renderer/src/store/terminalStore'
  const hadOwnPlatform = Object.prototype.hasOwnProperty.call(window.navigator, 'platform')

  afterEach(() => {
    if (!hadOwnPlatform) Reflect.deleteProperty(window.navigator, 'platform')
    vi.resetModules()
  })

  // defaultShell is read ONCE, at store-creation time, so the platform has to be
  // in place before the module is evaluated — hence resetModules + a fresh
  // import rather than setting state on the already-created store.
  async function freshDefaultShell(platform: string): Promise<string> {
    Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true })
    vi.resetModules()
    const mod = await import(storePath)
    return mod.useTerminalStore.getState().defaultShell
  }

  it('picks powershell on Windows', async () => {
    expect(await freshDefaultShell('Win32')).toBe('powershell')
  })

  it('picks zsh on macOS', async () => {
    expect(await freshDefaultShell('MacIntel')).toBe('zsh')
  })

  it('falls back to bash on everything else', async () => {
    expect(await freshDefaultShell('Linux x86_64')).toBe('bash')
  })
})
