// Centralized clipboard access for the renderer.
//
// WHY THIS EXISTS: `navigator.clipboard` is focus/permission-gated in Electron —
// it silently REJECTS when called from a button `onClick`, because by then focus
// has left the document. That is the documented root cause of "copy/paste does
// nothing" across the app (the terminal context menu hit it; v1.11.79/v1.12.0
// fixed the terminal but left these helpers/components on the broken API). The
// main-process `clipboard` module (reached via IPC) has NO focus/permission gate,
// so EVERY renderer copy/paste must go through here.
//
// Safe to call from anywhere: optional-chained + try/catch, so it no-ops cleanly
// in non-Electron/test contexts instead of throwing.

/** Copy plain text to the OS clipboard. Returns true on success. */
export async function copyText(text: string): Promise<boolean> {
  try {
    const r = await window.termpolis?.clipboardWriteText?.(text)
    return !!r?.success
  } catch {
    return false
  }
}

/** Read the OS clipboard as text. Returns '' if unavailable. */
export async function readClipboardText(): Promise<string> {
  try {
    const r = await window.termpolis?.clipboardReadText?.()
    return r?.success ? (r.data ?? '') : ''
  } catch {
    return ''
  }
}
