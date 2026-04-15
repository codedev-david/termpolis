// afterPack hook for electron-builder
// Signs spawn-helper binary from node-pty which has no file extension
// and gets skipped by electron-builder's default signing patterns.

const { execSync } = require('child_process')
const { readdirSync, statSync, chmodSync } = require('fs')
const path = require('path')

exports.default = async function afterPack(context) {
  if (process.platform !== 'darwin') return

  const appDir = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const unpackedDir = path.join(appDir, 'Contents', 'Resources', 'app.asar.unpacked')

  console.log(`[afterPack] Scanning for spawn-helper in: ${unpackedDir}`)

  function findFiles(dir, name) {
    const results = []
    try {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        try {
          const stat = statSync(full)
          if (stat.isDirectory()) results.push(...findFiles(full, name))
          else if (entry === name) results.push(full)
        } catch {}
      }
    } catch {}
    return results
  }

  const helpers = findFiles(unpackedDir, 'spawn-helper')
  for (const helper of helpers) {
    console.log(`[afterPack] Found spawn-helper: ${helper}`)
    // Ensure executable
    try { chmodSync(helper, 0o755) } catch {}
    // Ad-hoc sign with inherit entitlements
    try {
      execSync(`codesign --force --sign - --entitlements "${path.join(__dirname, '..', 'entitlements.mac.inherit.plist')}" "${helper}"`, { stdio: 'inherit' })
      console.log(`[afterPack] Signed: ${helper}`)
    } catch (e) {
      console.warn(`[afterPack] Warning: failed to sign ${helper}: ${e.message}`)
    }
  }

  if (helpers.length === 0) {
    console.log('[afterPack] No spawn-helper found — node-pty may be inside asar')
  }
}
