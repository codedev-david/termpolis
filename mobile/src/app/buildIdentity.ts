/**
 * Which binary is this?
 *
 * `expoConfig.version` is the marketing string from app.json, and it does not
 * move: every TestFlight build so far reports the same "1.0.0". The number that
 * actually identifies a binary is CFBundleVersion, and EAS owns it remotely
 * (eas.json sets appVersionSource "remote" with autoIncrement), which makes
 * app.json's `ios.buildNumber` a dead value that never matches what shipped.
 *
 * `Constants.platform` reads the EMBEDDED Info.plist / manifest, so it reports
 * the build that is really installed. Without it on screen there is no way --
 * from the phone or from the repo -- to tell whether an installed build
 * contains a given fix, which turns every "is it fixed yet?" into a guess.
 */

/** Structural, not the expo-constants type: the helper stays testable without
 *  standing up the native module. */
export type BuildIdentitySource = {
  expoConfig?: { version?: string | null } | null
  platform?: {
    ios?: { buildNumber?: string | null } | null
    android?: { versionCode?: number | null } | null
  } | null
}

export function formatBuildIdentity(source: BuildIdentitySource): string {
  const version = source.expoConfig?.version || 'unknown'
  const ios = source.platform?.ios?.buildNumber
  const android = source.platform?.android?.versionCode
  // Android reports a number and iOS a string; 0 is not a real build number on
  // either, so a falsy value means "no answer" rather than "build zero".
  const build = (ios && String(ios)) || (android ? String(android) : '')
  return build ? `${version} (build ${build})` : `${version} (build unknown)`
}
