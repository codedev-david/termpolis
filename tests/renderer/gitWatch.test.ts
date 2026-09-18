// gitWatch — the renderer half of "watch the repo instead of polling it"
// (src/renderer/src/lib/gitWatch.ts).
//
// Main pushes one event per repo ROOT. Panels subscribe with whatever cwd they happen to be sitting
// in, which is normally a subdirectory of that root — so the match is by path prefix, and getting
// that prefix wrong fails in one of two silent ways: a terminal in `repo/src` that never repaints,
// or `/repository` repainting on every change in `/repo`.
//
// The other half is bookkeeping. Every watch main opens is a file handle it holds until told
// otherwise, and a renderer that forgets to say `gitUnwatch` leaks one for the life of the app —
// including the awkward case where the panel unmounts while the round trip is still in the air.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { watchRepoChanges, resetGitWatches } from '../../src/renderer/src/lib/gitWatch'

type TreeCb = (data: { root: string }) => void

let treeListeners: TreeCb[] = []
let gitWatch: ReturnType<typeof vi.fn>
let gitUnwatch: ReturnType<typeof vi.fn>
let onGitTreeChanged: ReturnType<typeof vi.fn>
let bridgeUnsubscribes: number

/** Push a change for `root`, as main's watcher does. */
function emit(root: string): void {
  for (const cb of [...treeListeners]) cb({ root })
}

function installBridge(watchImpl?: (cwd: string) => Promise<unknown>): void {
  treeListeners = []
  bridgeUnsubscribes = 0
  gitWatch = vi.fn(watchImpl ?? (async (cwd: string) => ({ success: true, data: cwd })))
  gitUnwatch = vi.fn(async () => ({ success: true, data: null }))
  onGitTreeChanged = vi.fn((cb: TreeCb) => {
    treeListeners.push(cb)
    return () => {
      bridgeUnsubscribes++
      treeListeners = treeListeners.filter((x) => x !== cb)
    }
  })
  ;(window as unknown as { termpolis: unknown }).termpolis = { gitWatch, gitUnwatch, onGitTreeChanged }
}

beforeEach(() => {
  installBridge()
})

afterEach(() => {
  resetGitWatches()
  delete (window as unknown as { termpolis?: unknown }).termpolis
})

describe('subscribing', () => {
  it('asks main to watch the directory, once, and calls back on a change', () => {
    const seen = vi.fn()
    watchRepoChanges('/repo', seen)
    expect(gitWatch).toHaveBeenCalledExactlyOnceWith('/repo')
    emit('/repo')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('does not open a second watch for a directory already watched', () => {
    const a = vi.fn()
    const b = vi.fn()
    watchRepoChanges('/repo', a)
    watchRepoChanges('/repo', b)
    expect(gitWatch).toHaveBeenCalledTimes(1)
    emit('/repo')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('subscribes to the push channel exactly once no matter how many panels watch', () => {
    watchRepoChanges('/a', vi.fn())
    watchRepoChanges('/b', vi.fn())
    watchRepoChanges('/c', vi.fn())
    expect(onGitTreeChanged).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for an empty cwd', () => {
    const unsub = watchRepoChanges('', vi.fn())
    expect(gitWatch).not.toHaveBeenCalled()
    expect(() => unsub()).not.toThrow()
  })

  it('is a no-op — not a crash — in a host with no bridge yet', () => {
    // The pre-preload first paint, and every unit test that renders a panel without a bridge.
    delete (window as unknown as { termpolis?: unknown }).termpolis
    const unsub = watchRepoChanges('/repo', vi.fn())
    expect(() => unsub()).not.toThrow()
  })
})

describe('matching a change to a subscriber', () => {
  it('fires for the root itself', () => {
    const seen = vi.fn()
    watchRepoChanges('/repo', seen)
    emit('/repo')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('fires for a terminal sitting DEEP inside the repo', () => {
    const seen = vi.fn()
    watchRepoChanges('/repo/src/main/lib', seen)
    emit('/repo')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('does not fire for a sibling whose path merely starts the same', () => {
    // `/repository` starts with `/repo`. A naive startsWith would repaint half the app on every
    // keystroke in an unrelated project.
    const seen = vi.fn()
    watchRepoChanges('/repository/src', seen)
    emit('/repo')
    expect(seen).not.toHaveBeenCalled()
  })

  it('does not fire for an unrelated repo', () => {
    const seen = vi.fn()
    watchRepoChanges('/other', seen)
    emit('/repo')
    expect(seen).not.toHaveBeenCalled()
  })

  it('does not fire for the PARENT of the changed root', () => {
    const seen = vi.fn()
    watchRepoChanges('/', seen)
    emit('/repo/nested')
    expect(seen).not.toHaveBeenCalled()
  })

  it('matches across the two spellings Windows uses for one directory', () => {
    // git hands back forward slashes even on Windows, while the terminal's cwd carries backslashes.
    const seen = vi.fn()
    watchRepoChanges('C:\\Users\\d\\repo\\src', seen)
    emit('C:/Users/d/repo')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('matches case-insensitively, which is the same directory on Windows', () => {
    const seen = vi.fn()
    watchRepoChanges('C:/Users/D/Repo/src', seen)
    emit('c:/users/d/repo')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('ignores an event with no root rather than fanning it out to everyone', () => {
    const seen = vi.fn()
    watchRepoChanges('/repo', seen)
    emit('')
    emit(null as unknown as string)
    expect(seen).not.toHaveBeenCalled()
  })

  it('fires every panel on the repo', () => {
    const root = vi.fn()
    const deep = vi.fn()
    const other = vi.fn()
    watchRepoChanges('/repo', root)
    watchRepoChanges('/repo/src', deep)
    watchRepoChanges('/elsewhere', other)
    emit('/repo')
    expect(root).toHaveBeenCalledTimes(1)
    expect(deep).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
  })

  it('does not let one throwing listener starve the rest', () => {
    const bad = vi.fn(() => { throw new Error('unmounted mid-flight') })
    const good = vi.fn()
    watchRepoChanges('/repo', bad)
    watchRepoChanges('/repo', good)
    expect(() => emit('/repo')).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('does not call a listener that an earlier one just removed', () => {
    // Panels unmount each other: closing a terminal tears down its git dot, and that teardown runs
    // inside the very callback the change pushed. Calling a listener whose component is already
    // gone is a setState-after-unmount.
    const b = vi.fn()
    let dropB: () => void = () => {}
    const a = vi.fn(() => dropB())
    watchRepoChanges('/repo', a)
    dropB = watchRepoChanges('/repo', b)
    emit('/repo')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it('lets a listener unsubscribe from inside its own callback', () => {
    // React cleanup routinely does exactly this, and iterating the live Set would either skip the
    // next listener or throw.
    const other = vi.fn()
    let unsub: () => void = () => {}
    const selfRemoving = vi.fn(() => unsub())
    unsub = watchRepoChanges('/repo', selfRemoving)
    watchRepoChanges('/repo', other)
    expect(() => emit('/repo')).not.toThrow()
    expect(other).toHaveBeenCalledTimes(1)
    emit('/repo')
    expect(selfRemoving).toHaveBeenCalledTimes(1)
    expect(other).toHaveBeenCalledTimes(2)
  })
})

describe('unsubscribing', () => {
  it('keeps the watch open while another panel still holds it', () => {
    const a = vi.fn()
    const b = vi.fn()
    const dropA = watchRepoChanges('/repo', a)
    watchRepoChanges('/repo', b)
    dropA()
    expect(gitUnwatch).not.toHaveBeenCalled()
    emit('/repo')
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('tells main to close the handle when the last panel leaves', () => {
    const drop = watchRepoChanges('/repo', vi.fn())
    drop()
    expect(gitUnwatch).toHaveBeenCalledExactlyOnceWith('/repo')
  })

  it('is idempotent — a double unsubscribe does not close the handle twice', () => {
    const drop = watchRepoChanges('/repo', vi.fn())
    drop()
    drop()
    expect(gitUnwatch).toHaveBeenCalledTimes(1)
  })

  it('detaches from the push channel once nothing is watched, and re-attaches later', () => {
    const dropA = watchRepoChanges('/a', vi.fn())
    const dropB = watchRepoChanges('/b', vi.fn())
    dropA()
    expect(bridgeUnsubscribes).toBe(0)
    dropB()
    expect(bridgeUnsubscribes).toBe(1)

    const seen = vi.fn()
    watchRepoChanges('/a', seen)
    expect(onGitTreeChanged).toHaveBeenCalledTimes(2)
    emit('/a')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('closes a watch that main opened AFTER the panel had already gone', () => {
    // The leak this exists to prevent: unmount lands between `gitWatch(cwd)` and its reply, so the
    // handle main opens has nobody left to close it.
    let settle!: (v: unknown) => void
    installBridge(() => new Promise((r) => { settle = r }))
    const drop = watchRepoChanges('/repo', vi.fn())
    drop()
    expect(gitUnwatch).toHaveBeenCalledTimes(1)

    settle({ success: true, data: '/repo' })
    return Promise.resolve().then(() => {
      expect(gitUnwatch).toHaveBeenCalledTimes(2)
      expect(gitUnwatch).toHaveBeenLastCalledWith('/repo')
    })
  })

  it('swallows a failed watch request — the slow poll still covers that repo', async () => {
    installBridge(() => Promise.reject(new Error('not a repository')))
    const seen = vi.fn()
    expect(() => watchRepoChanges('/repo', seen)).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    // Still subscribed to the channel, so a change main DOES see still repaints.
    emit('/repo')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('tolerates a success reply that carries no root', async () => {
    installBridge(async () => ({ success: true }))
    const seen = vi.fn()
    watchRepoChanges('/repo', seen)
    await Promise.resolve()
    emit('/repo')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('tolerates a watch request that reports failure without throwing', async () => {
    installBridge(async () => ({ success: false, error: 'not a repository' }))
    const seen = vi.fn()
    watchRepoChanges('/repo', seen)
    await Promise.resolve()
    emit('/repo')
    expect(seen).toHaveBeenCalledTimes(1)
  })
})

describe('resetGitWatches', () => {
  it('closes every open watch and detaches the channel', () => {
    watchRepoChanges('/a', vi.fn())
    watchRepoChanges('/b', vi.fn())
    resetGitWatches()
    expect(gitUnwatch.mock.calls.map((c) => c[0]).sort()).toEqual(['/a', '/b'])
    expect(bridgeUnsubscribes).toBe(1)
  })

  it('is safe with nothing watched, and with no bridge at all', () => {
    expect(() => resetGitWatches()).not.toThrow()
    delete (window as unknown as { termpolis?: unknown }).termpolis
    expect(() => resetGitWatches()).not.toThrow()
  })
})
