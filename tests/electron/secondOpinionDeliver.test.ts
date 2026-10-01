// @vitest-environment node
import { EventEmitter } from 'events'
import type { SpawnOptions } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createSecondOpinionDeliver,
  STOP_SETTLE_MS,
  type AgentChild,
  type SecondOpinionDeliverDeps,
} from '../../src/main/secondOpinionDeliver'
import { TREE_KILL_GRACE_MS } from '../../src/main/processTree'
import { DELIVER_GRACE_MS, PROMPT_TOKEN, SECOND_OPINION_TIMEOUT_MS, runSecondOpinion } from '../../src/main/secondOpinion'
import { runHeadless } from '../../src/main/headlessExec'

// Every process here is a fake: spawn, kill, and the temp-file writes are all injected. What
// the fakes can't prove (that the OS really ends the tree) is in the .process test next door.

class FakeChild extends EventEmitter {
  pid: number | undefined
  stdout: EventEmitter | null = new EventEmitter()
  stderr: EventEmitter | null = new EventEmitter()
  constructor(pid: number | undefined) {
    super()
    this.pid = pid
  }
}

function harness(over: Partial<SecondOpinionDeliverDeps> = {}) {
  const children: FakeChild[] = []
  const spawn = vi.fn((_cmd: string, _args: string[], _opts: SpawnOptions): AgentChild => {
    const child = new FakeChild(4242 + children.length)
    children.push(child)
    return child
  })
  const killTree = vi.fn()
  const writeFile = vi.fn()
  const unlink = vi.fn()
  const runs = createSecondOpinionDeliver({
    tempDir: () => 'C:\\Temp',
    env: () => ({ PATH: '/usr/bin', KEEP: '1' }),
    platform: 'linux',
    spawn,
    killTree,
    writeFile,
    unlink,
    ...over,
  })
  return { ...runs, spawn, killTree, writeFile, unlink, children }
}

/** A promise's settled state, readable synchronously between timer steps. */
function track<T>(p: Promise<T>): { done: () => boolean } {
  let done = false
  p.then(() => { done = true }, () => { done = true })
  return { done: () => done }
}

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try { return fn() } finally { Object.defineProperty(process, 'platform', original) }
}

const ARGS = ['-p', PROMPT_TOKEN]

afterEach(() => {
  vi.useRealTimers()
})

describe('secondOpinionDeliver: spawning', () => {
  it('on POSIX execs the binary directly, as a process-group leader, with no spawn timeout', async () => {
    const h = harness()
    const result = h.deliver('claude', ARGS, 'the prompt', PROMPT_TOKEN, { timeoutMs: 90_000 })
    expect(h.spawn).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = h.spawn.mock.calls[0]
    expect(cmd).toBe('claude')
    expect(args).toEqual(['-p', 'the prompt'])
    expect(opts).toMatchObject({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    // spawn's own `timeout` ends only the direct child, so the deliver must not rely on it.
    expect(opts).not.toHaveProperty('timeout')
    expect(opts.env).toEqual({ PATH: '/usr/bin', KEEP: '1' })
    // The temp-file dance is Windows-only.
    expect(h.writeFile).not.toHaveBeenCalled()

    const c = h.children[0]
    c.stdout!.emit('data', Buffer.from('Looks '))
    c.stdout!.emit('data', 'good.')
    c.stderr!.emit('data', Buffer.from('a warning'))
    c.emit('exit', 0)
    c.emit('close', 0)
    expect(await result).toEqual({ stdout: 'Looks good.', stderr: 'a warning', code: 0 })
    expect(h.killTree).not.toHaveBeenCalled()
    expect(h.unlink).not.toHaveBeenCalled()
  })

  it('on Windows passes the prompt through a temp file, never the command line, and removes it', async () => {
    const base = { PATH: 'C:\\bin' }
    const h = harness({ platform: 'win32', env: () => base })
    const result = h.deliver('claude', ARGS, 'the "prompt"', PROMPT_TOKEN, { timeoutMs: 90_000 })
    expect(h.writeFile).toHaveBeenCalledTimes(1)
    const [file, data] = h.writeFile.mock.calls[0] as [string, string]
    expect(file).toMatch(/^C:\\Temp[\\/]termpolis-so-\d+-\d+\.txt$/)
    expect(data).toBe('the "prompt"')

    const [cmd, args, opts] = h.spawn.mock.calls[0]
    expect(cmd).toBe('powershell.exe')
    expect(args.join(' ')).not.toContain('the "prompt"')
    expect(opts.env).toEqual({ PATH: 'C:\\bin', TP_SO_FILE: file })
    // A detached Windows child gets its own console; the tree is found through taskkill instead.
    expect(opts.detached).toBe(false)
    // The caller's environment object is copied, never written to.
    expect(base).toEqual({ PATH: 'C:\\bin' })

    h.children[0].emit('close', 0)
    await result
    expect(h.unlink).toHaveBeenCalledWith(file)
  })

  it('writes and removes the prompt file on the real file system by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-so-deliver-'))
    try {
      const h = harness({ platform: 'win32', tempDir: () => dir, writeFile: undefined, unlink: undefined })
      const result = h.deliver('claude', ARGS, 'the prompt', PROMPT_TOKEN, { timeoutMs: 1000 })
      const file = h.spawn.mock.calls[0][2].env!.TP_SO_FILE!
      expect(readFileSync(file, 'utf8')).toBe('the prompt')
      h.children[0].emit('close', 0)
      await result
      expect(existsSync(file)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not fail a finished run over a prompt file it could not remove', async () => {
    const h = harness({ platform: 'win32', unlink: vi.fn(() => { throw new Error('EBUSY') }) })
    const result = h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 1000 })
    h.children[0].stdout!.emit('data', 'fine')
    h.children[0].emit('close', 0)
    expect(await result).toEqual({ stdout: 'fine', stderr: '', code: 0 })
  })

  it('refuses the run when the Windows prompt file cannot be written', async () => {
    // The prompt is UNTRUSTED terminal scrape; it never falls back to a command line.
    const h = harness({ platform: 'win32', writeFile: vi.fn(() => { throw new Error('EACCES') }) })
    expect(await h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 1000 })).toEqual({ stdout: '', code: 1 })
    expect(h.spawn).not.toHaveBeenCalled()
    expect(h.unlink).not.toHaveBeenCalled()
  })

  it('reports a spawn that throws as code 1 with the message, and cleans up', async () => {
    const h = harness({ platform: 'win32', spawn: vi.fn(() => { throw new Error('ENOENT claude') }) })
    expect(await h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 1000 }))
      .toEqual({ stdout: '', stderr: 'ENOENT claude', code: 1 })
    expect(h.unlink).toHaveBeenCalledTimes(1)
    // Nothing is left for a quit to stop.
    h.stopAll()
    expect(h.killTree).not.toHaveBeenCalled()
  })

  it('still settles when spawn throws something that is not an Error', async () => {
    const h = harness({ spawn: vi.fn(() => { throw null }) })
    const r = await h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 1000 })
    expect(r).toEqual({ stdout: '', stderr: undefined, code: 1 })
  })

  it('reports a null exit code (killed by a signal) as code 1, never as success', async () => {
    const h = harness()
    const result = h.deliver('codex', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 1000 })
    h.children[0].emit('close', null)
    expect(await result).toEqual({ stdout: '', stderr: '', code: 1 })
  })

  it('settles exactly once when the child both errors and closes', async () => {
    const h = harness()
    const result = h.deliver('gemini', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 1000 })
    const c = h.children[0]
    c.stdout!.emit('data', 'ignored')
    c.emit('error', new Error('spawn agy ENOENT'))
    c.emit('close', 0)
    expect(await result).toEqual({ stdout: '', stderr: 'spawn agy ENOENT', code: 1 })
  })

  it('copes with a child that has no output streams', async () => {
    const h = harness({
      spawn: vi.fn((): AgentChild => {
        const c = new FakeChild(9)
        c.stdout = null
        c.stderr = null
        setImmediate(() => c.emit('close', 0))
        return c
      }),
    })
    expect(await h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 1000 })).toEqual({ stdout: '', stderr: '', code: 0 })
  })

  it('reads the platform at call time when none is injected', async () => {
    const h = harness({ platform: undefined })
    const win = withPlatform('win32', () => h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 1000 }))
    const posix = withPlatform('linux', () => h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 1000 }))
    expect(h.spawn.mock.calls.map(([cmd, , opts]) => [cmd, opts.detached])).toEqual([['powershell.exe', false], ['claude', true]])
    h.children.forEach((c) => c.emit('close', 0))
    await Promise.all([win, posix])
  })
})

describe('secondOpinionDeliver: the deadline stops the whole tree', () => {
  it('on POSIX signals the group at the deadline, keeps the output, and says why first', async () => {
    vi.useFakeTimers()
    const h = harness()
    const result = h.deliver('codex', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 90_000 })
    const c = h.children[0]
    c.stdout!.emit('data', 'partial review')
    c.stderr!.emit('data', 'still thinking')
    vi.advanceTimersByTime(89_999)
    expect(h.killTree).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(h.killTree).toHaveBeenCalledWith(4242, { platform: 'linux', sync: false })
    // The tree dies, so its pipes close.
    c.emit('exit', null)
    c.emit('close', null)
    expect(await result).toEqual({
      stdout: 'partial review',
      stderr: 'codex did not finish within 90s and was stopped\nstill thinking',
      code: 1,
    })
  })

  it('on Windows kills the tree from the wrapper while the wrapper is still alive', async () => {
    vi.useFakeTimers()
    const h = harness({ platform: 'win32' })
    const result = h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 5_000 })
    vi.advanceTimersByTime(5_000)
    // taskkill /T walks down from a LIVE root: the wrapper must be the pid, and still running.
    expect(h.killTree).toHaveBeenCalledWith(4242, { platform: 'win32', sync: false })
    // An agent that exits 0 on the kill is still a stopped run, not a review.
    h.children[0].emit('close', 0)
    expect(await result).toEqual({ stdout: '', stderr: 'claude did not finish within 5s and was stopped', code: 1 })
    expect(h.unlink).toHaveBeenCalledTimes(1)
  })

  it('on Windows does not taskkill a wrapper that already exited, and settles anyway', async () => {
    // The wrapper's pid may belong to someone else by now, and /T can't find the tree without it.
    // A grandchild still holding the pipes keeps `close` away, so the run settles on its own.
    vi.useFakeTimers()
    const h = harness({ platform: 'win32' })
    const result = h.deliver('agy', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 10_000 })
    const state = track(result)
    h.children[0].emit('exit', 0)
    vi.advanceTimersByTime(10_000)
    expect(h.killTree).not.toHaveBeenCalled()
    vi.advanceTimersByTime(STOP_SETTLE_MS - 1)
    await Promise.resolve()
    expect(state.done()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await result).toEqual({ stdout: '', stderr: 'agy did not finish within 10s and was stopped', code: 1 })
    expect(h.unlink).toHaveBeenCalledTimes(1)
  })

  it('on POSIX still signals the group after its leader exited', async () => {
    // A process group id is not reused while any member lives, and a member may hold the pipes.
    vi.useFakeTimers()
    const h = harness()
    const result = h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 1_000 })
    h.children[0].emit('exit', 0)
    vi.advanceTimersByTime(1_000)
    expect(h.killTree).toHaveBeenCalledWith(4242, { platform: 'linux', sync: false })
    vi.advanceTimersByTime(STOP_SETTLE_MS)
    expect((await result).code).toBe(1)
  })

  it('honours an injected settle time', async () => {
    vi.useFakeTimers()
    const h = harness({ settleMs: 10 })
    const result = h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 1_000 })
    const state = track(result)
    vi.advanceTimersByTime(1_009)
    await Promise.resolve()
    expect(state.done()).toBe(false)
    vi.advanceTimersByTime(1)
    expect((await result).stderr).toBe('claude did not finish within 1s and was stopped')
  })

  it('still settles when the kill itself throws', async () => {
    vi.useFakeTimers()
    const h = harness({ killTree: vi.fn(() => { throw new Error('taskkill exploded') }) })
    const result = h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 1_000 })
    vi.advanceTimersByTime(1_000 + STOP_SETTLE_MS)
    expect((await result).code).toBe(1)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('sets no deadline for timeoutMs=%s', async (timeoutMs) => {
    vi.useFakeTimers()
    const h = harness()
    const result = h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs })
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(24 * 60 * 60_000)
    expect(h.killTree).not.toHaveBeenCalled()
    h.children[0].emit('close', 0)
    expect((await result).code).toBe(0)
  })

  it('clamps a deadline past the timer limit instead of firing it at once', async () => {
    vi.useFakeTimers()
    const h = harness()
    const result = h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 3_000_000_000 })
    vi.advanceTimersByTime(60_000)
    expect(h.killTree).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2_147_483_647 - 60_000)
    expect(h.killTree).toHaveBeenCalledTimes(1)
    h.children[0].emit('close', null)
    expect((await result).stderr).toBe('claude did not finish within 3000000s and was stopped')
  })

  it('clears its deadline once the run finishes normally', async () => {
    vi.useFakeTimers()
    const h = harness()
    const result = h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 90_000 })
    h.children[0].emit('close', 0)
    await result
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(90_000)
    expect(h.killTree).not.toHaveBeenCalled()
  })
})

describe('secondOpinionDeliver: stopAll (app quit)', () => {
  it('stops every live run synchronously, removes the prompt files, and settles them', async () => {
    vi.useFakeTimers()
    const h = harness({ platform: 'win32' })
    const first = h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 90_000 })
    const second = h.deliver('codex', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 90_000 })
    h.children[1].stdout!.emit('data', 'half a review')
    h.stopAll()
    expect(h.killTree.mock.calls).toEqual([
      [4242, { platform: 'win32', sync: true }],
      [4243, { platform: 'win32', sync: true }],
    ])
    // Synchronous: no timer fires again once the app is quitting.
    expect(h.unlink).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    expect(await first).toEqual({ stdout: '', stderr: 'claude was stopped because Termpolis is quitting', code: 1 })
    expect(await second).toEqual({ stdout: 'half a review', stderr: 'codex was stopped because Termpolis is quitting', code: 1 })
    // A late close from the dying tree changes nothing, and a second stopAll has nothing to do.
    h.children[0].emit('close', 0)
    h.killTree.mockClear()
    h.stopAll()
    expect(h.killTree).not.toHaveBeenCalled()
  })

  it('leaves finished runs alone', async () => {
    const h = harness()
    const result = h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 90_000 })
    h.children[0].emit('close', 0)
    await result
    h.stopAll()
    expect(h.killTree).not.toHaveBeenCalled()
  })

  it('leaves alone a run that ends while the quit is stopping another one', async () => {
    // stopAll walks a copy of the list, so it still reaches a run that finished after the walk
    // began. That run's pid is no longer ours to kill.
    let children: FakeChild[] = []
    const killTree = vi.fn((pid: number | undefined) => { if (pid === 4242) children[1].emit('close', 0) })
    const h = harness({ killTree })
    children = h.children
    const first = h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 90_000 })
    const second = h.deliver('codex', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 90_000 })
    h.stopAll()
    expect(killTree.mock.calls).toEqual([[4242, { platform: 'linux', sync: true }]])
    expect((await first).stderr).toBe('claude was stopped because Termpolis is quitting')
    // It ended on its own, so it keeps its own result.
    expect(await second).toEqual({ stdout: '', stderr: '', code: 0 })
  })

  it('on POSIX kills the group at once', () => {
    const h = harness()
    void h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 90_000 })
    h.stopAll()
    expect(h.killTree).toHaveBeenCalledWith(4242, { platform: 'linux', sync: true })
  })

  it('does not taskkill a Windows wrapper that already exited, but still settles the run', async () => {
    const h = harness({ platform: 'win32' })
    const result = h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 90_000 })
    h.children[0].emit('exit', 0)
    h.stopAll()
    expect(h.killTree).not.toHaveBeenCalled()
    expect((await result).code).toBe(1)
  })

  it('keeps the first reason when a quit lands while a timed-out run is settling', async () => {
    vi.useFakeTimers()
    const h = harness()
    const result = h.deliver('claude', ARGS, 'p', PROMPT_TOKEN, { timeoutMs: 5_000 })
    vi.advanceTimersByTime(5_000)
    expect(h.killTree).toHaveBeenLastCalledWith(4242, { platform: 'linux', sync: false })
    h.stopAll()
    // The quit still makes sure the group is dead, synchronously.
    expect(h.killTree).toHaveBeenLastCalledWith(4242, { platform: 'linux', sync: true })
    expect(await result).toEqual({ stdout: '', stderr: 'claude did not finish within 5s and was stopped', code: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('secondOpinionDeliver: defaults and timing', () => {
  it('orders its timers so SIGKILL lands before the run settles, and the run settles before the backstop', () => {
    expect(TREE_KILL_GRACE_MS).toBeLessThan(STOP_SETTLE_MS)
    expect(STOP_SETTLE_MS).toBeLessThan(DELIVER_GRACE_MS)
  })
})

describe('secondOpinionDeliver through its callers', () => {
  it('a Second Opinion that runs out of time reports that it was stopped, not a bare timeout', async () => {
    vi.useFakeTimers()
    const h = harness({ platform: 'win32' })
    const review = runSecondOpinion({ agent: 'claude', content: 'diff' }, h.deliver)
    await Promise.resolve()
    vi.advanceTimersByTime(SECOND_OPINION_TIMEOUT_MS)
    expect(h.killTree).toHaveBeenCalledWith(4242, { platform: 'win32', sync: false })
    h.children[0].emit('close', 1)
    expect(await review).toEqual({ ok: false, error: 'claude did not finish within 90s and was stopped' })
  })

  it('settles before deliverWithDeadline gives up, even when close never comes', async () => {
    vi.useFakeTimers()
    const h = harness({ platform: 'win32' })
    const review = runSecondOpinion({ agent: 'codex', content: 'diff', timeoutMs: 20_000 }, h.deliver)
    await Promise.resolve()
    h.children[0].emit('exit', 0)
    vi.advanceTimersByTime(20_000 + STOP_SETTLE_MS)
    expect(await review).toEqual({ ok: false, error: 'codex did not finish within 20s and was stopped' })
  })

  it('a headless run that is stopped fails, says why, and is not remembered', async () => {
    vi.useFakeTimers()
    const h = harness()
    const remember = vi.fn(async () => undefined)
    const run = runHeadless({ task: 'summarise the repo', agent: 'claude', timeoutMs: 60_000, noPrimer: true, cwd: '/repo' }, { deliver: h.deliver, remember })
    await Promise.resolve()
    const c = h.children[0]
    c.stdout!.emit('data', 'half done')
    vi.advanceTimersByTime(60_000)
    c.emit('close', null)
    const r = await run
    expect(r).toMatchObject({ ok: false, code: 1, output: 'half done', error: 'claude did not finish within 60s and was stopped' })
    expect(remember).not.toHaveBeenCalled()
  })
})
