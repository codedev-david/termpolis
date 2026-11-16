// Plays WorldActions one after another (tours, agent commands). A new play cancels the current one.
import type { WorldAction } from '../../../../shared/world/types'

export interface QueueClock { sleep(ms: number): Promise<void> }
export interface QueueOptions {
  /** When true, exec is told to skip animation and the pause between actions is dropped. Default false. */
  reducedMotion?: boolean
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
  const reducedMotion = options.reducedMotion === true
  let generation = 0
  let running = false

  const cancel = (): void => {
    generation++
    running = false
  }

  const play = async (actions: WorldAction[]): Promise<void> => {
    cancel()
    const mine = generation
    running = true
    try {
      for (let i = 0; i < actions.length; i++) {
        if (mine !== generation) return
        await exec(actions[i], { reducedMotion })
        if (mine !== generation) return
        if (!reducedMotion && i < actions.length - 1) await clock.sleep(ACTION_GAP_MS)
      }
    } finally {
      if (mine === generation) running = false
    }
  }

  return { play, cancel, busy: () => running }
}
