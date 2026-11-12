import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useTerminalStore } from '../../src/renderer/src/store/terminalStore'
import {
  splitPane,
  splitActivePane,
  exportActivePane,
  toggleRecordingActivePane,
} from '../../src/renderer/src/lib/paneCommands'

// The command palette's Split Right / Split Down, Export Terminal Output and Start/Stop Recording
// used to do nothing (1.60.0 fix). These run against the real store.

const createTerminal = vi.fn()
const base = {
  id: 't1', name: 'Shell', color: '#fff', shellType: 'bash', cwd: '/repo',
  fontSize: 13, theme: 'dark', fontFamily: 'mono',
}

beforeEach(() => {
  createTerminal.mockReset().mockResolvedValue({ success: true })
  ;(window as any).termpolis = { ...((window as any).termpolis ?? {}), createTerminal }
  useTerminalStore.setState({
    terminals: [{ ...base } as any],
    activeTerminalId: 't1',
    viewMode: 'split',
    paneTree: { type: 'terminal', terminalId: 't1' },
  } as any)
})

afterEach(() => { vi.restoreAllMocks() })

describe('splitPane', () => {
  it('starts a shell like the pane and puts it beside it (Split Right = vertical)', async () => {
    const newId = await splitPane('t1', 'vertical')
    expect(newId).toEqual(expect.any(String))
    expect(createTerminal).toHaveBeenCalledWith(newId, 'bash', '/repo')
    const s = useTerminalStore.getState()
    expect(s.terminals.find(t => t.id === newId)).toMatchObject({
      name: 'Shell (split)', shellType: 'bash', cwd: '/repo', fontSize: 13, theme: 'dark', fontFamily: 'mono',
    })
    expect(s.paneTree).toMatchObject({ type: 'split', direction: 'vertical' })
    expect(s.activeTerminalId).toBe(newId)
  })

  it('returns null and changes nothing for an unknown pane', async () => {
    expect(await splitPane('nope', 'horizontal')).toBeNull()
    expect(createTerminal).not.toHaveBeenCalled()
    expect(useTerminalStore.getState().terminals).toHaveLength(1)
  })

  it('returns null and adds no pane when the shell fails to start', async () => {
    createTerminal.mockResolvedValue({ success: false, error: 'x' })
    expect(await splitPane('t1', 'horizontal')).toBeNull()
    expect(useTerminalStore.getState().terminals).toHaveLength(1)
    expect(useTerminalStore.getState().paneTree).toEqual({ type: 'terminal', terminalId: 't1' })
  })

  it('treats an empty answer from the shell as a failure', async () => {
    createTerminal.mockResolvedValue(undefined)
    expect(await splitPane('t1', 'vertical')).toBeNull()
  })
})

describe('splitActivePane', () => {
  it('splits the active terminal below (Split Down = horizontal)', async () => {
    const newId = await splitActivePane('horizontal')
    expect(newId).toEqual(expect.any(String))
    expect(useTerminalStore.getState().paneTree).toMatchObject({ type: 'split', direction: 'horizontal' })
  })

  it('switches tabs mode to split view first, so the split shows', async () => {
    useTerminalStore.setState({ viewMode: 'tabs', paneTree: null } as any)
    const newId = await splitActivePane('vertical')
    const s = useTerminalStore.getState()
    expect(s.viewMode).toBe('split')
    expect(s.paneTree).toMatchObject({
      type: 'split',
      children: [{ terminalId: 't1' }, { terminalId: newId }],
    })
  })

  it('does nothing with no active terminal', async () => {
    useTerminalStore.setState({ activeTerminalId: null } as any)
    expect(await splitActivePane('vertical')).toBeNull()
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('does nothing when the active id names no terminal', async () => {
    useTerminalStore.setState({ activeTerminalId: 'gone', viewMode: 'tabs' } as any)
    expect(await splitActivePane('vertical')).toBeNull()
    expect(useTerminalStore.getState().viewMode).toBe('tabs')
  })
})

describe('exportActivePane / toggleRecordingActivePane', () => {
  it.each([
    ['termpolis:export-terminal', exportActivePane],
    ['termpolis:toggle-recording', toggleRecordingActivePane],
  ] as const)('sends %s to the active pane', (eventName, fn) => {
    const seen: unknown[] = []
    const onEvent = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener(eventName, onEvent)
    try {
      expect(fn()).toBe(true)
    } finally {
      window.removeEventListener(eventName, onEvent)
    }
    expect(seen).toEqual(['t1'])
  })

  it.each([exportActivePane, toggleRecordingActivePane])('sends nothing with no active terminal', (fn) => {
    useTerminalStore.setState({ activeTerminalId: null } as any)
    const spy = vi.spyOn(window, 'dispatchEvent')
    expect(fn()).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})
