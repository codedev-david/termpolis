// afterSign hook for electron-builder — notarizes the .app bundle with Apple
// Uses @electron/notarize (the standard approach used by VS Code, Hyper, etc.)
// Runs AFTER electron-builder signs the app but BEFORE packaging it into a DMG.

const { notarize } = require('@electron/notarize')
const path = require('path')

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return

  const appleId = process.env.APPLE_ID
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD
  const teamId = process.env.APPLE_TEAM_ID

  console.log(`[notarize] Starting notarization check...`)
  console.log(`[notarize] APPLE_ID set: ${!!appleId}`)
  console.log(`[notarize] APPLE_APP_SPECIFIC_PASSWORD set: ${!!appleIdPassword}`)
  console.log(`[notarize] APPLE_TEAM_ID set: ${!!teamId}`)

  if (!appleId || !appleIdPassword || !teamId) {
    console.log('[notarize] SKIPPING notarization — missing env vars (dev build)')
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(appOutDir, `${appName}.app`)

  console.log(`[notarize] App path: ${appPath}`)
  console.log(`[notarize] Team ID: ${teamId}`)
  console.log(`[notarize] Apple ID: ${appleId.substring(0, 3)}***`)
  console.log(`[notarize] Submitting to Apple (this can take 5-15 minutes)...`)

  const start = Date.now()

  try {
    await notarize({
      tool: 'notarytool',
      appPath,
      appleId,
      appleIdPassword,
      teamId,
    })
    const elapsed = Math.round((Date.now() - start) / 1000)
    console.log(`[notarize] ✓ Successfully notarized (took ${elapsed}s)`)
  } catch (e) {
    const elapsed = Math.round((Date.now() - start) / 1000)
    console.error(`[notarize] ✗ Notarization FAILED after ${elapsed}s`)
    console.error(`[notarize] Error message: ${e.message}`)
    console.error(`[notarize] Full error:`, e)
    // Don't throw — let the build continue with an unnotarized DMG
    // The DMG will still be code-signed, user will need to right-click > Open
    console.error(`[notarize] Build will continue with unnotarized app (Gatekeeper will warn users)`)
  }
}
