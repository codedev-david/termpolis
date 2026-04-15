// afterPack hook for electron-builder
// Ensures node-pty's spawn-helper binary has execute permissions.
// electron-builder's signing pass will then sign it along with everything else,
// but only if it's marked executable (non-executable files get skipped).

const { readdirSync, statSync, chmodSync } = require('fs')
const path = require('path')

exports.default = async function afterPack(context) {
  if (process.platform !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appDir = path.join(context.appOutDir, `${appName}.app`)
  const unpackedDir = path.join(appDir, 'Contents', 'Resources', 'app.asar.unpacked')

  console.log(`[afterPack] Scanning for node-pty binaries in: ${unpackedDir}`)

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

  // Find spawn-helper (no extension) and pty.node
  const binaries = findFiles(unpackedDir, ['spawn-helper', 'pty.node'])

  for (const bin of binaries) {
    console.log(`[afterPack] Ensuring executable: ${bin}`)
    try {
      chmodSync(bin, 0o755)
      console.log(`[afterPack] chmod 755: ${bin}`)
    } catch (e) {
      console.warn(`[afterPack] Warning: chmod failed for ${bin}: ${e.message}`)
    }
  }

  if (binaries.length === 0) {
    console.warn('[afterPack] WARNING: No spawn-helper or pty.node found in unpacked dir!')
    console.warn('[afterPack] Contents:', (() => {
      try { return readdirSync(unpackedDir).join(', ') } catch { return 'dir not found' }
    })())
  } else {
    console.log(`[afterPack] Found ${binaries.length} binaries to prepare for signing`)
  }
}
