import { windowForMode } from '../headroomProxy/wireCompress'
import { effectiveFloor, policyFor } from './elisionPolicy'

/**
 * One line saying which wire tier this launch's proxy will run, and from what size it starts
 * eliding tool results.
 *
 * The tier that is IN FORCE is not the one Settings holds: the savings-floor controller may have
 * raised it, once, at launch. The research found 39% of 600-1,600 character results redeemed in
 * September, a band the default tier never elides and the top tier does, and could not say which
 * of the two was running because the resolved tier lived only in memory. Logged once at launch
 * through logToApp (the caller's job), never from the transform path.
 *
 * `firstSight` is the policy the proxy was handed (elisionPolicy.ts). Under `late` the size a result
 * must reach before it is elided is the policy's floor and not the tier's, and the savings-floor
 * controller plays no part; an argument that is not a policy says nothing about one.
 */
export function describeWireTier(selected: unknown, resolved: unknown, floorControl: boolean, firstSight?: unknown): string {
  const tier = typeof resolved === 'string' && resolved !== '' ? resolved : 'unknown'
  const win = typeof resolved === 'string' ? windowForMode(resolved) : null
  const late = firstSight === 'late'
  const floor = win ? (late ? effectiveFloor(win.floorChars, policyFor('late')) : win.floorChars) : 0
  const from = win ? `, eliding tool results of ${floor.toLocaleString('en-US')} characters or more` : ''
  const how = resolved !== selected
    ? `raised from ${String(selected)} by the savings floor`
    : late ? 'as selected; the savings floor is not used under late'
      : floorControl ? 'as selected; the savings floor held it' : 'as selected; floor control off'
  const policy = firstSight === 'late' || firstSight === 'legacy' ? `; first-sight policy ${firstSight}` : ''
  return `[headroom] wire tier at launch: ${tier}${from} (${how}${policy})`
}
