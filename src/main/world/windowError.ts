/**
 * WP3 round 3: which failures of world:get, world:compile and world:relayout the window may show as they are. The world
 * host's failures (outwardError mapped them before they left the host) and main's own fixed messages are marked here. Any
 * other error main meets on those calls, such as git or a file read before the host call (headOf, snapshotOf), can name a
 * path on this computer: only the log gets it, and the window gets WORLD_CALL_FAILED.
 */
const shown = new WeakSet<Error>()

/** SIGNED OFF 2026-11-27 (signoff-decisions.md) (WP3 round 3): what the window shows for a world call that failed in main before the host call. */
export const WORLD_CALL_FAILED = "Lumopolis couldn't read this project. Try again in a moment."

/** Marks `e` as fit to show in the window as it is, and returns it. */
export function shownAsIs<E extends Error>(e: E): E {
  shown.add(e)
  return e
}

/** An Error whose message is fixed text, fit to show in the window. */
export const shownError = (message: string): Error => shownAsIs(new Error(message))

/** Whether `e` was marked fit to show in the window as it is. */
export const isShownAsIs = (e: unknown): e is Error => e instanceof Error && shown.has(e)

/** The message the window gets for a world call's failure. One not marked is logged as it was, and goes out as fixed text. */
export function windowMessage(e: unknown): string {
  if (isShownAsIs(e)) return e.message
  console.warn('[world] a world call failed in main:', e)
  return WORLD_CALL_FAILED
}
