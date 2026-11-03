/**
 * Report an error that was caught on purpose (so the thing that failed could be contained) without
 * hiding it from crash reporting.
 *
 * `reportError` is the browser's own "treat this as uncaught" hook: it reaches window.onerror, which is
 * where the renderer's crash reporter listens, exactly as the throw would have if nothing had caught it.
 * Without it (a test host, an old runtime) the console is the next best place. Never throws: a reporter
 * that can fail is not allowed to break the thing it reports on.
 */
export function reportFailure(error: unknown, what: string): void {
  try {
    const report = (globalThis as { reportError?: (e: unknown) => void }).reportError
    if (typeof report === 'function') report(error)
    else console.error(`[${what}]`, error)
  } catch {
    // reporting must never throw
  }
}
