#!/usr/bin/env node
/**
 * Generate / verify `<resources>/app-update.yml` for the packaged app.
 *
 * WHY THIS EXISTS
 * ---------------
 * electron-updater reads `<resources>/app-update.yml` at the start of every
 * checkForUpdates() to learn WHERE to look for updates (the GitHub repo) and
 * which cache dir to use. electron-builder normally writes this file during the
 * *pack* phase of a full build.
 *
 * The Windows release is built in TWO phases so we can code-sign the inner exe
 * (see .github/workflows/release.yml): `electron-builder --win --dir` then
 * `electron-builder --win nsis --prepackaged <dir>`. `--prepackaged` SKIPS the
 * pack phase that writes app-update.yml, so v1.15.4 / v1.15.5 shipped WITHOUT it
 * and Windows auto-update broke for everyone with:
 *   "ENOENT ... resources\app-update.yml"  (Sentry ELECTRON-8 / issue #14).
 *
 * This script regenerates the file deterministically from package.json's
 * `build.publish` config. It is wired into the Windows build BETWEEN the two
 * phases (write mode), plus a `--verify` mode used as a fail-fast guard before
 * anything is uploaded. Logic is unit-tested in
 * tests/electron/writeAppUpdateYml.test.ts.
 */
const fs = require('fs')
const path = require('path')

function loadPkg() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'))
}

// electron-builder derives the updater cache dir name from the (sanitized,
// lowercased) product name + "-updater" when not set explicitly. Mirror that so
// the runtime cache path matches what a normal electron-builder build produced
// (verified: productName "Termpolis" -> "termpolis-updater").
function updaterCacheDirName(pkg) {
  const build = pkg.build || {}
  const base = build.productName || pkg.name || 'app'
  return String(base).replace(/[\\/:*?"<>|]/g, '-').toLowerCase() + '-updater'
}

// Build the exact YAML electron-builder would have written for a github
// provider: provider/owner/repo + updaterCacheDirName. Publish-only fields
// (e.g. releaseType) are intentionally omitted — they are not part of the
// client-side updater config.
function buildAppUpdateYml(pkg = loadPkg()) {
  const build = pkg.build || {}
  let publish = build.publish
  if (Array.isArray(publish)) publish = publish[0]
  if (!publish) {
    throw new Error('writeAppUpdateYml: package.json build.publish is not configured')
  }
  if (publish.provider !== 'github' || !publish.owner || !publish.repo) {
    throw new Error(
      'writeAppUpdateYml: expected a github publish provider with owner+repo, got: ' +
        JSON.stringify(publish),
    )
  }
  return (
    [
      `provider: ${publish.provider}`,
      `owner: ${publish.owner}`,
      `repo: ${publish.repo}`,
      `updaterCacheDirName: ${updaterCacheDirName(pkg)}`,
    ].join('\n') + '\n'
  )
}

function writeAppUpdateYml(resourcesDir, pkg = loadPkg()) {
  if (!fs.existsSync(resourcesDir)) {
    throw new Error(`writeAppUpdateYml: resources dir does not exist: ${resourcesDir}`)
  }
  const out = path.join(resourcesDir, 'app-update.yml')
  fs.writeFileSync(out, buildAppUpdateYml(pkg), 'utf-8')
  return out
}

// Fail-fast guard for CI: assert the packaged app actually carries a usable
// app-update.yml, so a build that would brick auto-update never reaches users.
function verifyAppUpdateYml(resourcesDir) {
  const out = path.join(resourcesDir, 'app-update.yml')
  if (!fs.existsSync(out)) {
    throw new Error(
      `[writeAppUpdateYml] FATAL: ${out} is missing — electron-updater will throw ` +
        `"ENOENT ... app-update.yml" and auto-update is dead on arrival.`,
    )
  }
  const txt = fs.readFileSync(out, 'utf-8')
  if (txt.trim().length === 0) {
    throw new Error(`[writeAppUpdateYml] FATAL: ${out} exists but is empty`)
  }
  for (const key of ['provider:', 'owner:', 'repo:']) {
    if (!txt.includes(key)) {
      throw new Error(`[writeAppUpdateYml] FATAL: ${out} is missing required key "${key}"`)
    }
  }
  return out
}

module.exports = {
  buildAppUpdateYml,
  writeAppUpdateYml,
  verifyAppUpdateYml,
  updaterCacheDirName,
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2)
    const verifyIdx = args.indexOf('--verify')
    if (verifyIdx !== -1) {
      const dir = args[verifyIdx + 1]
      if (!dir) throw new Error('usage: writeAppUpdateYml.cjs --verify <resourcesDir>')
      const p = verifyAppUpdateYml(path.resolve(dir))
      // eslint-disable-next-line no-console
      console.log(`[writeAppUpdateYml] OK — ${p} present and valid`)
    } else {
      const dir = args[0]
      if (!dir) {
        throw new Error('usage: writeAppUpdateYml.cjs <resourcesDir>   (or --verify <resourcesDir>)')
      }
      const p = writeAppUpdateYml(path.resolve(dir))
      // eslint-disable-next-line no-console
      console.log(`[writeAppUpdateYml] wrote ${p}`)
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err.message || err)
    process.exit(1)
  }
}
