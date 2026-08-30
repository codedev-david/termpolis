import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { waitForShellReady, afterCommandDelay, LEGACY_COMMAND_AT_MS } from '../../src/renderer/src/lib/launchSequence'

/**
 * The launch flow used to wait a blind 4,000 ms for the shell, then type a no-op newline, then wait
 * another 500 ms before typing the agent command — 4.5 seconds of doing nothing, whether the shell
 * was ready in 300 ms or not. On a real launch that was measured as half of the ~9 s it took Claude
 * to start responding.
 *
 * `waitForShellReady` replaces the blind sleep with the thing it was standing in for: the shell has
 * emitted something, and has then gone quiet. The old 4,000 ms survives as a CEILING, so this can
 * only ever fire EARLIER than the previous behaviour, never later — that ceiling is what makes a
 * heuristic ("looks idle") safe to rely on, since there is no shell-integration marker (no OSC 633)
 * anywhere in this app to give a deterministic answer.
 */
describe('waitForShellReady', () => {
  let listeners: Array<(id: string, data: string) => void>
  let unsubscribes: number

  const subscribe = (cb: (id: string, data: string) => void) => {
    listeners.push(cb)
    return () => { unsubscribes++ }
  }
  const emit = (id: string, data: string) => listeners.forEach((l) => l(id, data))
  const opts = (over: Partial<Parameters<typeof waitForShellReady>[0]> = {}) => ({
    terminalId: 't1', subscribe, quietMs: 150, ceilingMs: 4000, ...over,
  })

  beforeEach(() => { listeners = []; unsubscribes = 0; vi.useFakeTimers() })
  afterEach(() => vi.useRealTimers())

  it('resolves as soon as the shell has spoken and then gone quiet', async () => {
    const p = waitForShellReady(opts())
    await vi.advanceTimersByTimeAsync(300)
    emit('t1', 'user@host MINGW64 ~/repo\n$ ')
    await vi.advanceTimersByTimeAsync(150)
    await expect(p).resolves.toBe('quiet')
  })

  it('does not resolve while the shell is still talking — the quiet window restarts', async () => {
    const p = waitForShellReady(opts())
    let done = false
    void p.then(() => { done = true })
    emit('t1', 'first')
    await vi.advanceTimersByTimeAsync(100) // not yet quiet
    emit('t1', 'still initialising')
    await vi.advanceTimersByTimeAsync(100) // window restarted, still not quiet
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(50)
    await expect(p).resolves.toBe('quiet')
  })

  it('ignores output from OTHER terminals — a busy neighbour must not release this launch', async () => {
    const p = waitForShellReady(opts())
    let done = false
    void p.then(() => { done = true })
    emit('other', 'noise from a different pty')
    await vi.advanceTimersByTimeAsync(400)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(4000)
    await expect(p).resolves.toBe('ceiling')
  })

  it('falls back to the ceiling when the shell never says anything', async () => {
    const p = waitForShellReady(opts())
    await vi.advanceTimersByTimeAsync(4000)
    await expect(p).resolves.toBe('ceiling')
  })

  it('falls back to the ceiling when the shell never stops talking', async () => {
    const p = waitForShellReady(opts())
    for (let t = 0; t < 4000; t += 100) {
      emit('t1', 'chatty')
      await vi.advanceTimersByTimeAsync(100)
    }
    await expect(p).resolves.toBe('ceiling')
  })

  it('never waits longer than the ceiling, even mid-quiet-window', async () => {
    // Output at 3,950 ms would arm a 150 ms quiet timer expiring at 4,100 ms — past the ceiling.
    const p = waitForShellReady(opts())
    await vi.advanceTimersByTimeAsync(3950)
    emit('t1', 'late prompt')
    await vi.advanceTimersByTimeAsync(50)
    await expect(p).resolves.toBe('ceiling')
  })

  it('unsubscribes on the quiet path — a launch must not leak a PTY listener', async () => {
    const p = waitForShellReady(opts())
    emit('t1', 'prompt')
    await vi.advanceTimersByTimeAsync(150)
    await p
    expect(unsubscribes).toBe(1)
  })

  it('unsubscribes on the ceiling path too', async () => {
    const p = waitForShellReady(opts())
    await vi.advanceTimersByTimeAsync(4000)
    await p
    expect(unsubscribes).toBe(1)
  })

  it('settles exactly once — late output after the ceiling changes nothing', async () => {
    const p = waitForShellReady(opts())
    await vi.advanceTimersByTimeAsync(4000)
    await expect(p).resolves.toBe('ceiling')
    emit('t1', 'output that arrives after we gave up')
    await vi.advanceTimersByTimeAsync(1000)
    expect(unsubscribes).toBe(1) // no second teardown
  })

  it('ignores output that arrives after settling, even from a bridge that never unsubscribed', async () => {
    // Belt and braces: unsubscribe is best-effort on someone else's bridge, so the listener must
    // also refuse to act once the result is decided.
    const p = waitForShellReady(opts({ subscribe: (cb) => { listeners.push(cb); return () => {} } }))
    await vi.advanceTimersByTimeAsync(4000)
    await expect(p).resolves.toBe('ceiling')
    emit('t1', 'a late prompt from a leaky listener')
    await vi.advanceTimersByTimeAsync(1000) // would have armed a quiet timer if it were still live
    await expect(p).resolves.toBe('ceiling') // still the original answer
  })

  it('falls back to a plain ceiling wait when the app exposes no output stream', async () => {
    // Fail-open: launching is more important than being clever. If there is nothing to subscribe
    // to, behave exactly like the blind wait this replaced.
    const p = waitForShellReady(opts({
      subscribe: () => { throw new Error('no ipc bridge in this context') },
    }))
    await vi.advanceTimersByTimeAsync(4000)
    await expect(p).resolves.toBe('ceiling')
  })
})

/**
 * The downstream timers (the agent's trust-prompt confirmation, the launch spinner) used to be
 * measured from the moment the user clicked launch, and were tuned against a command that always
 * landed at 4,500 ms. Typing the command earlier without re-basing them would silently widen the
 * gap between the command and its trust confirmation from 4.5 s to as much as 8.5 s — a much larger
 * window in which a blind Enter can land somewhere it was never meant to.
 *
 * So they are re-expressed as delays measured from the COMMAND, preserving the exact gap they had.
 */
describe('afterCommandDelay', () => {
  it('preserves the gap the timer used to have from the command', () => {
    expect(afterCommandDelay(9000)).toBe(9000 - LEGACY_COMMAND_AT_MS) // trust Enter: still 4.5s after
    expect(afterCommandDelay(8000)).toBe(8000 - LEGACY_COMMAND_AT_MS) // spinner dismiss
    expect(afterCommandDelay(15000)).toBe(15000 - LEGACY_COMMAND_AT_MS) // gemini spinner dismiss
  })

  it('never returns a negative delay for a timer that used to fire before the command', () => {
    expect(afterCommandDelay(0)).toBe(0)
    expect(afterCommandDelay(LEGACY_COMMAND_AT_MS - 1)).toBe(0)
  })

  it('pins the legacy command time the re-basing is derived from', () => {
    expect(LEGACY_COMMAND_AT_MS).toBe(4500) // setTimeout(4000) + nested setTimeout(500)
  })
})

describe('launch timing constants', () => {
  it('keeps the ceiling at the blind wait it replaces, so the worst case is unchanged', async () => {
    const { SHELL_READY_CEILING_MS, SHELL_QUIET_MS } = await import('../../src/renderer/src/lib/launchSequence')
    expect(SHELL_READY_CEILING_MS).toBe(4000) // the original setTimeout(4000)
    expect(SHELL_QUIET_MS).toBeLessThan(SHELL_READY_CEILING_MS) // or the quiet path could never win
  })
})
