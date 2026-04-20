# Releasing Termpolis

This document covers the steps to cut a signed, notarized, auto-updatable release
for all three platforms. Follow it exactly for public release builds.

## Version bump

1. Update `version` in `package.json`.
2. Commit on `main` with message `chore: release vX.Y.Z`.
3. Tag: `git tag vX.Y.Z && git push --tags`.

## Required signing environment

### Windows (code signing)

Required environment variables when building a signed Windows installer:

| Variable          | Purpose                                                  |
| ----------------- | -------------------------------------------------------- |
| `CSC_LINK`        | Path or base64-encoded `.pfx` / `.p12` certificate file. |
| `CSC_KEY_PASSWORD`| Password for the certificate.                            |

Without these, electron-builder still produces an `.exe`, but it is unsigned —
SmartScreen will warn users on first download and users must click "More info"
to run it. **Unsigned Windows builds are not acceptable for public release.**

Buy a cert from DigiCert, Sectigo, or SSL.com. EV certs get an immediate
reputation boost in SmartScreen.

### macOS (signing + notarization)

Required environment variables when building a signed macOS DMG:

| Variable                      | Purpose                                          |
| ----------------------------- | ------------------------------------------------ |
| `APPLE_ID`                    | Apple ID email for the developer account.        |
| `APPLE_APP_SPECIFIC_PASSWORD` | [App-specific password][asp] from appleid.apple.com. |
| `APPLE_TEAM_ID`               | 10-char team ID from Apple Developer portal.     |
| `CSC_LINK`                    | Path to `.p12` containing Developer ID Application certificate. |
| `CSC_KEY_PASSWORD`            | Password for the `.p12`.                         |

[asp]: https://support.apple.com/en-us/102654

The build pipeline will:

1. Sign `Termpolis.app` with the Developer ID cert (hardened runtime on).
2. Submit the `.dmg` to Apple's notary service via `notarytool`.
3. Staple the notarization ticket to the `.dmg`.

**Apple Silicon (arm64) and Intel (x64) are both produced** — we ship a single
`universal` DMG that works on both architectures.

An unsigned or unnotarized `.dmg` shows the "unidentified developer" Gatekeeper
warning and a majority of Mac users will abandon. **Unnotarized macOS builds
are not acceptable for public release.**

### Linux

No signing required. AppImage is produced as-is.

## Build commands

```bash
# Full release build (all platforms)
npm ci
npm run build
npm run package

# Platform-specific
npx electron-builder --win
npx electron-builder --mac
npx electron-builder --linux
```

Output lands in `dist-electron-builder/`.

## Publishing + auto-update

Binaries and the `latest-*.yml` metadata files are published to GitHub
Releases. `electron-updater` in the app points at the same repo and
auto-downloads updates in the background.

After uploading release assets, verify:

1. An existing v(N-1) install correctly detects vN and prompts to update.
2. The update installs without a UAC / Gatekeeper challenge.
3. Sentry shows no increase in error rate for the first 24 hours of the rollout.

## Pre-flight smoke

Before tagging a release:

```bash
npm ci                 # lockfile-only install
npm run lint           # must exit 0
npm test -- --run      # unit suite must pass
npx playwright test    # full e2e suite must pass
```

## Rollback

Bad release? Delete the release (keep the tag for history) and publish an
older `latest-*.yml` so auto-update points users back to the prior version.
Then cut a patch release that actually fixes the bug.
