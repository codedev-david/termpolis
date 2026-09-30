/**
 * The consent contract main (userData/telemetry.json) and the renderer (its localStorage mirror)
 * both read.
 *
 * Two independent tiers, both OFF until the user turns them on:
 *   - crash: error reports (main + renderer Sentry, updater failures, unclean exits, swarm errors)
 *   - usage: the once-a-day launch ping and recordEvent() breadcrumbs
 *
 * Bump CONSENT_VERSION whenever what a tier sends changes enough that an earlier "yes" no longer
 * covers it. Any stored answer below this version counts as no answer: both tiers read OFF and the
 * user is asked again (the launch review modal, or the tour's privacy step on a fresh install).
 * Version 1 was the single `optIn` flag, which defaulted to ON in the tour — hence the re-ask.
 */
export const CONSENT_VERSION = 2

export interface TelemetryConsentChoice {
  crash: boolean
  usage: boolean
}
