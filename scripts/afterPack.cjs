// afterPack hook — runs ONCE PER PLATFORM after electron-builder has
// copied files into the unpacked app folder but before it produces
// installers/DMGs. Two responsibilities:
//
//   1. Fix node-pty spawn-helper permissions on macOS (Hyper does the
//      same — needed for posix_spawnp to actually launch spawn-helper).
//   2. Verify every required runtime resource is physically present.
//      If verification fails we throw — this FAILS THE BUILD, which
//      is exactly what we want; v1.11.5 shipped a broken installer
//      because nothing enforced this.

const { chmodSync, readdirSync, statSync } = require('fs')
const path = require('path')
const { verifyFromAfterPack } = require('./verifyPackagedResources.cjs')

exports.default = async function afterPack(context) {
  // Always verify packaged resources, on every platform. Fail-fast.
  verifyFromAfterPack(context)

  // macOS-only: fix spawn-helper permissions.
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
