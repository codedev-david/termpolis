import { describe, it, expect, vi } from 'vitest'
import { asksForScreen, installMediaGuard, SCREEN_REFUSED, type GuardWindow } from '../../src/renderer/src/lib/mediaGuard'

/** A window with its own MediaDevices and Navigator, the way Chromium shapes them. */
function fakeWindow(opts: { webkit?: boolean; unprefixed?: boolean; noDomException?: boolean } = {}) {
  const real = vi.fn(async function (this: unknown, constraints?: MediaStreamConstraints) {
    return { constraints, self: this } as unknown as MediaStream
  })
  class MediaDevices {}
  Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { value: real, writable: true, configurable: true, enumerable: true })
  class Navigator {}
  if (opts.webkit !== false) Object.defineProperty(Navigator.prototype, 'webkitGetUserMedia', { value: vi.fn(), writable: true, configurable: true })
  if (opts.unprefixed) Object.defineProperty(Navigator.prototype, 'getUserMedia', { value: vi.fn(), writable: false, configurable: false })
  const warn = vi.fn()
  const win: GuardWindow = { MediaDevices, Navigator, console: { warn }, ...(opts.noDomException ? {} : { DOMException }) }
  const devices = new MediaDevices() as { getUserMedia(c?: unknown): Promise<MediaStream> }
  const navigator = new Navigator() as { webkitGetUserMedia?: (...a: unknown[]) => void; getUserMedia?: (...a: unknown[]) => void }
  return { win, real, devices, navigator, MediaDevices, Navigator, warn }
}

describe('asksForScreen: a legacy screen source anywhere in the constraints', () => {
  it('finds chromeMediaSource and chromeMediaSourceId wherever Chromium reads them', () => {
    expect(asksForScreen({ audio: true, video: { mandatory: { chromeMediaSource: 'desktop' } } })).toBe(true)
    expect(asksForScreen({ video: { mandatory: { chromeMediaSourceId: 'screen:0:0' } } })).toBe(true)
    expect(asksForScreen({ audio: { mandatory: { chromeMediaSource: 'desktop' } } })).toBe(true)
    expect(asksForScreen({ video: { optional: [{ minWidth: 1 }, { chromeMediaSource: 'screen' }] } })).toBe(true)
    expect(asksForScreen({ video: { chromeMediaSource: 'tab' } })).toBe(true)
    expect(asksForScreen({ video: { advanced: [{ chromeMediaSourceId: 'window:1' }] } })).toBe(true)
  })

  it('passes the microphone and camera constraints the app really sends', () => {
    expect(asksForScreen({ audio: true })).toBe(false)
    expect(asksForScreen({ audio: { deviceId: { exact: 'abc' }, echoCancellation: true, noiseSuppression: false } })).toBe(false)
    expect(asksForScreen({ audio: true, video: { width: { ideal: 640 }, facingMode: 'user' } })).toBe(false)
    expect(asksForScreen(undefined)).toBe(false)
    expect(asksForScreen(null)).toBe(false)
    expect(asksForScreen('audio')).toBe(false)
  })

  it('refuses constraints nested deeper than any real ones (they could hide a source)', () => {
    let deep: Record<string, unknown> = { audio: true }
    for (let i = 0; i < 12; i++) deep = { a: deep }
    expect(asksForScreen(deep)).toBe(true)
  })
})

describe('installMediaGuard: getUserMedia refuses a screen before it leaves the page', () => {
  it('rejects legacy desktop capture with NotAllowedError, even asked for with the microphone', async () => {
    const { win, real, devices, warn } = fakeWindow()
    expect(installMediaGuard(win)).toBe(true)
    const err = await devices.getUserMedia({ audio: true, video: { mandatory: { chromeMediaSource: 'desktop' } } }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DOMException)
    expect((err as DOMException).name).toBe('NotAllowedError')
    expect((err as DOMException).message).toBe(SCREEN_REFUSED)
    expect(real).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[permissions] refused a screen capture asked for through getUserMedia')
  })

  it('passes the microphone through to the real getUserMedia, on the same MediaDevices, as a copy', async () => {
    const { win, real, devices } = fakeWindow()
    installMediaGuard(win)
    const constraints = { audio: { deviceId: { exact: 'mic-1' } } }
    const stream = await devices.getUserMedia(constraints) as unknown as { constraints: unknown; self: unknown }
    expect(real).toHaveBeenCalledTimes(1)
    expect(stream.self).toBe(devices)
    expect(stream.constraints).toEqual(constraints)
    expect(stream.constraints).not.toBe(constraints)
    await devices.getUserMedia()
    expect(real.mock.calls[1][0]).toBeUndefined()
  })

  it('checks what it passes on: a getter cannot show the guard one thing and Chromium another', async () => {
    const { win, real, devices } = fakeWindow()
    installMediaGuard(win)
    let reads = 0
    const video = { get mandatory() { reads++; return reads === 1 ? { chromeMediaSource: 'desktop' } : {} } }
    await expect(devices.getUserMedia({ audio: true, video })).rejects.toThrow(SCREEN_REFUSED)
    expect(real).not.toHaveBeenCalled()
  })

  it('rejects constraints that are not plain data (a function, a proxy)', async () => {
    const { win, real, devices } = fakeWindow()
    installMediaGuard(win)
    await expect(devices.getUserMedia({ audio: true, video: () => undefined } as never)).rejects.toThrow(TypeError)
    expect(real).not.toHaveBeenCalled()
  })

  it('cannot be replaced or removed afterwards', () => {
    const { win, MediaDevices } = fakeWindow()
    installMediaGuard(win)
    const guarded = (MediaDevices.prototype as { getUserMedia: unknown }).getUserMedia
    const desc = Object.getOwnPropertyDescriptor(MediaDevices.prototype, 'getUserMedia')!
    expect(desc.writable).toBe(false)
    expect(desc.configurable).toBe(false)
    expect(() => Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { value: () => undefined })).toThrow(TypeError)
    expect(() => { 'use strict'; (MediaDevices.prototype as { getUserMedia: unknown }).getUserMedia = () => undefined }).toThrow(TypeError)
    expect(() => delete (MediaDevices.prototype as { getUserMedia?: unknown }).getUserMedia).toThrow(TypeError)
    expect((MediaDevices.prototype as { getUserMedia: unknown }).getUserMedia).toBe(guarded)
  })

  it('refuses the prefixed callback-style navigator.webkitGetUserMedia outright', () => {
    const { win, navigator, Navigator } = fakeWindow()
    installMediaGuard(win)
    const onStream = vi.fn()
    const onError = vi.fn()
    navigator.webkitGetUserMedia!({ audio: true }, onStream, onError)
    expect(onStream).not.toHaveBeenCalled()
    expect((onError.mock.calls[0][0] as DOMException).name).toBe('NotAllowedError')
    expect(() => navigator.webkitGetUserMedia!({ audio: true })).not.toThrow()
    expect(Object.getOwnPropertyDescriptor(Navigator.prototype, 'webkitGetUserMedia')!.configurable).toBe(false)
  })

  it('leaves a navigator getUserMedia the browser has already fixed in place, and copes with none', () => {
    const fixed = fakeWindow({ unprefixed: true })
    const before = Object.getOwnPropertyDescriptor(fixed.Navigator.prototype, 'getUserMedia')!.value
    expect(installMediaGuard(fixed.win)).toBe(true)
    expect(fixed.navigator.getUserMedia).toBe(before)
    expect(installMediaGuard(fakeWindow({ webkit: false }).win)).toBe(true)
    const { win } = fakeWindow()
    delete win.Navigator
    expect(installMediaGuard(win)).toBe(true)
  })

  it('falls back to the global DOMException', async () => {
    const { win, devices } = fakeWindow({ noDomException: true })
    installMediaGuard(win)
    const err = await devices.getUserMedia({ video: { chromeMediaSource: 'desktop' } }).catch((e: unknown) => e)
    expect((err as DOMException).name).toBe('NotAllowedError')
  })

  it('does nothing where there is no getUserMedia (an old or headless page)', () => {
    expect(installMediaGuard({})).toBe(false)
    expect(installMediaGuard({ MediaDevices: { prototype: {} } })).toBe(false)
    expect(installMediaGuard({ MediaDevices: { prototype: { getUserMedia: 'no' } } })).toBe(false)
  })
})
