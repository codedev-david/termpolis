import { describe, it, expect, vi } from 'vitest'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import {
  createIntroGate,
  markUpdateRestart,
  clearUpdateRestart,
  isRendererPage,
  UPDATE_RESTART_FILE,
  UPDATE_RESTART_MAX_AGE_MS,
  type IntroGateDeps,
} from '../../src/main/launchIntro'

const NOW = 1_800_000_000_000
const MARKER = join('/ud', UPDATE_RESTART_FILE)

function make(over: Partial<IntroGateDeps> & { stored?: string | Error } = {}) {
  const { stored, ...rest } = over
  const deps: IntroGateDeps = {
    userData: '/ud',
    env: {},
    now: () => NOW,
    readFile: vi.fn(async (): Promise<string> => {
      if (stored instanceof Error) throw stored
      if (stored === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return stored
    }),
    removeFile: vi.fn(async () => {}),
    ...rest,
  }
  return { deps, gate: createIntroGate(deps) }
}

async function decided(over: Parameters<typeof make>[0] = {}) {
  const m = make(over)
  await m.gate.start()
  return m
}

describe('createIntroGate', () => {
  it('plays on the first claim of a normal start, and never again in the same process', async () => {
    const { gate, deps } = await decided()
    expect([gate.claim(), gate.claim(), gate.claim()]).toEqual([true, false, false])
    expect(deps.readFile).toHaveBeenCalledWith(MARKER)
    expect(deps.removeFile).not.toHaveBeenCalled()
  })

  it('answers false, and still uses up the claim, when asked before the decision is ready', async () => {
    let release!: (text: string) => void
    const { gate } = make({ readFile: () => new Promise<string>((r) => { release = r }) })
    const started = gate.start()
    expect(gate.claim()).toBe(false)
    release('garbage')
    await started
    expect(gate.claim()).toBe(false)
  })

  it('answers false when start was never called', () => {
    expect(make().gate.claim()).toBe(false)
  })

  it('reads the marker once, however often start is called', async () => {
    const { gate, deps } = make()
    const a = gate.start()
    const b = gate.start()
    expect(a).toBe(b)
    await a
    expect(deps.readFile).toHaveBeenCalledTimes(1)
  })

  it('skips the restart an update asked for, and deletes the marker so the next start plays', async () => {
    const { gate, deps } = await decided({ stored: String(NOW - 30_000) })
    expect(gate.claim()).toBe(false)
    expect(deps.removeFile).toHaveBeenCalledWith(MARKER)
    expect(deps.removeFile).toHaveBeenCalledTimes(1)
  })

  it('skips at the freshness limit, and plays past it or with a marker from the future', async () => {
    expect((await decided({ stored: String(NOW - UPDATE_RESTART_MAX_AGE_MS) })).gate.claim()).toBe(false)
    expect((await decided({ stored: `${NOW}\n` })).gate.claim()).toBe(false)
    const stale = await decided({ stored: String(NOW - UPDATE_RESTART_MAX_AGE_MS - 1) })
    expect(stale.gate.claim()).toBe(true)
    expect(stale.deps.removeFile).toHaveBeenCalledWith(MARKER)
    expect((await decided({ stored: String(NOW + 1) })).gate.claim()).toBe(true)
    expect(UPDATE_RESTART_MAX_AGE_MS).toBe(10 * 60_000)
  })

  it('plays when the marker is garbage or empty, and deletes it all the same', async () => {
    for (const stored of ['', 'yes', '12abc', '-5', '1.5']) {
      const { gate, deps } = await decided({ stored })
      expect(gate.claim()).toBe(true)
      expect(deps.removeFile).toHaveBeenCalledWith(MARKER)
    }
  })

  it('plays when the marker cannot be read (fail open)', async () => {
    const { gate, deps } = await decided({ stored: Object.assign(new Error('EACCES'), { code: 'EACCES' }) })
    expect(gate.claim()).toBe(true)
    expect(deps.removeFile).not.toHaveBeenCalled()
  })

  it('still skips when the marker cannot be deleted, whether the delete rejects or throws', async () => {
    const rejects = await decided({ stored: String(NOW), removeFile: vi.fn(async () => { throw new Error('EROFS') }) })
    expect(rejects.gate.claim()).toBe(false)
    const throws = await decided({ stored: String(NOW), removeFile: vi.fn(() => { throw new Error('EROFS') }) })
    expect(throws.gate.claim()).toBe(false)
  })

  it('stays off in e2e unless the test asks, and then touches no file', async () => {
    const off = await decided({ env: { NODE_ENV: 'test' }, stored: 'garbage' })
    expect(off.gate.claim()).toBe(false)
    expect(off.deps.readFile).not.toHaveBeenCalled()
    expect((await decided({ env: { NODE_ENV: 'test', TERMPOLIS_TEST_LAUNCH_INTRO: '1' } })).gate.claim()).toBe(true)
    expect((await decided({ env: { TERMPOLIS_TEST_LAUNCH_INTRO: '1' } })).gate.claim()).toBe(true)
  })

  it('honours the marker under test too, so e2e can check the update restart', async () => {
    const env = { NODE_ENV: 'test', TERMPOLIS_TEST_LAUNCH_INTRO: '1' }
    expect((await decided({ env, stored: String(NOW) })).gate.claim()).toBe(false)
  })
})

describe('markUpdateRestart and clearUpdateRestart', () => {
  it('writes the time now to the marker in userData', () => {
    const write = vi.fn(async () => {})
    markUpdateRestart('/ud', write, () => NOW)
    expect(write).toHaveBeenCalledWith(MARKER, String(NOW))
  })

  it('defaults to the wall clock', () => {
    const write = vi.fn()
    const before = Date.now()
    markUpdateRestart('/ud', write)
    const at = Number(write.mock.calls[0][1])
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(Date.now())
  })

  it('never throws into the update, whether the write throws or rejects', async () => {
    expect(() => markUpdateRestart('/ud', () => { throw new Error('EROFS') }, () => NOW)).not.toThrow()
    const seen: unknown[] = []
    const onRejection = (r: unknown) => { seen.push(r) }
    process.on('unhandledRejection', onRejection)
    try {
      markUpdateRestart('/ud', () => Promise.reject(new Error('EROFS')), () => NOW)
      clearUpdateRestart('/ud', () => Promise.reject(new Error('EROFS')))
      await new Promise((r) => setImmediate(r))
    } finally {
      process.off('unhandledRejection', onRejection)
    }
    expect(seen).toEqual([])
    expect(() => clearUpdateRestart('/ud', () => { throw new Error('EROFS') })).not.toThrow()
  })

  it('clears by writing an empty marker, which the next start reads as "play"', async () => {
    const write = vi.fn()
    clearUpdateRestart('/ud', write)
    expect(write).toHaveBeenCalledWith(MARKER, '')
    expect((await decided({ stored: write.mock.calls[0][1] as string })).gate.claim()).toBe(true)
  })

  it('round-trips: a marker written now makes the next start skip', async () => {
    const write = vi.fn()
    markUpdateRestart('/ud', write, () => NOW - 1000)
    expect((await decided({ stored: write.mock.calls[0][1] as string })).gate.claim()).toBe(false)
  })
})

describe('isRendererPage', () => {
  const indexFile = resolve('/opt/termpolis/resources/app.asar/out/renderer/index.html')
  const packaged = pathToFileURL(indexFile).href

  it("accepts the packaged renderer's own index file, with or without a hash or query", () => {
    expect(isRendererPage(packaged, { indexFile, platform: 'linux' })).toBe(true)
    expect(isRendererPage(`${packaged}#/settings`, { indexFile, platform: 'linux' })).toBe(true)
    expect(isRendererPage(`${packaged}?x=1`, { indexFile, platform: 'linux' })).toBe(true)
  })

  it('compares file paths without case on Windows only', () => {
    const upper = packaged.replace('termpolis', 'TERMPOLIS')
    expect(isRendererPage(upper, { indexFile, platform: 'win32' })).toBe(true)
    expect(isRendererPage(upper, { indexFile, platform: 'linux' })).toBe(false)
  })

  it('refuses any other file, a remote file URL, about:blank, an empty or a broken URL', () => {
    const other = pathToFileURL(resolve('/tmp/index.html')).href
    expect(isRendererPage(other, { indexFile, platform: 'linux' })).toBe(false)
    expect(isRendererPage('file://evil-host/share/index.html', { indexFile, platform: 'win32' })).toBe(false)
    // An encoded slash is no path on any platform: fileURLToPath refuses it.
    expect(isRendererPage('file:///opt/a%2Fb/index.html', { indexFile, platform: 'linux' })).toBe(false)
    expect(isRendererPage('about:blank', { indexFile, platform: 'linux' })).toBe(false)
    expect(isRendererPage('', { indexFile, platform: 'linux' })).toBe(false)
    expect(isRendererPage('not a url', { indexFile, platform: 'linux' })).toBe(false)
    expect(isRendererPage('https://example.com/', { indexFile, platform: 'linux' })).toBe(false)
  })

  it('accepts the dev server page, and only it, when a dev URL is set', () => {
    const dev = { devUrl: 'http://localhost:5173', indexFile, platform: 'linux' as const }
    expect(isRendererPage('http://localhost:5173/', dev)).toBe(true)
    expect(isRendererPage('http://localhost:5173/index.html', dev)).toBe(true)
    expect(isRendererPage('http://localhost:5173/#/x', dev)).toBe(true)
    expect(isRendererPage('http://localhost:5174/', dev)).toBe(false)
    expect(isRendererPage('http://localhost:5173/other.html', dev)).toBe(false)
    expect(isRendererPage('about:blank', dev)).toBe(false)
    expect(isRendererPage(packaged, dev)).toBe(false)
    expect(isRendererPage('http://localhost:5173/', { ...dev, devUrl: 'not a url' })).toBe(false)
    const sub = { ...dev, devUrl: 'http://127.0.0.1:5173/app/' }
    expect(isRendererPage('http://127.0.0.1:5173/app', sub)).toBe(true)
    expect(isRendererPage('http://127.0.0.1:5173/app/index.html', sub)).toBe(true)
  })
})
