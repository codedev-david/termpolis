// afterPack hook — ensures spawn-helper has execute permission.
// Runs BEFORE electron-builder signs the bundle.
// This matches how Hyper Terminal fixes node-pty on macOS.

const { chmodSync, readdirSync, statSync } = require('fs')
const path = require('path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appDir = path.join(context.appOutDir, `${appName}.app`)

  // Look in both app.asar.unpacked and the raw Resources for spawn-helper
  const searchDirs = [
    path.join(appDir, 'Contents', 'Resources', 'app.asar.unpacked'),
    path.join(appDir, 'Contents', 'Resources'),
  ]

  function chmodFiles(dir, names) {
    try {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        try {
          const stat = statSync(full)
          if (stat.isDirectory()) {
            chmodFiles(full, names)
          } else if (names.includes(entry)) {
            chmodSync(full, 0o755)
            console.log(`[afterPack] chmod 755: ${full}`)
          }
        } catch {}
      }
    } catch {}
  }

  let count = 0
  const originalLog = console.log
  console.log = (...args) => { count++; originalLog(...args) }

  for (const dir of searchDirs) {
    chmodFiles(dir, ['spawn-helper'])
  }

  console.log = originalLog
  console.log(`[afterPack] chmod complete (${count} binaries)`)
}
