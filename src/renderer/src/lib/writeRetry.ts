/**
 * What the renderer's output writers do when xterm refuses a chunk (1.54.5).
 *
 * `term.write` throws when xterm's own queue is past its 50,000,000-char watermark ("write data discarded,
 * use flow control to avoid losing data") or when the terminal is being torn down. A writer must not lose
 * the chunk when that happens, in the middle of an escape sequence if that is where the boundary fell: it
 * keeps it at the head of its queue and offers it again, the next tick first, then with a doubling delay.
 * About 13 s in all; a refusal that lasts that long is a terminal that is gone, and the chunk is dropped so
 * a queue cannot grow for ever behind it.
 *
 * The output throttle (outputThrottle.ts) and the write scheduler (writeScheduler.ts) share this policy,
 * so a pane behaves the same whichever of them carries its output.
 */

/** How many times in a row one chunk may be refused before it is dropped. */
export const MAX_WRITE_RETRIES = 10

/** The first delayed retry waits this long; every further one doubles it. */
export const RETRY_BASE_MS = 100

/** ...up to this long. */
export const RETRY_BACKOFF_CAP_MS = 2000

/** What a writer tells its error callback about a refused chunk. */
export interface ThrottleErrorInfo {
  /** Consecutive refusals of this chunk so far, this one included. */
  attempt: number
  /** True when this was the last: the chunk is gone. */
  dropped: boolean
  /** Size of the chunk that was refused. */
  chars: number
}

/**
 * How long to wait before offering a chunk again after its `failures`-th refusal in a row: 0 (the next
 * ordinary tick) after the first, then 200, 400, 800, 1600 ms, then every 2 s.
 */
export function retryDelayMs(failures: number): number {
  return failures <= 1 ? 0 : Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_BACKOFF_CAP_MS)
}
