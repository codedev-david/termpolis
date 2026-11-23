// Plays WorldActions one after another (tours, agent commands). A new play cancels the current one.
import type { WorldAction } from '../../../../shared/world/types'

export interface QueueClock { sleep(ms: number): Promise<void> }
export interface QueueOptions {
  /**
   * When true, exec is told to skip animation and the pause between actions is dropped. Default false. A function
   * is asked before each action, so a reduced-motion setting switched on mid-tour is followed from the next step.
   */
  reducedMotion?: boolean | (() => boolean)
}
export interface ActionQueue {
  play(actions: WorldAction[]): Promise<void>
  cancel(): void
  busy(): boolean
}

/** Pause between two actions so a tour is readable. */
export const ACTION_GAP_MS = 700

const realClock: QueueClock = { sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)) }

export function createActionQueue(
  exec: (a: WorldAction, o: { reducedMotion: boolean }) => Promise<void>,
  clock: QueueClock = realClock,
  options: QueueOptions = {},
): ActionQueue {
  const rm = options.reducedMotion
  const reduced = (): boolean => (typeof rm === 'function' ? rm() : rm === true)
  let generation = 0
  let running = false

  const cancel = (): void => {
    generation++
    running = false
  }

  // Cancelling cannot abort an exec already in flight: a stale exec may still be running and can
  // overlap the first action of the new run. Only the actions after it are dropped.
  const play = async (actions: WorldAction[]): Promise<void> => {
    cancel()
    const mine = generation
    running = true
    try {
      for (let i = 0; i < actions.length; i++) {
        if (mine !== generation) return
        await exec(actions[i], { reducedMotion: reduced() })
        if (mine !== generation) return
        if (!reduced() && i < actions.length - 1) await clock.sleep(ACTION_GAP_MS)
      }
    } finally {
      if (mine === generation) running = false
    }
  }

  return { play, cancel, busy: () => running }
}
