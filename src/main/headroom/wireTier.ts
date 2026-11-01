import { windowForMode } from '../headroomProxy/wireCompress'

/**
 * One line saying which wire tier this launch's proxy will run, and from what size it starts
 * eliding tool results.
 *
 * The tier that is IN FORCE is not the one Settings holds: the savings-floor controller may have
 * raised it, once, at launch. The research found 39% of 600-1,600 character results redeemed in
 * September, a band the default tier never elides and the top tier does, and could not say which
 * of the two was running because the resolved tier lived only in memory. Logged once at launch
 * through logToApp (the caller's job), never from the transform path.
 */
export function describeWireTier(selected: unknown, resolved: unknown, floorControl: boolean): string {
  const tier = typeof resolved === 'string' && resolved !== '' ? resolved : 'unknown'
  const win = typeof resolved === 'string' ? windowForMode(resolved) : null
  const from = win ? `, eliding tool results of ${win.floorChars.toLocaleString('en-US')} characters or more` : ''
  const how = resolved !== selected
    ? `raised from ${String(selected)} by the savings floor`
    : floorControl ? 'as selected; the savings floor held it' : 'as selected; floor control off'
  return `[headroom] wire tier at launch: ${tier}${from} (${how})`
}
