// The direct typing line (1.61.0): what the renderer and the terminal process host (ptyHost.ts) say to each other over
// the MessagePort main hands both of them, so a keystroke and its echo never wait on main's thread.
//
//   renderer -> host   { t: 'w', id, data, sync? }   a write to terminal `id`, typed or pasted
//                      { t: 'sub', id } / { t: 'unsub', id }   a pane for `id` is mounted / gone: only then is its output sent
//   host -> renderer   { t: 'bind', id, fresh? }     `id` lives in the host now: its writes may come here. `fresh`: a
//                                                    new shell under that id (its stream starts over for the renderer)
//                      { t: 'unbind', id }           its shell ended
//                      { t: 'd', id, data, end }     output, `end` being where it ends in the terminal's stream, on the
//                                                    same scale main's output buffer counts (terminalOutputBuffer.ts)
//
// The line only ever adds a copy. Main still receives every byte of output and still sends it to the renderer as
// terminal:data; the renderer takes whichever copy of a stretch arrives first and drops the other by its end offset
// (src/preload/terminalDataRouter.ts). Main still sees every write too: the host hands it a copy of each one it wrote,
// and hands it, unwritten, every write main must judge first (see ptyHost.ts). So a direct line that breaks, or never
// comes up, leaves the app exactly as it was before 1.61.0.

/** Main -> renderer: the port (transferred with the message). */
export const DIRECT_PORT_CHANNEL = 'pty:direct-port'
/** Main -> renderer: the host is gone; forget the port and every terminal it served. */
export const DIRECT_RESET_CHANNEL = 'pty:direct-reset'
/** Renderer -> main: everything written to `id` through main up to now has been sent; mark `n`. */
export const DIRECT_SYNC_CHANNEL = 'terminal:direct-sync'
/** Kill switch: TERMPOLIS_NO_DIRECT_TYPING=1 keeps every keystroke on the path through main. */
export const NO_DIRECT_TYPING_ENV = 'TERMPOLIS_NO_DIRECT_TYPING'

export type DirectToHost =
  | { t: 'w'; id: string; data: string; sync?: number }
  | { t: 'sub'; id: string }
  | { t: 'unsub'; id: string }

export type DirectFromHost =
  | { t: 'bind'; id: string; fresh?: true }
  | { t: 'unbind'; id: string }
  | { t: 'd'; id: string; data: string; end: number }

/** A write main must see BEFORE it reaches the shell: strict mode refuses a `gemini` launch on an unsafe account
 *  (index.ts terminal:write). Wider than strict mode's own pattern on purpose: a paste's markers and any spelling of
 *  the line go to main, which applies the exact test. Plain typing never contains it in one write. */
export function directWriteNeedsMain(data: string): boolean {
  return data.includes('gemini')
}

export function directTypingDisabledByEnv(env: NodeJS.ProcessEnv | undefined): boolean {
  const v = (env?.[NO_DIRECT_TYPING_ENV] ?? '').trim()
  return v === '1' || v === 'true'
}
