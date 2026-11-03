// A watcher is looked for on the thread pool, which takes a moment. If its terminal is detached (closed, or the agent
// changed) in that moment, the watcher it was about to register belongs to nothing and must not outlive it: no tail
// left polling a transcript for a terminal that is gone. Counters: how many handles were stopped, how many registered.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const H = vi.hoisted(() => ({
  stop: vi.fn(),
  resolvers: [] as Array<() => void>,
}))

function handleFor(terminalId: string) {
  return { terminalId, sessionFile: '/sessions/s.jsonl', stop: H.stop, settled: async () => {} }
}
vi.mock('../../src/main/transcriptWatchers/codexWatcher', () => ({
  attachCodexWatcher: vi.fn((terminalId: string) => new Promise((resolve) => { H.resolvers.push(() => resolve(handleFor(terminalId))) })),
}))
vi.mock('../../src/main/transcriptWatchers/geminiWatcher', () => ({
  attachGeminiWatcher: vi.fn(async (terminalId: string) => handleFor(terminalId)),
}))
vi.mock('../../src/main/transcriptWatchers/claudeCodeWatcher', () => ({
  attachClaudeCodeWatcher: vi.fn(async () => null),
  attachClaudeSessionWatcher: vi.fn(() => null),
}))

import { attachWatcher, detachWatchers, detachAll, getActiveWatcherCount, _resetForTests } from '../../src/main/transcriptWatchers'

beforeEach(() => {
  _resetForTests()
  H.stop.mockClear()
  H.resolvers.length = 0
})

describe('attachWatcher while the terminal is being detached', () => {
  it('registers a watcher nobody cancelled, and detaching the terminal stops it', async () => {
    const pending = attachWatcher('t1', '/work', 'codex')
    H.resolvers.shift()?.()
    const handle = await pending
    expect(handle).not.toBeNull()
    expect(getActiveWatcherCount()).toBe(1)
    detachWatchers('t1')
    expect(H.stop).toHaveBeenCalledTimes(1)
    expect(getActiveWatcherCount()).toBe(0)
  })

  it('a terminal detached while its watcher was being found gets none: the late watcher is stopped, not registered', async () => {
    const pending = attachWatcher('t1', '/work', 'codex')
    detachWatchers('t1') // closed (or the agent changed) while the transcript was still being looked for
    H.resolvers.shift()?.()
    expect(await pending).toBeNull()
    expect(H.stop).toHaveBeenCalledTimes(1)
    expect(getActiveWatcherCount()).toBe(0)
  })

  it('detachAll() during the look cancels every attach in flight, and later attaches work again', async () => {
    const a = attachWatcher('t1', '/work', 'codex')
    const b = attachWatcher('t2', '/work', 'codex')
    detachAll()
    H.resolvers.splice(0).forEach((r) => r())
    expect(await a).toBeNull()
    expect(await b).toBeNull()
    expect(H.stop).toHaveBeenCalledTimes(2)
    expect(getActiveWatcherCount()).toBe(0)
    const again = attachWatcher('t1', '/work', 'gemini') // a fresh ask after the detach is not cancelled by it
    expect(await again).not.toBeNull()
    expect(getActiveWatcherCount()).toBe(1)
  })

  it('detaching ANOTHER terminal does not cancel this one', async () => {
    const pending = attachWatcher('t1', '/work', 'codex')
    detachWatchers('t2')
    H.resolvers.shift()?.()
    expect(await pending).not.toBeNull()
    expect(H.stop).not.toHaveBeenCalled()
    expect(getActiveWatcherCount()).toBe(1)
  })

  it('refuses a missing terminal id or folder, and an unknown agent', async () => {
    expect(await attachWatcher('', '/work', 'codex')).toBeNull()
    expect(await attachWatcher('t1', '', 'codex')).toBeNull()
    expect(await attachWatcher('t1', '/work', 'nope' as never)).toBeNull()
    expect(getActiveWatcherCount()).toBe(0)
  })
})
