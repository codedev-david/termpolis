// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { copyText, readClipboardText } from '../../src/renderer/src/lib/clipboard'

afterEach(() => { delete (window as any).termpolis })

// The whole point of this module: copy/paste must go through the native Electron
// clipboard (window.termpolis IPC), NEVER navigator.clipboard — which is
// focus/permission-gated and silently rejects from a button/menu click. These
// tests pin that, plus the IpcResponse unwrapping and the never-throw fallback.
describe('lib/clipboard (native Electron IPC, not navigator.clipboard)', () => {
  it('copyText writes via window.termpolis.clipboardWriteText and reports success', async () => {
    const clipboardWriteText = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).termpolis = { clipboardWriteText }
    expect(await copyText('hello world')).toBe(true)
    expect(clipboardWriteText).toHaveBeenCalledWith('hello world')
  })

  it('copyText does NOT touch navigator.clipboard', async () => {
    const navWrite = vi.fn()
    ;(navigator as any).clipboard = { writeText: navWrite }
    ;(window as any).termpolis = { clipboardWriteText: vi.fn().mockResolvedValue({ success: true }) }
    await copyText('x')
    expect(navWrite).not.toHaveBeenCalled()
  })

  it('copyText returns false (never throws) when the bridge is missing', async () => {
    delete (window as any).termpolis
    await expect(copyText('x')).resolves.toBe(false)
  })

  it('copyText returns false when the IPC reports failure', async () => {
    ;(window as any).termpolis = { clipboardWriteText: vi.fn().mockResolvedValue({ success: false }) }
    expect(await copyText('x')).toBe(false)
  })

  it('readClipboardText unwraps the IpcResponse data', async () => {
    ;(window as any).termpolis = { clipboardReadText: vi.fn().mockResolvedValue({ success: true, data: 'pasted text' }) }
    expect(await readClipboardText()).toBe('pasted text')
  })

  it('readClipboardText returns "" (never throws) on rejection or absence', async () => {
    ;(window as any).termpolis = { clipboardReadText: vi.fn().mockRejectedValue(new Error('denied')) }
    expect(await readClipboardText()).toBe('')
    delete (window as any).termpolis
    expect(await readClipboardText()).toBe('')
  })

  // ---- never-throw fallbacks, one arm at a time ----
  // The bridge can fail in three distinct ways and each must degrade silently:
  // the whole preload object is absent, the object is there but the method is
  // not (version skew between renderer and preload), or the IPC call itself
  // rejects. Only the third reaches the catch block.

  it('copyText returns false when the IPC call REJECTS (catch arm)', async () => {
    const clipboardWriteText = vi.fn().mockRejectedValue(new Error('clipboard is busy'))
    ;(window as any).termpolis = { clipboardWriteText }
    await expect(copyText('boom')).resolves.toBe(false)
    expect(clipboardWriteText).toHaveBeenCalledWith('boom')
  })

  it('copyText returns false when the preload object exists but has no clipboardWriteText', async () => {
    ;(window as any).termpolis = { somethingElse: vi.fn() } // version skew: method missing
    await expect(copyText('x')).resolves.toBe(false)
  })

  it('copyText returns false when the IPC resolves with no response envelope', async () => {
    ;(window as any).termpolis = { clipboardWriteText: vi.fn().mockResolvedValue(undefined) }
    expect(await copyText('x')).toBe(false)
  })

  it('readClipboardText returns "" when the preload object exists but has no clipboardReadText', async () => {
    ;(window as any).termpolis = { somethingElse: vi.fn() }
    expect(await readClipboardText()).toBe('')
  })

  it('readClipboardText returns "" when the IPC succeeds but carries no data field', async () => {
    // success:true with `data` omitted — the ?? fallback, not the error path.
    ;(window as any).termpolis = { clipboardReadText: vi.fn().mockResolvedValue({ success: true }) }
    expect(await readClipboardText()).toBe('')
  })

  it('readClipboardText ignores data when the IPC reports failure', async () => {
    ;(window as any).termpolis = {
      clipboardReadText: vi.fn().mockResolvedValue({ success: false, data: 'must not be used' }),
    }
    expect(await readClipboardText()).toBe('')
  })

  it('readClipboardText returns "" for a genuinely empty clipboard without treating it as an error', async () => {
    const clipboardReadText = vi.fn().mockResolvedValue({ success: true, data: '' })
    ;(window as any).termpolis = { clipboardReadText }
    expect(await readClipboardText()).toBe('')
    expect(clipboardReadText).toHaveBeenCalledTimes(1)
  })
})
