#!/usr/bin/env node
/**
 * Re-syncs `latest.yml` (and any sibling `latest-*.yml`) with the actual
 * SHA512 + byte size of the installer file on disk.
 *
 * Why this exists: electron-builder writes `latest.yml` during the package
 * step, BEFORE the Windows code-signing step modifies the .exe in place.
 * Code-signing changes the file bytes (it appends a signature + cert
 * chain), so the SHA512 in `latest.yml` no longer matches the .exe that
 * gets uploaded to the GitHub release. electron-updater on the user's
 * machine then refuses to install the downloaded update with a
 * "sha512 checksum mismatch" error.
 *
 * Fix: after signing, run this script to recompute SHA512+size from the
 * signed installer and overwrite the corresponding fields in latest.yml.
 *
 * CLI usage:
 *   node scripts/refreshLatestYml.cjs \
 *     --installer dist-electron-builder/Termpolis.Setup.1.11.24.exe \
 *     --yml dist-electron-builder/latest.yml
 *
 * Exit 0 on success, 1 on any error (file missing, parse fail, no
 * matching `files[]` entry).
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const yaml = require('js-yaml')

function hashAndSize(filePath) {
  const buf = fs.readFileSync(filePath)
  const sha512 = crypto.createHash('sha512').update(buf).digest('base64')
  return { sha512, size: buf.length }
}

/**
 * Pure refresh — given a parsed YAML object, the installer's basename,
 * and the installer's hash + size, returns the updated YAML object.
 * Returns null if no matching files[] entry exists (caller should treat
 * that as an error rather than silently dropping the update).
 */
function refreshParsed(parsed, installerName, sha512, size) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) return null

  const entry = parsed.files.find(f => f && f.url === installerName)
  if (!entry) return null

  entry.sha512 = sha512
  entry.size = size

  // Top-level path/sha512 mirror the primary installer entry.
  if (parsed.path === installerName) {
    parsed.sha512 = sha512
  }
  return parsed
}

function parseArgs(argv) {
  const args = { installer: null, yml: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--installer' && argv[i + 1]) args.installer = argv[++i]
    else if (argv[i] === '--yml' && argv[i + 1]) args.yml = argv[++i]
  }
  return args
}

function refreshOnDisk({ installer, yml }) {
  if (!installer || !yml) {
    return { ok: false, error: 'usage: --installer <path> --yml <path>' }
  }
  if (!fs.existsSync(installer)) return { ok: false, error: `installer missing: ${installer}` }
  if (!fs.existsSync(yml))       return { ok: false, error: `yml missing: ${yml}` }

  const installerName = path.basename(installer)
  const { sha512, size } = hashAndSize(installer)
  const text = fs.readFileSync(yml, 'utf8')
  let parsed
  try { parsed = yaml.load(text) } catch (e) {
    return { ok: false, error: `YAML parse failed: ${e.message}` }
  }

  const updated = refreshParsed(parsed, installerName, sha512, size)
  if (!updated) {
    return { ok: false, error: `no files[].url entry matched ${installerName}` }
  }

  const out = yaml.dump(updated, { lineWidth: -1, noRefs: true })
  fs.writeFileSync(yml, out, 'utf8')
  return { ok: true, installerName, sha512, size }
}

function runCli() {
  const args = parseArgs(process.argv.slice(2))
  const result = refreshOnDisk(args)
  if (!result.ok) {
    console.error(`refreshLatestYml: ${result.error}`)
    process.exit(1)
  }
  console.log(`Refreshed ${path.basename(args.yml)} for ${result.installerName} (size=${result.size}, sha512=${result.sha512.slice(0, 16)}...)`)
}

module.exports = { hashAndSize, refreshParsed, refreshOnDisk, parseArgs }

if (require.main === module) runCli()
