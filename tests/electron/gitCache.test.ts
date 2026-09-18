// gitCache — one answer per (repo, question) per 1.5 s (src/main/gitCache.ts).
//
// The cache is a correctness hazard as much as a speed win, so the tests are weighted accordingly.
// A cache serving a stale `git status` after a commit is a rail that is WRONG — worse than the slow
// rail it replaced — which is why invalidation, not hit rate, is what most of this file checks.
//
// Two subtleties carry the whole design:
//   * the cached value is the PROMISE, not the string. That is what makes concurrent callers
//     single-flight into one process rather than N; a value cache would still spawn N.
//   * invalidation matches by prefix in BOTH directions, because one repo is asked about from
//     several directories at once — the rail from `repo`, a terminal from `repo/src/main`.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const H = vi.hoisted(() => ({ safeGitAsync: vi.fn() }))

vi.mock('../../src/main/gitCommand', () => ({
  safeGitAsync: H.safeGitAsync,
}))

import {
  cachedGit,
  invalidateGitCache,
  GIT_CACHE_TTL_MS,
  _setGitCacheClock,
  _gitCacheSizeForTests,
} from '../../src/main/gitCache'

let now = 0
const at = (t: number): void => { now = t }

beforeEach(() => {
  H.safeGitAsync.mockReset().mockResolvedValue('')
  invalidateGitCache()
  now = 1_000_000
  _setGitCacheClock(() => now)
})

afterEach(() => {
  invalidateGitCache()
  _setGitCacheClock(null)
})

describe('sharing an answer', () => {
  it('runs git once for a repeated question inside the window', async () => {
    H.safeGitAsync.mockResolvedValue(' M src/a.ts')
    const a = await cachedGit(['status', '--porcelain'], { cwd: '/repo' })
    at(now + GIT_CACHE_TTL_MS - 1)
    const b = await cachedGit(['status', '--porcelain'], { cwd: '/repo' })
    expect(b).toBe(a)
    expect(H.safeGitAsync).toHaveBeenCalledTimes(1)
  })

  it('hands concurrent callers the SAME in-flight promise, not a second process', async () => {
    // This is the single-flight property, and it only holds because the promise itself is cached.
    // Ten terminals repainting in the same tick is the ordinary case, not the edge case.
    let release!: (v: string) => void
    H.safeGitAsync.mockReturnValue(new Promise<string>((r) => { release = r }))
    const calls = Array.from({ length: 10 }, () => cachedGit(['status'], { cwd: '/repo' }))
    expect(H.safeGitAsync).toHaveBeenCalledTimes(1)
    release('counted once')
    expect(await Promise.all(calls)).toEqual(Array(10).fill('counted once'))
  })

  it('asks again once the window has passed', async () => {
    await cachedGit(['status'], { cwd: '/repo' })
    at(now + GIT_CACHE_TTL_MS)
    await cachedGit(['status'], { cwd: '/repo' })
    expect(H.safeGitAsync).toHaveBeenCalledTimes(2)
  })

  it('honours a caller-supplied window — 0 means never reuse', async () => {
    await cachedGit(['status'], { cwd: '/repo' }, 0)
    await cachedGit(['status'], { cwd: '/repo' }, 0)
    expect(H.safeGitAsync).toHaveBeenCalledTimes(2)
  })

  it('honours a longer one too', async () => {
    await cachedGit(['log'], { cwd: '/repo' }, 60_000)
    at(now + 30_000)
    await cachedGit(['log'], { cwd: '/repo' }, 60_000)
    expect(H.safeGitAsync).toHaveBeenCalledTimes(1)
  })

  it('keys on the arguments — a different question is a different answer', async () => {
    await cachedGit(['status'], { cwd: '/repo' })
    await cachedGit(['rev-parse', 'HEAD'], { cwd: '/repo' })
    expect(H.safeGitAsync).toHaveBeenCalledTimes(2)
    expect(_gitCacheSizeForTests()).toBe(2)
  })

  it('keys on the cwd — two repos never share an answer', async () => {
    await cachedGit(['status'], { cwd: '/repo-a' })
    await cachedGit(['status'], { cwd: '/repo-b' })
    expect(H.safeGitAsync).toHaveBeenCalledTimes(2)
  })

  it('passes the options straight through to git', async () => {
    await cachedGit(['status'], { cwd: '/repo', timeout: 4000 })
    expect(H.safeGitAsync).toHaveBeenCalledWith(['status'], { cwd: '/repo', timeout: 4000 })
  })
})

describe('failures', () => {
  it('rejects the caller AND drops the entry, so the next call retries', async () => {
    // Caching a failure would turn one transient hiccup — a lock file, a disk stall — into 1.5 s of
    // "this is not a repository" for every panel that asks.
    H.safeGitAsync.mockRejectedValueOnce(new Error('index.lock exists'))
    await expect(cachedGit(['status'], { cwd: '/repo' })).rejects.toThrow('index.lock exists')
    expect(_gitCacheSizeForTests()).toBe(0)

    H.safeGitAsync.mockResolvedValue('recovered')
    await expect(cachedGit(['status'], { cwd: '/repo' })).resolves.toBe('recovered')
  })

  it('does not evict a NEWER entry when an old failure finally lands', async () => {
    // A slow failure resolving after the entry was already replaced must not delete the replacement,
    // or a routine timeout would silently punch a hole in the cache.
    let fail!: (e: Error) => void
    H.safeGitAsync.mockReturnValueOnce(new Promise<string>((_r, rej) => { fail = rej }))
    const first = cachedGit(['status'], { cwd: '/repo' })
    const firstSettled = expect(first).rejects.toThrow('late')

    at(now + GIT_CACHE_TTL_MS)
    H.safeGitAsync.mockResolvedValue('fresh')
    await cachedGit(['status'], { cwd: '/repo' })
    expect(_gitCacheSizeForTests()).toBe(1)

    fail(new Error('late'))
    await firstSettled
    expect(_gitCacheSizeForTests()).toBe(1)
    await expect(cachedGit(['status'], { cwd: '/repo' })).resolves.toBe('fresh')
    expect(H.safeGitAsync).toHaveBeenCalledTimes(2)
  })
})

describe('invalidation', () => {
  const seed = async (cwd: string): Promise<void> => { await cachedGit(['status'], { cwd }) }

  it('with no argument forgets everything', async () => {
    await seed('/a')
    await seed('/b')
    expect(_gitCacheSizeForTests()).toBe(2)
    invalidateGitCache()
    expect(_gitCacheSizeForTests()).toBe(0)
  })

  it('forgets the exact directory', async () => {
    await seed('/repo')
    invalidateGitCache('/repo')
    await seed('/repo')
    expect(H.safeGitAsync).toHaveBeenCalledTimes(2)
  })

  it('forgets SUBdirectories — a change at the root invalidates the terminal sitting in src/', async () => {
    await seed('/repo/src/main')
    invalidateGitCache('/repo')
    expect(_gitCacheSizeForTests()).toBe(0)
  })

  it('forgets PARENT directories — a change in src/ invalidates the rail sitting at the root', async () => {
    // The reverse direction, and the one that is easy to leave out. Main invalidates with whatever
    // cwd the write happened in, which is routinely deeper than the cwd the rail asked from.
    await seed('/repo')
    invalidateGitCache('/repo/src/main')
    expect(_gitCacheSizeForTests()).toBe(0)
  })

  it('leaves an unrelated repo alone, including one whose name merely starts the same', async () => {
    await seed('/repo2')
    await seed('/other')
    invalidateGitCache('/repo')
    expect(_gitCacheSizeForTests()).toBe(2)
  })

  it('matches across slash spellings, which Windows produces both of for one directory', async () => {
    await seed('C:\\Users\\d\\repo')
    invalidateGitCache('C:/Users/d/repo')
    expect(_gitCacheSizeForTests()).toBe(0)
  })

  it('ignores a trailing separator', async () => {
    await seed('/repo/')
    invalidateGitCache('/repo')
    expect(_gitCacheSizeForTests()).toBe(0)
  })

  it.runIf(process.platform === 'win32')('matches case-insensitively on Windows', async () => {
    await seed('C:\\Users\\D\\Repo')
    invalidateGitCache('c:\\users\\d\\repo')
    expect(_gitCacheSizeForTests()).toBe(0)
  })
})

describe('the clock seam', () => {
  it('falls back to the real clock when cleared', async () => {
    _setGitCacheClock(null)
    await cachedGit(['status'], { cwd: '/repo' })
    await cachedGit(['status'], { cwd: '/repo' })
    // Two calls inside the same millisecond-ish: real Date.now, so still one process.
    expect(H.safeGitAsync).toHaveBeenCalledTimes(1)
  })
})
