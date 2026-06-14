import { renderHook, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  useAutoCodeIndex,
  autoIndexRepo,
  isAutoIndexEnabled,
  setAutoIndexEnabled,
  _resetAutoIndexedRoots,
  resweepOpenRepos,
  startRepoResweep,
  REPO_RESWEEP_INTERVAL_MS,
} from '../../src/renderer/src/hooks/useAutoCodeIndex'

const KEY = 'termpolis.memory.autoIndexEverything'

function mockApi(overrides: Record<string, unknown> = {}) {
  ;(window as any).termpolis = {
    gitFindRoot: vi.fn(async (_cwd: string) => ({ success: true, data: '/repo/root' })),
    memoryIngestCode: vi.fn(async () => ({
      success: true,
      data: { filesScanned: 1, filesSkipped: 0, chunksWritten: 1, chunksSkipped: 0 },
    })),
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
  _resetAutoIndexedRoots()
  mockApi()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('isAutoIndexEnabled / setAutoIndexEnabled', () => {
  it('defaults ON when unset', () => {
    expect(isAutoIndexEnabled()).toBe(true)
  })

  it('is OFF only when explicitly set to "0"', () => {
    setAutoIndexEnabled(false)
    expect(localStorage.getItem(KEY)).toBe('0')
    expect(isAutoIndexEnabled()).toBe(false)
    setAutoIndexEnabled(true)
    expect(localStorage.getItem(KEY)).toBe('1')
    expect(isAutoIndexEnabled()).toBe(true)
  })

  it('treats a localStorage read failure as ON (default)', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(isAutoIndexEnabled()).toBe(true)
    spy.mockRestore()
  })

  it('swallows a localStorage write failure', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => setAutoIndexEnabled(false)).not.toThrow()
    spy.mockRestore()
  })
})

describe('autoIndexRepo', () => {
  it('resolves the Git root for the cwd and indexes that root when enabled', async () => {
    const ok = await autoIndexRepo('/repo/root/sub/dir')
    expect(ok).toBe(true)
    const api = (window as any).termpolis
    expect(api.gitFindRoot).toHaveBeenCalledWith('/repo/root/sub/dir')
    expect(api.memoryIngestCode).toHaveBeenCalledWith('/repo/root')
  })

  it('indexes a given repo root only once per session', async () => {
    await autoIndexRepo('/a') // gitFindRoot → /repo/root
    await autoIndexRepo('/b') // resolves to the same root → skipped
    expect((window as any).termpolis.memoryIngestCode).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the setting is OFF', async () => {
    setAutoIndexEnabled(false)
    expect(await autoIndexRepo('/repo/root')).toBe(false)
    expect((window as any).termpolis.memoryIngestCode).not.toHaveBeenCalled()
  })

  it('does nothing for a non-Git directory (no root) and does not cache the miss', async () => {
    mockApi({ gitFindRoot: vi.fn(async () => ({ success: true, data: null })) })
    expect(await autoIndexRepo('/not/a/repo')).toBe(false)
    expect(await autoIndexRepo('/not/a/repo')).toBe(false)
    // Re-tries each time (miss not cached), and never indexes.
    expect((window as any).termpolis.gitFindRoot).toHaveBeenCalledTimes(2)
    expect((window as any).termpolis.memoryIngestCode).not.toHaveBeenCalled()
  })

  it('does nothing when gitFindRoot is unsuccessful', async () => {
    mockApi({ gitFindRoot: vi.fn(async () => ({ success: false })) })
    expect(await autoIndexRepo('/x')).toBe(false)
  })

  it('returns false (and never calls the bridge) when cwd is empty', async () => {
    expect(await autoIndexRepo('')).toBe(false)
    expect((window as any).termpolis.gitFindRoot).not.toHaveBeenCalled()
  })

  it('returns false when the bridge API is unavailable', async () => {
    ;(window as any).termpolis = undefined
    expect(await autoIndexRepo('/x')).toBe(false)
  })

  it('swallows errors and never throws', async () => {
    mockApi({
      gitFindRoot: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    expect(await autoIndexRepo('/x')).toBe(false)
  })
})

describe('useAutoCodeIndex', () => {
  it('indexes when cwd is set, and only re-resolves when cwd changes', async () => {
    const api = (window as any).termpolis
    const { rerender } = renderHook(({ cwd }) => useAutoCodeIndex(cwd), {
      initialProps: { cwd: '' },
    })
    // Empty cwd → nothing.
    expect(api.gitFindRoot).not.toHaveBeenCalled()

    rerender({ cwd: '/repo/root' })
    await waitFor(() => expect(api.gitFindRoot).toHaveBeenCalledTimes(1))
    expect(api.memoryIngestCode).toHaveBeenCalledWith('/repo/root')

    // Same cwd on re-render → no new resolve.
    rerender({ cwd: '/repo/root' })
    await Promise.resolve()
    expect(api.gitFindRoot).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the setting is OFF', async () => {
    setAutoIndexEnabled(false)
    renderHook(() => useAutoCodeIndex('/repo/root'))
    await Promise.resolve()
    await Promise.resolve()
    expect((window as any).termpolis.memoryIngestCode).not.toHaveBeenCalled()
  })
})

describe('resweepOpenRepos', () => {
  it('re-indexes the distinct Git roots of the open cwds (dedupes shared roots)', async () => {
    const api = (window as any).termpolis
    api.gitFindRoot = vi.fn(async (cwd: string) => ({
      success: true,
      data: cwd.startsWith('/repoA') ? '/repoA' : '/repoB',
    }))
    const n = await resweepOpenRepos(() => ['/repoA/x', '/repoA/y', '/repoB'])
    expect(n).toBe(2)
    expect(api.memoryIngestCode).toHaveBeenCalledTimes(2)
    expect(api.memoryIngestCode).toHaveBeenCalledWith('/repoA')
    expect(api.memoryIngestCode).toHaveBeenCalledWith('/repoB')
  })

  it('returns 0 and indexes nothing when the setting is OFF', async () => {
    setAutoIndexEnabled(false)
    expect(await resweepOpenRepos(() => ['/repo/root'])).toBe(0)
    expect((window as any).termpolis.memoryIngestCode).not.toHaveBeenCalled()
  })

  it('returns 0 when the bridge API is unavailable', async () => {
    ;(window as any).termpolis = undefined
    expect(await resweepOpenRepos(() => ['/x'])).toBe(0)
  })

  it('skips empty and non-repo cwds but keeps sweeping the rest', async () => {
    const api = (window as any).termpolis
    api.gitFindRoot = vi.fn(async (cwd: string) =>
      cwd === '/good' ? { success: true, data: '/good' } : { success: true, data: null })
    const n = await resweepOpenRepos(() => ['', '/nope', '/good'])
    expect(n).toBe(1)
    expect(api.memoryIngestCode).toHaveBeenCalledTimes(1)
    expect(api.memoryIngestCode).toHaveBeenCalledWith('/good')
  })

  it('keeps sweeping when gitFindRoot throws for one cwd', async () => {
    const api = (window as any).termpolis
    api.gitFindRoot = vi.fn(async (cwd: string) => {
      if (cwd === '/boom') throw new Error('boom')
      return { success: true, data: '/ok' }
    })
    const n = await resweepOpenRepos(() => ['/boom', '/ok/sub'])
    expect(n).toBe(1)
    expect(api.memoryIngestCode).toHaveBeenCalledWith('/ok')
  })
})

describe('startRepoResweep', () => {
  it('re-sweeps on each interval and stops once disposed', async () => {
    vi.useFakeTimers()
    try {
      const api = (window as any).termpolis
      const stop = startRepoResweep(() => ['/repo/root'], 1000)
      expect(api.gitFindRoot).not.toHaveBeenCalled() // nothing fires on start
      await vi.advanceTimersByTimeAsync(1000)
      expect(api.memoryIngestCode).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(api.memoryIngestCode).toHaveBeenCalledTimes(2) // re-sweeps each interval
      stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(api.memoryIngestCode).toHaveBeenCalledTimes(2) // no more after dispose
    } finally {
      vi.useRealTimers()
    }
  })

  it('defaults to a 15-minute interval', () => {
    expect(REPO_RESWEEP_INTERVAL_MS).toBe(15 * 60_000)
  })
})
