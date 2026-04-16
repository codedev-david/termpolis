// afterPack hook for electron-builder
// Runs BEFORE electron-builder signs the app bundle.
// Signs spawn-helper with Developer ID so electron-builder's signing pass
// includes it in the bundle's CodeResources hash.

const { execSync } = require('child_process')
const { readdirSync, statSync, chmodSync } = require('fs')
const path = require('path')

exports.default = async function afterPack(context) {
  if (process.platform !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appDir = path.join(context.appOutDir, `${appName}.app`)
  const unpackedDir = path.join(appDir, 'Contents', 'Resources', 'app.asar.unpacked')

  console.log(`[afterPack] Scanning for node-pty binaries in: ${unpackedDir}`)

  function findFilesRecursive(dir, names) {
    const results = []
    try {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        try {
          const stat = statSync(full)
          if (stat.isDirectory()) results.push(...findFilesRecursive(full, names))
          else if (names.includes(entry)) results.push(full)
        } catch {}
      }
    } catch {}
    return results
  }

  const binaries = findFilesRecursive(unpackedDir, ['spawn-helper', 'pty.node'])

  if (binaries.length === 0) {
    console.warn('[afterPack] WARNING: No spawn-helper or pty.node found!')
    try {
      console.warn('[afterPack] Unpacked dir contents:', readdirSync(unpackedDir).join(', '))
    } catch { console.warn('[afterPack] Unpacked dir does not exist') }
    return
  }

  // Find the Developer ID identity from the keychain
  let identity = null
  try {
    const identities = execSync('security find-identity -v -p codesigning', { encoding: 'utf-8' })
    const match = identities.match(/"(Developer ID Application: [^"]+)"/)
    if (match) identity = match[1]
    console.log(`[afterPack] Found signing identity: ${identity || 'none'}`)
  } catch (e) {
    console.warn(`[afterPack] Could not find signing identity: ${e.message}`)
  }

  const entitlements = path.join(__dirname, '..', 'entitlements.mac.inherit.plist')

  for (const bin of binaries) {
    // Ensure executable
    try {
      chmodSync(bin, 0o755)
      console.log(`[afterPack] chmod 755: ${bin}`)
    } catch (e) {
      console.warn(`[afterPack] chmod failed: ${e.message}`)
    }

    // Sign with Developer ID (or ad-hoc for local dev)
    const signId = identity ? `"${identity}"` : '-'
    try {
      const cmd = `codesign --force --options runtime --sign ${signId} --entitlements "${entitlements}" "${bin}"`
      console.log(`[afterPack] Running: ${cmd}`)
      execSync(cmd, { stdio: 'inherit' })
      console.log(`[afterPack] Signed: ${bin}`)
    } catch (e) {
      console.error(`[afterPack] ERROR signing ${bin}: ${e.message}`)
    }
  }

  console.log(`[afterPack] Done — ${binaries.length} binaries prepared for bundling`)
}
