// rendererLogBridge.ts
//
// Forwards the RENDERER's console into the same app log the main process writes, so
// the viewer (Ctrl+Shift+O) shows one story instead of half of one. Half the
// interesting failures in this app happen on this side -- a component that threw
// during render, an IPC call that came back `success: false`, an xterm addon that
// refused to load -- and in a packaged build none of it is reachable: there is no
// devtools window to open.
//
// Deliberately thin. The console methods are wrapped, the original is always called
// first with the original arguments (so a dev build behaves exactly as before), and
// the forward is fire-and-forget over an ipcRenderer.send. Nothing here can throw
// into the caller: a logger that can break a render is worse than no logger.
import type { AppLogLevel } from '../../../shared/appLog'

/** The console methods mirrored. `trace`/`dir`/`table` stay local -- their value is
 *  the live console's formatting, which does not survive a string. */
const CAPTURED: readonly AppLogLevel[] = ['debug', 'info', 'log', 'warn', 'error']

export type ConsoleLike = Record<AppLogLevel, (...args: unknown[]) => void>

/** Flatten console arguments to one string. Errors keep their stack -- the single
 *  most useful thing in a renderer log -- and an unserialisable value degrades rather
 *  than throwing. Kept here rather than shared because main formats its own args in
 *  the main process; this side has to produce a string BEFORE it crosses IPC (a
 *  structured-clone of an arbitrary console argument can itself throw). */
export function stringifyConsoleArgs(args: readonly unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`
      if (a === null) return 'null'
      if (a === undefined) return 'undefined'
      if (typeof a === 'object') {
        try { return JSON.stringify(a) } catch { return String(a) }
      }
      return String(a)
    })
    .join(' ')
}

export interface LogBridgeTargets {
  /** Where uncaught errors and rejections are observed. Injected so a test can pass a
   *  stub instead of jsdom's window. */
  errorSource?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null
}

/**
 * Mirror a console (and, if given, a window's uncaught errors) into the app log.
 * Returns an uninstall function that restores every method it replaced.
 */
export function installRendererLogBridge(
  target: ConsoleLike,
  send: (level: AppLogLevel, message: string) => void,
  opts: LogBridgeTargets = {},
): () => void {
  const originals = new Map<AppLogLevel, (...args: unknown[]) => void>()
  for (const level of CAPTURED) {
    const original = target[level]
    if (typeof original !== 'function') continue
    originals.set(level, original)
    target[level] = (...args: unknown[]) => {
      original.apply(target, args)
      try { send(level, stringifyConsoleArgs(args)) } catch { /* logging never breaks a render */ }
    }
  }

  const src = opts.errorSource
  const onError = (e: Event) => {
    const ev = e as ErrorEvent
    try { send('error', `uncaught: ${ev.message || 'unknown'} (${ev.filename || '?'}:${ev.lineno ?? 0})`) } catch { /* ignore */ }
  }
  const onRejection = (e: Event) => {
    const ev = e as PromiseRejectionEvent
    try { send('error', `unhandled rejection: ${stringifyConsoleArgs([ev.reason])}`) } catch { /* ignore */ }
  }
  if (src) {
    src.addEventListener('error', onError)
    src.addEventListener('unhandledrejection', onRejection)
  }

  return () => {
    for (const [level, original] of originals) target[level] = original
    if (src) {
      src.removeEventListener('error', onError)
      src.removeEventListener('unhandledrejection', onRejection)
    }
  }
}
