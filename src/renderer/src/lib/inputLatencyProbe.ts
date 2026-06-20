// Keystroke → echo latency probe. Localizes "the first character I type in a new
// terminal appears late even though the prompt is already showing."
//
// It measures TWO independent legs of the round trip so we can tell WHERE the
// time goes instead of guessing:
//
//   1. echoMs  — keystroke → the echoed bytes arriving back from the PTY. This is
//                the SHELL round trip. Large here ⇒ the shell was slow to echo
//                (e.g. PowerShell PSReadLine initializing prediction/history on
//                the first keystroke). Nothing the renderer does can fix that.
//   2. paintMs — echo bytes arriving → the next animation frame. xterm paints on
//                its own requestAnimationFrame, so a large value here means the
//                renderer's frame was STARVED (the main thread was busy mounting
//                the new terminal). That's the lag the renderer/throttle owns.
//
// The probe always measures (a perf.now() per typed character and one rAF per
// echo — negligible) and reports every sample. The CONSUMER decides whether to
// surface it; TerminalPane only shows a readout when a sample is actually slow,
// so there's no UI noise in the normal fast case. All side-effecting
// dependencies are injectable for unit testing.

export interface InputLatencySample {
  /** Keystroke → echoed bytes returning from the PTY (shell round trip), ms. */
  echoMs: number
  /** Echo arrival → next animation frame (renderer starvation), ms. */
  paintMs: number
  /** Bytes in the echo chunk that satisfied the pending keystroke. */
  echoBytes: number
  /** First echo measured since this terminal opened (the cold-start case). */
  firstEcho: boolean
  /** Time since the terminal opened, ms — first-keystroke lag clusters near 0. */
  sinceOpenMs: number
}

export interface InputLatencyProbe {
  /** Call when the terminal opens, to reset the clock and first-echo flag. */
  markOpen(): void
  /** Call for every keystroke (xterm `onData`). Arms the timer for printable keys. */
  onKeystroke(data: string): void
  /** Call for every output chunk (PTY `onTerminalData`) with the chunk's length. */
  onOutput(byteLen: number): void
}

export interface InputLatencyDeps {
  now?: () => number
  scheduleFrame?: (cb: () => void) => void
  report?: (sample: InputLatencySample) => void
}

export function createInputLatencyProbe(deps: InputLatencyDeps = {}): InputLatencyProbe {
  const now = deps.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : 0))
  const scheduleFrame =
    deps.scheduleFrame ??
    ((cb: () => void) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb)
      else cb()
    })
  const report = deps.report ?? (() => {})

  let pendingTs: number | null = null
  let openTs = 0
  let firstEchoSeen = false

  return {
    markOpen() {
      openTs = now()
      firstEchoSeen = false
      pendingTs = null
    },

    onKeystroke(data: string) {
      // Don't restart the clock if we're still waiting on a prior keystroke's echo.
      if (pendingTs !== null) return
      // Only time a single character the PTY echoes straight back: printables and
      // DEL/backspace (codepoint >= 0x20). Enter ('\r'), Ctrl+keys and arrow/escape
      // sequences are < 0x20 or multi-byte, so they're skipped.
      if (data.length === 1 && data >= ' ') pendingTs = now()
    },

    onOutput(byteLen: number) {
      if (pendingTs === null) return
      const echoArrivedTs = now()
      const echoMs = echoArrivedTs - pendingTs
      pendingTs = null
      const firstEcho = !firstEchoSeen
      firstEchoSeen = true
      const sinceOpenMs = echoArrivedTs - openTs
      // The second leg: how long until the renderer actually gets a frame to paint.
      scheduleFrame(() => {
        report({
          echoMs,
          paintMs: now() - echoArrivedTs,
          echoBytes: byteLen,
          firstEcho,
          sinceOpenMs,
        })
      })
    },
  }
}
