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

  if (!appleId || !appleIdPassword || !teamId) {
    console.log('[notarize] Skipping notarization — missing APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, or APPLE_TEAM_ID')
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(appOutDir, `${appName}.app`)

  console.log(`[notarize] Notarizing ${appPath}...`)
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
    console.error(`[notarize] ✗ Notarization failed: ${e.message}`)
    throw e
  }
}
