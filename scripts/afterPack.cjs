// afterPack hook for electron-builder
// Ensures node-pty's spawn-helper binary has execute permissions.
// electron-builder's signing pass detects Mach-O binaries by file type
// (not extension) and signs them — but only if they're executable.

const { readdirSync, statSync, chmodSync } = require('fs')
const { execSync } = require('child_process')
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

  for (const bin of binaries) {
    console.log(`[afterPack] Found: ${bin}`)
    try {
      chmodSync(bin, 0o755)
      console.log(`[afterPack] chmod 755 OK`)
    } catch (e) {
      console.warn(`[afterPack] chmod failed: ${e.message}`)
    }
    // Log file type for diagnostics
    try {
      const fileType = execSync(`file "${bin}"`, { encoding: 'utf-8' }).trim()
      console.log(`[afterPack] File type: ${fileType}`)
    } catch {}
  }

  if (binaries.length === 0) {
    console.warn('[afterPack] WARNING: No spawn-helper or pty.node found!')
    try {
      const contents = execSync(`find "${unpackedDir}" -type f | head -20`, { encoding: 'utf-8' })
      console.warn(`[afterPack] Unpacked contents:\n${contents}`)
    } catch {}
  } else {
    console.log(`[afterPack] Prepared ${binaries.length} binaries (chmod only — electron-builder will sign)`)
  }
}
