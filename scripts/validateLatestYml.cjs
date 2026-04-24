#!/usr/bin/env node
/**
 * Validates electron-updater latest.yml / latest-mac.yml / latest-linux.yml
 * files produced by electron-builder and published to a GitHub release.
 *
 * Why this exists: the auto-updater's entire contract lives in these YAML
 * files. A valid-looking release can still brick updates if:
 *   - a `files[].url` points at an asset that isn't actually attached
 *   - the `sha512` digest is missing / empty / truncated
 *   - the `version` field doesn't match the tag (electron-updater will
 *     refuse to apply an update whose metadata version is <= installed)
 *   - the file is corrupt YAML (rare, but has happened in the wild)
 *
 * Unit tests exist (tests/scripts/validateLatestYml.test.ts) but exercise
 * only the pure validator function. The CI job calls this script against
 * live release artifacts as a post-release gate, so if the release ever
 * ships a broken latest.yml the workflow flips red loudly.
 *
 * CLI usage:
 *   node scripts/validateLatestYml.cjs \
 *     --version v1.11.15 \
 *     --base https://github.com/codedev-david/termpolis/releases/download
 *
 * Exit 0 on success. Exit 1 and print findings on failure.
 */

const yaml = require('js-yaml')

const YML_FILES = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']
const SHA512_B64_LEN = 88 // base64 of 64-byte digest — 88 chars with padding

/**
 * Pure validator — given a parsed YAML object and the expected version,
 * returns a list of findings. Empty array means the file is valid.
 *
 * `expectedVersion` is optional; when provided, the yaml's `version`
 * field must match (with the leading 'v' stripped from either side).
 */
function validateParsed(parsed, expectedVersion) {
  const findings = []
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    findings.push('not a YAML mapping')
    return findings
  }

  if (!parsed.version) {
    findings.push('missing `version`')
  } else if (expectedVersion) {
    const normExpected = String(expectedVersion).replace(/^v/, '')
    const normActual = String(parsed.version).replace(/^v/, '')
    if (normActual !== normExpected) {
      findings.push(`version mismatch — yaml says ${parsed.version}, expected ${expectedVersion}`)
    }
  }

  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    findings.push('missing or empty `files` array')
  } else {
    parsed.files.forEach((f, i) => {
      if (!f || typeof f !== 'object') {
        findings.push(`files[${i}] is not an object`)
        return
      }
      if (!f.url || typeof f.url !== 'string') {
        findings.push(`files[${i}] missing url`)
      }
      if (!f.sha512 || typeof f.sha512 !== 'string') {
        findings.push(`files[${i}] missing sha512`)
      } else if (f.sha512.length < SHA512_B64_LEN - 2) {
        findings.push(`files[${i}] sha512 looks truncated (len=${f.sha512.length})`)
      }
      if (typeof f.size !== 'number' || f.size <= 0) {
        findings.push(`files[${i}] missing positive size (got ${f.size})`)
      }
    })
  }

  // `path` is the top-level "primary" installer for electron-updater
  if (!parsed.path || typeof parsed.path !== 'string') {
    findings.push('missing top-level `path`')
  }

  // Top-level sha512 must match one of the files' sha512
  if (!parsed.sha512 || typeof parsed.sha512 !== 'string') {
    findings.push('missing top-level `sha512`')
  } else if (Array.isArray(parsed.files)) {
    const primary = parsed.files.find(f => f && f.url === parsed.path)
    if (primary && primary.sha512 && primary.sha512 !== parsed.sha512) {
      findings.push(`top-level sha512 does not match files[] entry for ${parsed.path}`)
    }
  }

  if (!parsed.releaseDate) {
    findings.push('missing `releaseDate`')
  }

  return findings
}

function parseArgs(argv) {
  const args = { version: null, base: null, timeoutMs: 15000 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version' && argv[i + 1]) { args.version = argv[++i] }
    else if (argv[i] === '--base' && argv[i + 1]) { args.base = argv[++i] }
    else if (argv[i] === '--timeout' && argv[i + 1]) { args.timeoutMs = Number(argv[++i]) }
  }
  return args
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return await res.text()
  } finally {
    clearTimeout(t)
  }
}

async function headOk(url, timeoutMs) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' })
    return res.ok
  } catch { return false } finally {
    clearTimeout(t)
  }
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.version || !args.base) {
    console.error('usage: validateLatestYml.cjs --version <vX.Y.Z> --base <releases/download-url>')
    process.exit(2)
  }

  const releaseBase = `${args.base.replace(/\/$/, '')}/${args.version}`
  let allFindings = []
  let checkedAtLeastOne = false

  for (const name of YML_FILES) {
    const ymlUrl = `${releaseBase}/${name}`
    console.log(`→ ${ymlUrl}`)
    let text
    try {
      text = await fetchText(ymlUrl, args.timeoutMs)
    } catch (e) {
      // Not every release publishes all three (e.g. early releases may
      // skip linux). Missing is only a fatal finding if NONE were found.
      console.log(`  (skip: ${e.message})`)
      continue
    }
    checkedAtLeastOne = true
    let parsed
    try {
      parsed = yaml.load(text)
    } catch (e) {
      allFindings.push(`${name}: YAML parse error — ${e.message}`)
      continue
    }
    const findings = validateParsed(parsed, args.version)
    findings.forEach(f => allFindings.push(`${name}: ${f}`))

    // Verify every files[].url resolves on the release
    if (Array.isArray(parsed?.files)) {
      for (const f of parsed.files) {
        if (!f?.url) continue
        const assetUrl = `${releaseBase}/${f.url}`
        const ok = await headOk(assetUrl, args.timeoutMs)
        if (!ok) allFindings.push(`${name}: asset not reachable — ${assetUrl}`)
      }
    }
  }

  if (!checkedAtLeastOne) {
    console.error('FAIL: no latest*.yml files were reachable at', releaseBase)
    process.exit(1)
  }
  if (allFindings.length > 0) {
    console.error('FAIL: validation findings:')
    for (const f of allFindings) console.error(' -', f)
    process.exit(1)
  }
  console.log('OK: all latest*.yml files valid for', args.version)
}

module.exports = { validateParsed, parseArgs }

if (require.main === module) {
  runCli().catch(err => {
    console.error('UNEXPECTED:', err?.message || err)
    process.exit(1)
  })
}
