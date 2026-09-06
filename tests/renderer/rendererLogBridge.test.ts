// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import {
  stringifyConsoleArgs,
  installRendererLogBridge,
  type ConsoleLike,
} from '../../src/renderer/src/lib/rendererLogBridge'
import type { AppLogLevel } from '../../src/shared/appLog'

/** A console stand-in. The real global console is never touched by these tests: a
 *  bridge installed on it would keep forwarding after the test that installed it. */
function fakeConsole(): ConsoleLike & { calls: Array<[AppLogLevel, unknown[]]> } {
  const calls: Array<[AppLogLevel, unknown[]]> = []
  const mk = (level: AppLogLevel) => (...args: unknown[]) => { calls.push([level, args]) }
  return { calls, debug: mk('debug'), info: mk('info'), log: mk('log'), warn: mk('warn'), error: mk('error') }
}

/** Stands in for `window`. Recording the exact handler references is the point:
 *  uninstall has to hand `removeEventListener` the same function objects or the
 *  listeners leak, and a leaked listener outlives the bridge it belonged to. */
function fakeErrorSource() {
  const added: Array<[string, EventListenerOrEventListenerObject]> = []
  const removed: Array<[string, EventListenerOrEventListenerObject]> = []
  return {
    added,
    removed,
    addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => { added.push([type, fn]) },
    removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => { removed.push([type, fn]) },
    /** Fire what the browser would fire. Plain objects, not real Events: the handler
     *  only ever reads properties off them, and a real ErrorEvent cannot be built with
     *  a missing `lineno` (jsdom defaults it to 0), which is a branch we must reach. */
    fire(type: string, ev: unknown) {
      for (const [t, fn] of added) if (t === type) (fn as EventListener)(ev as Event)
    },
  }
}

describe('lib/rendererLogBridge - stringifyConsoleArgs', () => {
  it('passes strings through untouched', () => {
    // Console arguments are overwhelmingly strings; quoting or re-encoding them would
    // make every log line in the viewer noisier than the devtools line it replaces.
    expect(stringifyConsoleArgs(['hello world'])).toBe('hello world')
  })

  it('keeps an Error stack - the single most useful thing in a renderer log', () => {
    const err = new Error('kaboom')
    const out = stringifyConsoleArgs([err])
    expect(out).toBe(err.stack)
    expect(out).toContain('kaboom')
  })

  it('falls back to "Name: message" for an Error with no stack', () => {
    // Rejections crossing a worker/IPC boundary arrive as Errors whose stack was lost.
    // Those are exactly the failures worth logging, so they must not render as ''.
    const err = new Error('no stack here')
    err.stack = ''
    expect(stringifyConsoleArgs([err])).toBe('Error: no stack here')
  })

  it('renders null and undefined as the literal words', () => {
    // `String(null)` would work, but the checks come BEFORE the typeof-object branch on
    // purpose: `typeof null === 'object'`, so without them null would go to JSON and
    // print as an ambiguous bare `null` alongside a real object.
    expect(stringifyConsoleArgs([null])).toBe('null')
    expect(stringifyConsoleArgs([undefined])).toBe('undefined')
  })

  it('serialises a plain object as JSON', () => {
    expect(stringifyConsoleArgs([{ id: 7, name: 'pty' }])).toBe('{"id":7,"name":"pty"}')
  })

  it('degrades a circular object via String() instead of throwing', () => {
    // The whole module exists to make failures visible; a logger that throws on a
    // self-referential object (a React fiber, a DOM node, a store slice) would take
    // out the render it was trying to explain.
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular
    expect(() => stringifyConsoleArgs([circular])).not.toThrow()
    expect(stringifyConsoleArgs([circular])).toBe('[object Object]')
  })

  it('stringifies numbers and booleans', () => {
    expect(stringifyConsoleArgs([42])).toBe('42')
    expect(stringifyConsoleArgs([false])).toBe('false')
    expect(stringifyConsoleArgs([Symbol('sym')])).toBe('Symbol(sym)')
  })

  it('joins multiple arguments with a single space, like the console does', () => {
    expect(stringifyConsoleArgs(['pty', 3, { ok: true }, null])).toBe('pty 3 {"ok":true} null')
  })

  it('returns "" for no arguments', () => {
    // `console.log()` is legal and must not produce the string "undefined".
    expect(stringifyConsoleArgs([])).toBe('')
  })
})

describe('lib/rendererLogBridge - installRendererLogBridge', () => {
  it('wraps all five captured console methods', () => {
    const target = fakeConsole()
    const before = { debug: target.debug, info: target.info, log: target.log, warn: target.warn, error: target.error }
    installRendererLogBridge(target, () => {})
    for (const level of ['debug', 'info', 'log', 'warn', 'error'] as const) {
      expect(target[level]).not.toBe(before[level])
    }
  })

  it('calls the original FIRST, with the original unstringified arguments', () => {
    // A dev build must behave exactly as before: devtools keeps its own formatting and
    // its expandable object, which only survives if the raw value reaches the original.
    const order: string[] = []
    const target = fakeConsole()
    const raw = { id: 7, nested: { deep: true } }
    const original = vi.fn(() => { order.push('original') })
    target.log = original
    const send = vi.fn(() => { order.push('send') })

    installRendererLogBridge(target, send)
    target.log('boot', raw)

    expect(order).toEqual(['original', 'send'])
    expect(original).toHaveBeenCalledTimes(1)
    expect(original.mock.calls[0][1]).toBe(raw) // the object itself, not "{"id":7,...}"
    expect(send).toHaveBeenCalledWith('log', 'boot {"id":7,"nested":{"deep":true}}')
  })

  it('applies the original with the console as `this`', () => {
    // Real console methods are not bound; calling one detached throws "Illegal
    // invocation" in Chromium, which would break every log in a packaged build.
    const target = fakeConsole()
    const seenThis: unknown[] = []
    target.warn = function (this: unknown) { seenThis.push(this) }
    installRendererLogBridge(target, () => {})
    target.warn('x')
    expect(seenThis[0]).toBe(target)
  })

  it('forwards (level, stringified message) for every captured level', () => {
    const target = fakeConsole()
    const send = vi.fn()
    installRendererLogBridge(target, send)

    target.debug('d')
    target.info('i')
    target.log('l')
    target.warn('w')
    target.error(new Error('bad'))

    expect(send.mock.calls.map((c) => c[0])).toEqual(['debug', 'info', 'log', 'warn', 'error'])
    expect(send.mock.calls.slice(0, 4).map((c) => c[1])).toEqual(['d', 'i', 'l', 'w'])
    expect(send.mock.calls[4][1]).toContain('bad')
  })

  it('swallows a throwing `send` so logging can never break a render', () => {
    // The forward is fire-and-forget over IPC; if the bridge is gone (window closing,
    // preload not yet wired) the send throws, and a console.log inside a React render
    // must not become a component crash.
    const target = fakeConsole()
    const original = vi.fn()
    target.log = original
    installRendererLogBridge(target, () => { throw new Error('ipc gone') })

    expect(() => target.log('still fine')).not.toThrow()
    expect(original).toHaveBeenCalledWith('still fine')
  })

  it('skips a method the target does not have', () => {
    // Not every console-like object has all five (a stripped worker console, a test
    // double). A missing method must be left alone, not replaced with a wrapper that
    // would call `undefined`.
    const target = fakeConsole()
    delete (target as Partial<ConsoleLike>).debug
    const send = vi.fn()

    expect(() => installRendererLogBridge(target, send)).not.toThrow()
    expect(target.debug).toBeUndefined()

    target.log('present')
    expect(send).toHaveBeenCalledWith('log', 'present')

    // ...and uninstall must not resurrect it as a property either.
    const uninstall = installRendererLogBridge(target, send)
    uninstall()
    expect('debug' in target).toBe(false)
  })

  it('restores every original method on uninstall', () => {
    const target = fakeConsole()
    const before = { debug: target.debug, info: target.info, log: target.log, warn: target.warn, error: target.error }
    const send = vi.fn()
    const uninstall = installRendererLogBridge(target, send)

    uninstall()

    for (const level of ['debug', 'info', 'log', 'warn', 'error'] as const) {
      expect(target[level]).toBe(before[level])
    }
    target.log('after uninstall')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('lib/rendererLogBridge - uncaught errors and rejections', () => {
  it('forwards an uncaught error with message, filename and line', () => {
    const src = fakeErrorSource()
    const send = vi.fn()
    installRendererLogBridge(fakeConsole(), send, { errorSource: src })

    expect(src.added.map((a) => a[0])).toEqual(['error', 'unhandledrejection'])
    src.fire('error', { message: 'x is not a function', filename: 'app.js', lineno: 42 })

    expect(send).toHaveBeenCalledWith('error', 'uncaught: x is not a function (app.js:42)')
  })

  it('falls back to unknown/?/0 when the event carries no detail', () => {
    // Cross-origin script errors arrive scrubbed ("Script error." or nothing at all).
    // The entry is still worth writing - a bare "(:)" would look like a bridge bug.
    const src = fakeErrorSource()
    const send = vi.fn()
    installRendererLogBridge(fakeConsole(), send, { errorSource: src })

    src.fire('error', {})
    expect(send).toHaveBeenCalledWith('error', 'uncaught: unknown (?:0)')

    // Empty strings and a null lineno take the same fallbacks (`||` vs `??`).
    send.mockClear()
    src.fire('error', { message: '', filename: '', lineno: null })
    expect(send).toHaveBeenCalledWith('error', 'uncaught: unknown (?:0)')

    // lineno 0 is a real value, not a missing one, so `??` must keep it.
    send.mockClear()
    src.fire('error', { message: 'boom', filename: 'a.js', lineno: 0 })
    expect(send).toHaveBeenCalledWith('error', 'uncaught: boom (a.js:0)')
  })

  it('forwards an unhandled rejection reason through stringifyConsoleArgs', () => {
    const src = fakeErrorSource()
    const send = vi.fn()
    installRendererLogBridge(fakeConsole(), send, { errorSource: src })

    const reason = new Error('ipc rejected')
    src.fire('unhandledrejection', { reason })
    expect(send).toHaveBeenCalledWith('error', `unhandled rejection: ${reason.stack}`)

    // A non-Error reason (a bare `throw 'nope'` or a rejected value) still formats.
    send.mockClear()
    src.fire('unhandledrejection', { reason: { code: 'EPIPE' } })
    expect(send).toHaveBeenCalledWith('error', 'unhandled rejection: {"code":"EPIPE"}')
  })

  it('swallows a throwing `send` inside both window handlers', () => {
    // These run as event listeners; an exception here surfaces as a SECOND uncaught
    // error, which would re-enter the handler and turn one failure into a loop.
    const src = fakeErrorSource()
    installRendererLogBridge(fakeConsole(), () => { throw new Error('ipc gone') }, { errorSource: src })

    expect(() => src.fire('error', { message: 'm', filename: 'f', lineno: 1 })).not.toThrow()
    expect(() => src.fire('unhandledrejection', { reason: 'r' })).not.toThrow()
  })

  it('removes both listeners on uninstall, with the same handler references', () => {
    const src = fakeErrorSource()
    const uninstall = installRendererLogBridge(fakeConsole(), vi.fn(), { errorSource: src })

    uninstall()

    expect(src.removed).toEqual(src.added)
    expect(src.removed[0][1]).toBe(src.added[0][1])
    expect(src.removed[1][1]).toBe(src.added[1][1])
  })

  it('subscribes to nothing when no errorSource is given', () => {
    // The bridge is also installed in contexts with no window (a worker, a unit test);
    // omitting the option must be inert rather than reaching for a global.
    const target = fakeConsole()
    const send = vi.fn()
    let uninstall!: () => void

    expect(() => { uninstall = installRendererLogBridge(target, send) }).not.toThrow()
    target.log('console still bridged')
    expect(send).toHaveBeenCalledWith('log', 'console still bridged')
    expect(() => uninstall()).not.toThrow()
  })

  it('treats an explicit null errorSource the same as an absent one', () => {
    const target = fakeConsole()
    const uninstall = installRendererLogBridge(target, vi.fn(), { errorSource: null })
    expect(() => uninstall()).not.toThrow()
  })

  it('works against a real Window, not just the stub', () => {
    // The stub proves the logic; this proves the shape - jsdom's addEventListener is
    // the same contract the real preload passes in.
    const send = vi.fn()
    const uninstall = installRendererLogBridge(fakeConsole(), send, { errorSource: window })

    window.dispatchEvent(new ErrorEvent('error', { message: 'render blew up', filename: 'App.tsx', lineno: 9 }))
    expect(send).toHaveBeenCalledWith('error', 'uncaught: render blew up (App.tsx:9)')

    uninstall()
    send.mockClear()
    window.dispatchEvent(new ErrorEvent('error', { message: 'after uninstall', filename: 'App.tsx', lineno: 9 }))
    expect(send).not.toHaveBeenCalled()
  })
})
