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
})
