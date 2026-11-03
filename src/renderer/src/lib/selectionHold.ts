import type { ChunkQueue } from './chunkQueue'

/**
 * How much output a pane holds back while the user has text selected (1.54.5).
 *
 * Output that scrolls or trims the buffer under a selection drops it, so while a selection is active the
 * pane keeps the output instead of writing it, and writes it when the selection is gone. The hold used to
 * be one string capped at 1,000,000 chars, and the first key typed after the selection ended released ALL
 * of it, in front of that key's echo: sixteen throttle ticks of 64 KB, 0.3 to 1.6 s, plus xterm's parse.
 * The cap is now 256 KB, which the throttle drains in four ticks. The price: a very heavy burst lets go of
 * the selection sooner (the hold writes what it has when it would pass the cap). The old cap is kept for
 * the kill switch (localStorage 'termpolis.outputChunks' = '0').
 */
export const HOLD_CAP_CHARS = 4 * 65_536
export const HOLD_CAP_LEGACY_CHARS = 1_000_000

/**
 * Hold `data` behind a selection, or tell the caller what to write instead.
 *
 * Returns the text to write NOW, in order, or '' when everything was held. The hold never keeps more than
 * `cap` chars: a chunk that would take it past the cap lets go of what is already held first (the caller
 * writes that, ahead of anything newer), then is held itself when it fits, or goes out with it when it is
 * bigger than the cap on its own (holding it would not protect anything and would only delay it).
 */
export function holdOutput(held: ChunkQueue, data: string, cap: number): string {
  if (held.length + data.length <= cap) {
    held.push(data)
    return ''
  }
  const out = held.takeAll()
  if (data.length > cap) return out + data
  held.push(data)
  return out
}
