// afterSign hook for electron-builder
// After electron-builder signs the app bundle, verify that spawn-helper
// is properly signed. If not, sign it with the Developer ID certificate.

const { execSync } = require('child_process')
const { readdirSync, statSync } = require('fs')
const path = require('path')

exports.default = async function afterSign(context) {
  if (process.platform !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appDir = path.join(context.appOutDir, `${appName}.app`)
  const unpackedDir = path.join(appDir, 'Contents', 'Resources', 'app.asar.unpacked')

  console.log(`[afterSign] Verifying signatures in: ${unpackedDir}`)

  function findFiles(dir, names) {
    const results = []
    try {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        try {
          const stat = statSync(full)
          if (stat.isDirectory()) results.push(...findFiles(full, names))
          else if (names.includes(entry)) results.push(full)
        } catch {}
      }
    } catch {}
    return results
  }

  const binaries = findFiles(unpackedDir, ['spawn-helper', 'pty.node'])

  // Get the signing identity electron-builder used
  // It's typically "Developer ID Application: <name> (<team-id>)"
  let identity = null
  try {
    const appSignature = execSync(`codesign -dvv "${appDir}" 2>&1`, { encoding: 'utf-8' })
    const match = appSignature.match(/Authority=(Developer ID Application: .+)/)
    if (match) identity = match[1]
    console.log(`[afterSign] App signed with: ${identity || 'unknown'}`)
  } catch (e) {
    console.log(`[afterSign] Could not read app signature: ${e.message}`)
  }

  const entitlements = path.join(__dirname, '..', 'entitlements.mac.inherit.plist')

  for (const bin of binaries) {
    // Check if already properly signed
    try {
      execSync(`codesign --verify --strict "${bin}" 2>&1`, { encoding: 'utf-8' })
      console.log(`[afterSign] Already signed: ${bin}`)
      continue
    } catch {
      // Not signed or signature invalid — sign it
    }

    console.log(`[afterSign] Signing: ${bin}`)
    try {
      if (identity) {
        // Sign with Developer ID (same as the app)
        execSync(`codesign --force --options runtime --sign "${identity}" --entitlements "${entitlements}" "${bin}"`, { stdio: 'inherit' })
      } else {
        // Fallback to ad-hoc if no identity found (dev builds)
        execSync(`codesign --force --sign - --entitlements "${entitlements}" "${bin}"`, { stdio: 'inherit' })
      }
      console.log(`[afterSign] Signed: ${bin}`)
    } catch (e) {
      console.error(`[afterSign] ERROR signing ${bin}: ${e.message}`)
    }
  }

  // Verify the whole app bundle is valid after our changes
  try {
    execSync(`codesign --verify --deep --strict "${appDir}" 2>&1`, { encoding: 'utf-8' })
    console.log(`[afterSign] App bundle signature verified OK`)
  } catch (e) {
    console.error(`[afterSign] WARNING: App bundle verification failed: ${e.message}`)
    // Try to see what's wrong
    try {
      const details = execSync(`codesign --verify --deep --strict --verbose=4 "${appDir}" 2>&1`, { encoding: 'utf-8' })
      console.error(`[afterSign] Details: ${details}`)
    } catch (e2) {
      console.error(`[afterSign] Verify details: ${e2.message}`)
    }
  }
}
