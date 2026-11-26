// OrbitControls' damping by the time since its last update (look plan Task 4, VISFLAKE Minor 2). OrbitControls r160
// calls its own update() from its mouse, wheel and touch handlers, and each call spends `dampingFactor` of what is left
// of the motion. A share set once per frame was spent again on every input event, so on a slow screen (many pointer
// moves a frame) the glide after a drag was used up during the drag. Wrapped, every update sets the share from the time
// since the one before, so any number of updates over a stretch of time spend what one update over it would.
import { easeShare } from './viewMath'

/** What timedUpdate needs of the controls: OrbitControls' damping share and its update. */
export interface DampedControls {
  dampingFactor: number
  update(...args: never[]): boolean
}

/**
 * Wraps `controls.update` so each call sets `dampingFactor` to easeShare(rate, seconds since the last call) and then
 * updates. A call with no time since the last one (or a clock that went back) applies a share of 0: nothing of the
 * motion is spent and nothing decays, so the next call spends it by its own gap. `now` is in ms.
 */
export function timedUpdate(controls: DampedControls, rate: number, now: () => number): void {
  const update = controls.update
  let last = now()
  controls.update = (...args: never[]): boolean => {
    const t = now()
    controls.dampingFactor = easeShare(rate, (t - last) / 1000)
    last = t
    return update.apply(controls, args)
  }
}
