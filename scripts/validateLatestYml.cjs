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
const crypto = require('crypto')

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

async function fetchText(url, timeoutMs, fetchImpl = fetch) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return await res.text()
  } finally {
    clearTimeout(t)
  }
}

async function headOk(url, timeoutMs, fetchImpl = fetch) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' })
    return res.ok
  } catch { return false } finally {
    clearTimeout(t)
  }
}

/**
 * Downloads the asset and returns its actual SHA512 (base64) + size in
 * bytes. Used to verify the YAML's claimed digest matches the bytes the
 * user will actually receive — the gap that broke v1.11.23/24 auto-update.
 */
async function fetchHashAndSize(url, timeoutMs, fetchImpl = fetch) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const sha512 = crypto.createHash('sha512').update(buf).digest('base64')
    return { sha512, size: buf.length }
  } finally {
    clearTimeout(t)
  }
}

/**
 * Pure orchestrator — fetches every latest*.yml from the release base,
 * validates structure, and HEAD-checks advertised assets. Returns
 * `{ exitCode, findings, log }` so the CLI and tests share one codepath.
 *
 * `fetchImpl` defaults to global fetch; tests pass a mock.
 */
async function runValidation({ version, base, timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const log = []
  if (!version || !base) {
    log.push('usage: validateLatestYml.cjs --version <vX.Y.Z> --base <releases/download-url>')
    return { exitCode: 2, findings: [], log }
  }
  const releaseBase = `${base.replace(/\/$/, '')}/${version}`
  const allFindings = []
  let checkedAtLeastOne = false

  for (const name of YML_FILES) {
    const ymlUrl = `${releaseBase}/${name}`
    log.push(`→ ${ymlUrl}`)
    let text
    try {
      text = await fetchText(ymlUrl, timeoutMs, fetchImpl)
    } catch (e) {
      log.push(`  (skip: ${e.message})`)
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
    for (const f of validateParsed(parsed, version)) allFindings.push(`${name}: ${f}`)

    if (Array.isArray(parsed && parsed.files)) {
      for (const f of parsed.files) {
        if (!f || !f.url) continue
        const assetUrl = `${releaseBase}/${f.url}`
        const ok = await headOk(assetUrl, timeoutMs, fetchImpl)
        if (!ok) {
          allFindings.push(`${name}: asset not reachable — ${assetUrl}`)
          continue
        }
        // Byte-level integrity check — download + hash and compare against
        // the YAML claim. This is the check that would have caught the
        // v1.11.23/24 post-signing SHA mismatch before users hit it.
        try {
          const { sha512, size } = await fetchHashAndSize(assetUrl, timeoutMs * 4, fetchImpl)
          if (typeof f.size === 'number' && size !== f.size) {
            allFindings.push(`${name}: size mismatch for ${f.url} — yml says ${f.size}, asset is ${size}`)
          }
          if (f.sha512 && sha512 !== f.sha512) {
            allFindings.push(`${name}: sha512 mismatch for ${f.url} — yml claims ${f.sha512.slice(0, 16)}..., asset hashes to ${sha512.slice(0, 16)}...`)
          }
        } catch (e) {
          allFindings.push(`${name}: could not verify hash of ${f.url} — ${e.message}`)
        }
      }
    }
  }

  if (!checkedAtLeastOne) {
    log.push(`FAIL: no latest*.yml files were reachable at ${releaseBase}`)
    return { exitCode: 1, findings: allFindings, log }
  }
  if (allFindings.length > 0) {
    log.push('FAIL: validation findings:')
    for (const f of allFindings) log.push(` - ${f}`)
    return { exitCode: 1, findings: allFindings, log }
  }
  log.push(`OK: all latest*.yml files valid for ${version}`)
  return { exitCode: 0, findings: [], log }
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2))
  const { exitCode, log } = await runValidation({
    version: args.version,
    base: args.base,
    timeoutMs: args.timeoutMs,
  })
  for (const line of log) {
    if (exitCode !== 0 && (line.startsWith('FAIL') || line.startsWith(' -') || line.startsWith('usage:'))) {
      console.error(line)
    } else {
      console.log(line)
    }
  }
  process.exit(exitCode)
}

module.exports = { validateParsed, parseArgs, fetchText, headOk, fetchHashAndSize, runValidation }

if (require.main === module) {
  runCli().catch(err => {
    console.error('UNEXPECTED:', err && err.message ? err.message : err)
    process.exit(1)
  })
}
