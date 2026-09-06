import { describe, it, expect, vi } from 'vitest'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
// @ts-expect-error — untyped CJS script
import { validateParsed, parseArgs, fetchText, headOk, fetchHashAndSize, runValidation, makeDirFetch, buildRunOptions, usageError } from '../../scripts/validateLatestYml.cjs'

// Realistic sha512 base64 digest length — 88 chars (64-byte digest,
// base64 with padding). Using a deterministic filler keeps snapshots
// stable while passing the length check.
const GOOD_SHA512 =
  'A'.repeat(86) + '=='

// Deterministic fixture for byte-level hash tests below. We use the actual
// SHA512 of this buffer in the YAML so the validator's new asset-hash
// check passes for the "happy path" tests.
const ASSET_BYTES = Buffer.from('termpolis-test-installer-bytes')
const ASSET_SHA512 = crypto.createHash('sha512').update(ASSET_BYTES).digest('base64')
const ASSET_SIZE = ASSET_BYTES.length

function validYaml(overrides: Record<string, unknown> = {}) {
  return {
    version: '1.11.15',
    files: [
      {
        url: 'Termpolis.Setup.1.11.15.exe',
        sha512: GOOD_SHA512,
        size: 123456789,
      },
    ],
    path: 'Termpolis.Setup.1.11.15.exe',
    sha512: GOOD_SHA512,
    releaseDate: '2026-04-24T15:23:21.000Z',
    ...overrides,
  }
}

describe('validateParsed', () => {
  it('returns no findings for a well-formed latest.yml', () => {
    const findings = validateParsed(validYaml(), 'v1.11.15')
    expect(findings).toEqual([])
  })

  it('accepts version with or without leading v', () => {
    expect(validateParsed(validYaml({ version: 'v1.11.15' }), '1.11.15')).toEqual([])
    expect(validateParsed(validYaml({ version: '1.11.15' }), 'v1.11.15')).toEqual([])
  })

  it('flags a version mismatch', () => {
    const findings = validateParsed(validYaml({ version: '1.11.14' }), 'v1.11.15')
    expect(findings.some(f => f.includes('version mismatch'))).toBe(true)
  })

  it('flags missing version field', () => {
    const yml = validYaml()
    delete (yml as any).version
    expect(validateParsed(yml)).toContain('missing `version`')
  })

  it('flags missing files array', () => {
    const yml = validYaml()
    delete (yml as any).files
    expect(validateParsed(yml)).toContain('missing or empty `files` array')
  })

  it('flags empty files array', () => {
    expect(validateParsed(validYaml({ files: [] }))).toContain('missing or empty `files` array')
  })

  it('flags a files entry with missing url', () => {
    const yml = validYaml({ files: [{ sha512: GOOD_SHA512, size: 1 }] })
    const findings = validateParsed(yml)
    expect(findings.some(f => f.includes('missing url'))).toBe(true)
  })

  it('flags a files entry with missing or truncated sha512', () => {
    const yml = validYaml({ files: [{ url: 'foo.exe', sha512: 'short', size: 1 }] })
    const findings = validateParsed(yml)
    expect(findings.some(f => f.includes('sha512 looks truncated'))).toBe(true)
  })

  it('flags a files entry with missing sha512', () => {
    const yml = validYaml({ files: [{ url: 'foo.exe', size: 1 }] })
    const findings = validateParsed(yml)
    expect(findings.some(f => f.includes('missing sha512'))).toBe(true)
  })

  it('flags a files entry with missing or zero size', () => {
    expect(
      validateParsed(validYaml({ files: [{ url: 'f.exe', sha512: GOOD_SHA512, size: 0 }] }))
        .some(f => f.includes('missing positive size'))
    ).toBe(true)
  })

  it('flags missing top-level path', () => {
    const yml = validYaml()
    delete (yml as any).path
    expect(validateParsed(yml)).toContain('missing top-level `path`')
  })

  it('flags missing top-level sha512', () => {
    const yml = validYaml()
    delete (yml as any).sha512
    expect(validateParsed(yml)).toContain('missing top-level `sha512`')
  })

  it('flags when top-level sha512 disagrees with the matching files[] entry', () => {
    const yml = validYaml({ sha512: 'B'.repeat(86) + '==' })
    const findings = validateParsed(yml)
    expect(findings.some(f => f.includes('top-level sha512 does not match'))).toBe(true)
  })

  it('flags missing releaseDate', () => {
    const yml = validYaml()
    delete (yml as any).releaseDate
    expect(validateParsed(yml)).toContain('missing `releaseDate`')
  })

  it('flags non-object input', () => {
    expect(validateParsed(null)).toContain('not a YAML mapping')
    expect(validateParsed('a string')).toContain('not a YAML mapping')
    expect(validateParsed([])).toContain('not a YAML mapping')
  })

  it('returns multiple findings at once for a multi-flawed yaml', () => {
    const findings = validateParsed({ version: '1.0.0', files: [] }, 'v2.0.0')
    expect(findings.length).toBeGreaterThanOrEqual(4)
    expect(findings.some(f => f.includes('version mismatch'))).toBe(true)
    expect(findings.some(f => f.includes('files`'))).toBe(true)
    expect(findings.some(f => f.includes('path'))).toBe(true)
    expect(findings.some(f => f.includes('sha512'))).toBe(true)
  })
})

describe('parseArgs', () => {
  it('parses --version and --base', () => {
    const args = parseArgs(['--version', 'v1.2.3', '--base', 'https://example.com'])
    expect(args.version).toBe('v1.2.3')
    expect(args.base).toBe('https://example.com')
    expect(args.timeoutMs).toBe(15000)
  })

  it('parses --timeout', () => {
    const args = parseArgs(['--version', 'v1', '--base', 'b', '--timeout', '30000'])
    expect(args.timeoutMs).toBe(30000)
  })

  it('leaves version/base null when flags are missing', () => {
    const args = parseArgs([])
    expect(args.version).toBeNull()
    expect(args.base).toBeNull()
  })

  it('tolerates unknown flags gracefully', () => {
    const args = parseArgs(['--mystery', 'x', '--version', 'v1'])
    expect(args.version).toBe('v1')
  })
})

// ---------------------------------------------------------------------------
// HTTP helpers — fetchText / headOk accept an injected fetch implementation.
// ---------------------------------------------------------------------------

const GOOD_YML = [
  'version: 1.11.15',
  'files:',
  '  - url: Termpolis.Setup.1.11.15.exe',
  `    sha512: ${ASSET_SHA512}`,
  `    size: ${ASSET_SIZE}`,
  'path: Termpolis.Setup.1.11.15.exe',
  `sha512: ${ASSET_SHA512}`,
  "releaseDate: '2026-04-24T00:00:00.000Z'",
].join('\n')

function fakeFetch(map: Record<string, { status?: number; body?: string; bytes?: Buffer; ok?: boolean; reject?: boolean; method?: string }>) {
  return vi.fn(async (url: string, opts: any = {}) => {
    const method = (opts.method || 'GET').toUpperCase()
    const key = `${method} ${url}`
    const entry = map[key] ?? map[url]
    if (!entry) return {
      ok: false, status: 404,
      async text() { return '' },
      async arrayBuffer() { return new ArrayBuffer(0) },
    }
    if (entry.reject) throw new Error('network down')
    const status = entry.status ?? 200
    const ok = entry.ok ?? (status >= 200 && status < 300)
    const buf = entry.bytes ?? (entry.body ? Buffer.from(entry.body) : ASSET_BYTES)
    return {
      ok, status,
      async text() { return entry.body ?? buf.toString('utf8') },
      async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) },
    }
  })
}

describe('fetchText', () => {
  it('returns body on 200', async () => {
    const f = fakeFetch({ 'https://x/ok.yml': { body: 'hello' } })
    const text = await fetchText('https://x/ok.yml', 1000, f)
    expect(text).toBe('hello')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('throws on non-2xx', async () => {
    const f = fakeFetch({ 'https://x/nope.yml': { status: 404 } })
    await expect(fetchText('https://x/nope.yml', 1000, f)).rejects.toThrow('HTTP 404')
  })

  it('propagates network errors', async () => {
    const f = fakeFetch({ 'https://x/dead.yml': { reject: true } })
    await expect(fetchText('https://x/dead.yml', 1000, f)).rejects.toThrow('network down')
  })
})

describe('fetchHashAndSize', () => {
  it('returns the SHA512 (base64) and byte size of the response body', async () => {
    const f = fakeFetch({ 'https://x/a.exe': { bytes: ASSET_BYTES } })
    const result = await fetchHashAndSize('https://x/a.exe', 1000, f)
    expect(result.sha512).toBe(ASSET_SHA512)
    expect(result.size).toBe(ASSET_SIZE)
  })

  it('throws on HTTP error so the caller surfaces a finding', async () => {
    const f = fakeFetch({ 'https://x/missing.exe': { status: 500 } })
    await expect(fetchHashAndSize('https://x/missing.exe', 1000, f)).rejects.toThrow('HTTP 500')
  })
})

describe('headOk', () => {
  it('returns true for a reachable asset', async () => {
    const f = fakeFetch({ 'HEAD https://x/a.exe': { status: 200 } })
    expect(await headOk('https://x/a.exe', 1000, f)).toBe(true)
  })

  it('returns false for a 404', async () => {
    const f = fakeFetch({ 'HEAD https://x/missing.exe': { status: 404 } })
    expect(await headOk('https://x/missing.exe', 1000, f)).toBe(false)
  })

  it('returns false when fetch throws (network)', async () => {
    const f = fakeFetch({ 'HEAD https://x/dead.exe': { reject: true } })
    expect(await headOk('https://x/dead.exe', 1000, f)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// runValidation — the orchestrator that powers the CLI.
// ---------------------------------------------------------------------------
describe('runValidation', () => {
  const BASE = 'https://example.com/releases/download'
  const V = 'v1.11.15'
  const releaseBase = `${BASE}/${V}`

  it('returns exitCode 2 when version or base is missing', async () => {
    const f = vi.fn()
    const r1 = await runValidation({ version: '', base: BASE, fetchImpl: f })
    expect(r1.exitCode).toBe(2)
    expect(r1.log.some((l: string) => l.startsWith('usage:'))).toBe(true)
    expect(f).not.toHaveBeenCalled()

    const r2 = await runValidation({ version: V, base: '', fetchImpl: f })
    expect(r2.exitCode).toBe(2)
  })

  it('returns exitCode 1 when no latest*.yml files are reachable', async () => {
    const f = fakeFetch({})
    const r = await runValidation({ version: V, base: BASE, fetchImpl: f })
    expect(r.exitCode).toBe(1)
    expect(r.log.some((l: string) => l.includes('no latest*.yml files were reachable'))).toBe(true)
  })

  it('succeeds (exit 0) when a single platform yml is valid and its asset is reachable', async () => {
    const f = fakeFetch({
      [`${releaseBase}/latest.yml`]: { body: GOOD_YML },
      [`HEAD ${releaseBase}/Termpolis.Setup.1.11.15.exe`]: { status: 200 },
      [`${releaseBase}/Termpolis.Setup.1.11.15.exe`]: { bytes: ASSET_BYTES },
    })
    const r = await runValidation({ version: V, base: BASE, fetchImpl: f })
    expect(r.findings).toEqual([])
    expect(r.exitCode).toBe(0)
    expect(r.log.some((l: string) => l.startsWith('OK:'))).toBe(true)
  })

  it('strips a trailing slash from base', async () => {
    const f = fakeFetch({
      [`${releaseBase}/latest.yml`]: { body: GOOD_YML },
      [`HEAD ${releaseBase}/Termpolis.Setup.1.11.15.exe`]: { status: 200 },
      [`${releaseBase}/Termpolis.Setup.1.11.15.exe`]: { bytes: ASSET_BYTES },
    })
    const r = await runValidation({ version: V, base: `${BASE}/`, fetchImpl: f })
    expect(r.exitCode).toBe(0)
  })

  it('flags an unreachable asset URL', async () => {
    const f = fakeFetch({
      [`${releaseBase}/latest.yml`]: { body: GOOD_YML },
      [`HEAD ${releaseBase}/Termpolis.Setup.1.11.15.exe`]: { status: 404 },
    })
    const r = await runValidation({ version: V, base: BASE, fetchImpl: f })
    expect(r.exitCode).toBe(1)
    expect(r.findings.some((x: string) => x.includes('asset not reachable'))).toBe(true)
  })

  it('flags a YAML parse error without blowing up', async () => {
    const f = fakeFetch({ [`${releaseBase}/latest.yml`]: { body: ': : : not yaml\n  : :' } })
    const r = await runValidation({ version: V, base: BASE, fetchImpl: f })
    expect(r.exitCode).toBe(1)
    expect(r.findings.some((x: string) => x.includes('YAML parse error'))).toBe(true)
  })

  it('flags a version mismatch from the parsed yml', async () => {
    const badVersionYml = GOOD_YML.replace('version: 1.11.15', 'version: 1.11.14')
    const f = fakeFetch({
      [`${releaseBase}/latest.yml`]: { body: badVersionYml },
      [`HEAD ${releaseBase}/Termpolis.Setup.1.11.15.exe`]: { status: 200 },
    })
    const r = await runValidation({ version: V, base: BASE, fetchImpl: f })
    expect(r.exitCode).toBe(1)
    expect(r.findings.some((x: string) => x.includes('version mismatch'))).toBe(true)
  })

  it('skips missing platform ymls but still succeeds if at least one is valid', async () => {
    const f = fakeFetch({
      [`${releaseBase}/latest.yml`]: { body: GOOD_YML },
      [`HEAD ${releaseBase}/Termpolis.Setup.1.11.15.exe`]: { status: 200 },
      [`${releaseBase}/Termpolis.Setup.1.11.15.exe`]: { bytes: ASSET_BYTES },
      // latest-mac.yml and latest-linux.yml return 404 by default
    })
    const r = await runValidation({ version: V, base: BASE, fetchImpl: f })
    expect(r.exitCode).toBe(0)
    expect(r.log.some((l: string) => l.includes('latest-mac.yml') && l.includes('skip'))).toBe(true)
    expect(r.log.some((l: string) => l.includes('latest-linux.yml') && l.includes('skip'))).toBe(true)
  })

  it('flags an asset whose actual SHA512 does not match the YAML claim (the v1.11.23/24 bug)', async () => {
    // YAML claims one hash, asset bytes hash to something different (the
    // exact mismatch the post-signing release pipeline produced).
    const f = fakeFetch({
      [`${releaseBase}/latest.yml`]: { body: GOOD_YML },
      [`HEAD ${releaseBase}/Termpolis.Setup.1.11.15.exe`]: { status: 200 },
      [`${releaseBase}/Termpolis.Setup.1.11.15.exe`]: { bytes: Buffer.from('different-bytes-after-signing') },
    })
    const r = await runValidation({ version: V, base: BASE, fetchImpl: f })
    expect(r.exitCode).toBe(1)
    expect(r.findings.some((x: string) => x.includes('sha512 mismatch'))).toBe(true)
  })

  it('flags an asset whose actual size does not match the YAML claim', async () => {
    const wrongSizeYml = GOOD_YML.replace(`size: ${ASSET_SIZE}`, 'size: 999999')
    const f = fakeFetch({
      [`${releaseBase}/latest.yml`]: { body: wrongSizeYml },
      [`HEAD ${releaseBase}/Termpolis.Setup.1.11.15.exe`]: { status: 200 },
      [`${releaseBase}/Termpolis.Setup.1.11.15.exe`]: { bytes: ASSET_BYTES },
    })
    const r = await runValidation({ version: V, base: BASE, fetchImpl: f })
    expect(r.exitCode).toBe(1)
    expect(r.findings.some((x: string) => x.includes('size mismatch'))).toBe(true)
  })

  it('passes the byte-level check when YAML and asset agree', async () => {
    const f = fakeFetch({
      [`${releaseBase}/latest.yml`]: { body: GOOD_YML },
      [`HEAD ${releaseBase}/Termpolis.Setup.1.11.15.exe`]: { status: 200 },
      [`${releaseBase}/Termpolis.Setup.1.11.15.exe`]: { bytes: ASSET_BYTES },
    })
    const r = await runValidation({ version: V, base: BASE, fetchImpl: f })
    expect(r.findings).toEqual([])
    expect(r.exitCode).toBe(0)
  })

  it('aggregates findings across multiple platform ymls', async () => {
    const winYml = GOOD_YML.replace('version: 1.11.15', 'version: 1.11.14')
    // mac yml references a different (unreachable) asset
    const macYml = GOOD_YML.replace(/Termpolis\.Setup\.1\.11\.15\.exe/g, 'Termpolis-1.11.15.dmg')
    const f = fakeFetch({
      [`${releaseBase}/latest.yml`]: { body: winYml },
      [`HEAD ${releaseBase}/Termpolis.Setup.1.11.15.exe`]: { status: 200 },
      [`${releaseBase}/latest-mac.yml`]: { body: macYml },
      // HEAD for mac's dmg is NOT mapped, so it defaults to 404
    })
    const r = await runValidation({ version: V, base: BASE, fetchImpl: f })
    expect(r.exitCode).toBe(1)
    expect(r.findings.some((x: string) => x.startsWith('latest.yml:') && x.includes('version mismatch'))).toBe(true)
    expect(r.findings.some((x: string) => x.startsWith('latest-mac.yml:') && x.includes('asset not reachable'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Draft-release validation (--dir / --strict), added after v1.39.0 published
// live with no latest-mac.yml at all. Two separate defects made that possible:
// the gate job was `needs: build` so it was SKIPPED when a build failed, and
// the validator itself treated a wholly-absent manifest as a skip, not a
// failure — so it would have passed the broken release even had it run.
// ---------------------------------------------------------------------------

/** Real temp dir, real files — the point is to exercise the actual fs path. */
function tmpDir(): string {
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'validate-yml-'))
}

describe('makeDirFetch', () => {
  it('serves a file by the URL last segment, ignoring the directory part', async () => {
    const dir = tmpDir()
    fs.writeFileSync(nodePath.join(dir, 'latest.yml'), GOOD_YML)
    const f = makeDirFetch(dir)
    const res = await f('https://github.com/o/r/releases/download/v1.11.15/latest.yml')
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(GOOD_YML)
  })

  it('returns the exact bytes via arrayBuffer, so sha512 and size checks are real', async () => {
    const dir = tmpDir()
    fs.writeFileSync(nodePath.join(dir, 'a.exe'), ASSET_BYTES)
    const res = await makeDirFetch(dir)('local/v1/a.exe')
    const got = Buffer.from(await res.arrayBuffer())
    expect(got.equals(ASSET_BYTES)).toBe(true)
    expect(crypto.createHash('sha512').update(got).digest('base64')).toBe(ASSET_SHA512)
  })

  it('404s a file that is not there', async () => {
    const res = await makeDirFetch(tmpDir())('local/v1/missing.yml')
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
  })

  it('makes the missing response throw on read rather than return empty content', async () => {
    // An empty string would parse as valid-but-empty YAML and a zero-length
    // buffer would hash to a real digest. Both would be silently wrong.
    const res = await makeDirFetch(tmpDir())('local/v1/missing.yml')
    await expect(res.text()).rejects.toThrow('not found')
    await expect(res.arrayBuffer()).rejects.toThrow('not found')
  })

  it('refuses a url that would escape the directory', async () => {
    const dir = tmpDir()
    const outside = nodePath.join(nodePath.dirname(dir), 'outside.yml')
    fs.writeFileSync(outside, 'secret')
    // A latest*.yml can advertise any string as a url; it is not trusted input.
    const res = await makeDirFetch(dir)('local/v1/..%2Foutside.yml')
    expect(res.ok).toBe(false)
    fs.rmSync(outside, { force: true })
  })

  it('refuses a nested path rather than reading a subdirectory', async () => {
    const dir = tmpDir()
    fs.mkdirSync(nodePath.join(dir, 'sub'))
    fs.writeFileSync(nodePath.join(dir, 'sub', 'x.yml'), 'nested')
    const res = await makeDirFetch(dir)('local/v1/sub%2Fx.yml')
    expect(res.ok).toBe(false)
  })

  it('refuses a url with no filename at all', async () => {
    expect((await makeDirFetch(tmpDir())('local/v1/')).ok).toBe(false)
  })

  it('strips a query string and fragment before resolving', async () => {
    const dir = tmpDir()
    fs.writeFileSync(nodePath.join(dir, 'latest.yml'), 'v: 1')
    const f = makeDirFetch(dir)
    expect((await f('local/v1/latest.yml?token=abc')).ok).toBe(true)
    expect((await f('local/v1/latest.yml#frag')).ok).toBe(true)
  })

  it('percent-decodes a filename, since electron-builder emits encoded urls', async () => {
    const dir = tmpDir()
    fs.writeFileSync(nodePath.join(dir, 'Termpolis Setup.exe'), ASSET_BYTES)
    expect((await makeDirFetch(dir)('local/v1/Termpolis%20Setup.exe')).ok).toBe(true)
  })
})

describe('parseArgs — draft flags', () => {
  it('parses --dir and --strict', () => {
    const args = parseArgs(['--version', 'v1.2.3', '--dir', './assets', '--strict'])
    expect(args.dir).toBe('./assets')
    expect(args.strict).toBe(true)
  })

  it('defaults dir to null and strict to false', () => {
    const args = parseArgs(['--version', 'v1.2.3'])
    expect(args.dir).toBeNull()
    expect(args.strict).toBe(false)
  })

  it('ignores --dir with no value', () => {
    expect(parseArgs(['--dir']).dir).toBeNull()
  })
})

describe('buildRunOptions', () => {
  // This mapping is tested on its own because a --strict that silently failed
  // to reach runValidation would leave the gate exactly as broken as before.
  it('passes strict through and uses a dir transport when --dir is given', () => {
    const o = buildRunOptions(parseArgs(['--version', 'v1', '--dir', '.', '--strict']))
    expect(o.strict).toBe(true)
    expect(typeof o.fetchImpl).toBe('function')
  })

  it('supplies a placeholder base when only --dir is given', () => {
    // --dir needs no public URL: the transport reads by filename.
    expect(buildRunOptions(parseArgs(['--version', 'v1', '--dir', '.'])).base).toBe('local')
  })

  it('leaves fetchImpl undefined without --dir so the global fetch default applies', () => {
    const o = buildRunOptions(parseArgs(['--version', 'v1', '--base', 'https://x']))
    expect(o.fetchImpl).toBeUndefined()
    expect(o.base).toBe('https://x')
    expect(o.strict).toBe(false)
  })

  it('leaves base null when neither --base nor --dir is given, so usage is printed', () => {
    expect(buildRunOptions(parseArgs([])).base).toBeNull()
  })
})

describe('runValidation — strict mode', () => {
  const V = 'v1.11.15'

  /** A dir holding only latest.yml + its asset — mac and linux are absent. */
  function partialRelease(): string {
    const dir = tmpDir()
    fs.writeFileSync(nodePath.join(dir, 'latest.yml'), GOOD_YML)
    fs.writeFileSync(nodePath.join(dir, 'Termpolis.Setup.1.11.15.exe'), ASSET_BYTES)
    return dir
  }

  it('REGRESSION: without strict, a release missing two of three manifests passes', async () => {
    // This is precisely what v1.39.0 shipped, and precisely why the gate as
    // written could not have caught it. Asserted so the tolerance can never be
    // reintroduced by accident — it is a deliberate mode, not the default.
    const dir = partialRelease()
    const r = await runValidation({ version: V, base: 'local', fetchImpl: makeDirFetch(dir) })
    expect(r.exitCode).toBe(0)
    expect(r.log.some((l: string) => l.includes('(skip:'))).toBe(true)
  })

  it('fails a release missing a platform manifest', async () => {
    const dir = partialRelease()
    const r = await runValidation({ version: V, base: 'local', strict: true, fetchImpl: makeDirFetch(dir) })
    expect(r.exitCode).toBe(1)
    expect(r.findings).toEqual([
      expect.stringContaining('latest-mac.yml: not reachable'),
      expect.stringContaining('latest-linux.yml: not reachable'),
    ])
  })

  it('passes a complete release under strict', async () => {
    const dir = partialRelease()
    for (const n of ['latest-mac.yml', 'latest-linux.yml']) {
      fs.writeFileSync(nodePath.join(dir, n), GOOD_YML)
    }
    const r = await runValidation({ version: V, base: 'local', strict: true, fetchImpl: makeDirFetch(dir) })
    expect(r.exitCode).toBe(0)
    expect(r.findings).toEqual([])
  })

  it('still catches a corrupted asset through the dir transport', async () => {
    // The draft gate must do the full byte check, not just an existence check:
    // the v1.11.23/24 break was a digest that no longer matched the bytes.
    const dir = tmpDir()
    for (const n of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) {
      fs.writeFileSync(nodePath.join(dir, n), GOOD_YML)
    }
    fs.writeFileSync(nodePath.join(dir, 'Termpolis.Setup.1.11.15.exe'), Buffer.from('re-signed-bytes'))
    const r = await runValidation({ version: V, base: 'local', strict: true, fetchImpl: makeDirFetch(dir) })
    expect(r.exitCode).toBe(1)
    expect(r.findings.some((x: string) => x.includes('sha512 mismatch'))).toBe(true)
    expect(r.findings.some((x: string) => x.includes('size mismatch'))).toBe(true)
  })

  it('reports every missing manifest when the whole release is empty', async () => {
    const r = await runValidation({ version: V, base: 'local', strict: true, fetchImpl: makeDirFetch(tmpDir()) })
    expect(r.exitCode).toBe(1)
    expect(r.findings).toHaveLength(3)
  })
})

describe('usageError', () => {
  // Found by adversarial review of the draft-gate change: parseArgs dropped
  // unrecognized tokens in silence, so `--strict=true` and `-strict` -- both
  // natural things to write in a workflow file -- validated a release that was
  // missing two of three manifests and printed "OK". The gate's strictness rode
  // on a string nothing checked.
  it('rejects a --strict typo instead of silently disarming the gate', () => {
    expect(usageError(parseArgs(['--version', 'v1', '--dir', '.', '--strict=true']))).toContain('--strict=true')
    expect(usageError(parseArgs(['--version', 'v1', '--dir', '.', '-strict']))).toContain('-strict')
    expect(usageError(parseArgs(['--version', 'v1', '--dir', '.', '--Strict']))).toContain('--Strict')
  })

  it('rejects a --dir typo, which would otherwise fall back to a network fetch', () => {
    expect(usageError(parseArgs(['--version', 'v1', '--dirr', './assets']))).toContain('--dirr')
  })

  it('names every unrecognized token, not just the first', () => {
    const e = usageError(parseArgs(['--nope', '--also-nope']))
    expect(e).toContain('--nope')
    expect(e).toContain('--also-nope')
  })

  it('returns null for a well-formed draft invocation', () => {
    expect(usageError(parseArgs(['--version', 'v1', '--dir', './a', '--strict']))).toBeNull()
  })

  it('returns null for a well-formed public invocation', () => {
    expect(usageError(parseArgs(['--version', 'v1', '--base', 'https://x', '--strict', '--timeout', '900']))).toBeNull()
  })

  it('treats a flag missing its value as a usage error rather than a silent default', () => {
    // `--version` with nothing after it used to leave version null and fall
    // through to the usage message; now the token itself is reported.
    expect(usageError(parseArgs(['--version']))).toContain('--version')
  })
})

describe('runValidation — nothing reachable', () => {
  it('names the missing manifests instead of printing one unactionable line', async () => {
    // The early return for "no manifest reachable" reported findings to the
    // caller but never logged them, so CI showed a single line and the detail
    // died with the process.
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'validate-yml-empty-'))
    const r = await runValidation({ version: 'v1.11.15', base: 'local', strict: true, fetchImpl: makeDirFetch(dir) })
    expect(r.exitCode).toBe(1)
    expect(r.log.some((l: string) => l.includes('no latest*.yml files were reachable'))).toBe(true)
    for (const n of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) {
      expect(r.log.some((l: string) => l.startsWith(' - ') && l.includes(n))).toBe(true)
    }
  })
})

describe('release.yml invokes the validator with flags it actually accepts', () => {
  // The unit tests above start from parseArgs([...]) written by hand, which
  // proves nothing about the string sitting in the workflow file. This reads
  // the real invocations out of release.yml and pushes them through the real
  // parser, so a typo like `--strict=true` fails here rather than by quietly
  // publishing an incomplete release months from now.
  const workflow = fs.readFileSync(nodePath.join(process.cwd(), '.github/workflows/release.yml'), 'utf8')

  /** Every command line in release.yml that runs the validator. */
  const invocations = workflow
    .split(/\r?\n/)
    .map(l => l.trim())
    // Must be an actual invocation: release.yml's own comments name the script
    // too, and a prose mention is not a command line.
    .filter(l => !l.startsWith('#') && l.includes('node scripts/validateLatestYml.cjs'))

  /** Shell line -> argv, with the wrapping `if ...; then` and quotes removed. */
  function toArgv(line: string): string[] {
    return line
      .slice(line.indexOf('validateLatestYml.cjs') + 'validateLatestYml.cjs'.length)
      .replace(/;\s*then\s*$/, '')
      .trim()
      .split(/\s+/)
      .map(t => t.replace(/^"|"$/g, ''))
      .filter(Boolean)
  }

  it('invokes the validator in exactly two places — the draft gate and the public gate', () => {
    expect(invocations).toHaveLength(2)
  })

  it('passes only flags the parser recognizes', () => {
    for (const line of invocations) {
      expect(usageError(parseArgs(toArgv(line)))).toBeNull()
    }
  })

  it('passes --strict everywhere, so neither gate can tolerate a missing manifest', () => {
    for (const line of invocations) {
      expect(parseArgs(toArgv(line)).strict).toBe(true)
    }
  })

  it('uses the local transport for the draft gate and a public base for the live gate', () => {
    const parsed = invocations.map(l => parseArgs(toArgv(l)))
    expect(parsed.filter(a => a.dir !== null)).toHaveLength(1)
    expect(parsed.filter(a => a.base !== null)).toHaveLength(1)
  })
})

describe('release.yml cannot ship to users before the gate runs', () => {
  // Every assertion here is a defect that actually shipped or was one edit
  // away from shipping. They are structural, not stylistic: each one names a
  // path by which bytes reach a user without having passed validate-draft.
  const yaml = require('js-yaml')
  const wf = yaml.load(
    fs.readFileSync(nodePath.join(process.cwd(), '.github/workflows/release.yml'), 'utf8'),
  ) as { jobs: Record<string, { needs?: string | string[]; steps?: Array<Record<string, unknown>> }> }

  const stepText = (job: string) =>
    (wf.jobs[job].steps ?? []).map(s => String(s.run ?? '')).join('\n')

  it('forces an already-existing release back to a draft instead of reusing it as-is', () => {
    // action-gh-release's update path sends `draft: existingRelease.draft` and
    // never reads the `draft:` input, so once a release is public NOTHING
    // downstream can pull it back. Re-running a workflow whose release had
    // already published would swap freshly-built assets onto a live release,
    // then skip every gate below if any build failed.
    expect(stepText('create-release')).toMatch(/gh release edit "\$TAG" --draft=true/)
  })

  it('creates the release as a draft', () => {
    expect(stepText('create-release')).toMatch(/gh release create .*--draft/)
  })

  it('publishes and live-verifies in ONE job, so re-running the job re-publishes', () => {
    // Split across two jobs, a retract was a one-way door: `gh run rerun
    // --failed` re-runs only failed jobs and their dependents, and the publish
    // job had SUCCEEDED -- so the re-run verified a release nothing would ever
    // re-publish, 404'd, and re-retracted forever.
    const t = stepText('publish-release')
    expect(t).toMatch(/gh release edit "\$\{GITHUB_REF_NAME\}" --draft=false/)
    expect(t).toMatch(/gh release edit "\$\{GITHUB_REF_NAME\}" --draft=true/)
    expect(t).toContain('validateLatestYml.cjs')
  })

  it('scopes the retract to the validator, not to the whole job', () => {
    // A bare `if: failure()` also fires when checkout or npm install dies,
    // un-publishing a validated release because a runner had a bad minute.
    const retract = (wf.jobs['publish-release'].steps ?? []).find(s =>
      String(s.run ?? '').includes('--draft=true'),
    )
    expect(String(retract?.if)).toBe("failure() && steps.live_check.outcome == 'failure'")
  })

  it('keeps every end-user channel out of the build job', () => {
    // Chocolatey rewrites chocolateyinstall.ps1 to point at
    // releases/download/v$version/... -- a URL a DRAFT does not serve. Run from
    // inside `build`, a listing went public whose installer 404s permanently
    // whenever another platform's build failed.
    const build = stepText('build')
    expect(build).not.toContain('choco push')
    expect(build).not.toContain('ftp://')
  })

  it('ships those channels only after the release is published and verified', () => {
    const ship = wf.jobs['publish-windows-channels']
    expect(ship.needs).toBe('publish-release')
    expect(stepText('publish-windows-channels')).toContain('choco push')
    expect(stepText('publish-windows-channels')).toContain('ftp://')
  })

  it('hashes the installer users actually download, not a build workspace copy', () => {
    expect(stepText('publish-windows-channels')).toMatch(/gh release download/)
  })

  it('gates every post-release job on the verified publish', () => {
    for (const job of ['publish-windows-channels', 'bump-homebrew-tap']) {
      expect(wf.jobs[job].needs).toBe('publish-release')
    }
  })
})
