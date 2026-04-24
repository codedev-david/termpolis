import { describe, it, expect, vi } from 'vitest'
// @ts-expect-error — untyped CJS script
import { validateParsed, parseArgs, fetchText, headOk, runValidation } from '../../scripts/validateLatestYml.cjs'

// Realistic sha512 base64 digest length — 88 chars (64-byte digest,
// base64 with padding). Using a deterministic filler keeps snapshots
// stable while passing the length check.
const GOOD_SHA512 =
  'A'.repeat(86) + '=='

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
  `    sha512: ${'A'.repeat(86)}==`,
  '    size: 100',
  'path: Termpolis.Setup.1.11.15.exe',
  `sha512: ${'A'.repeat(86)}==`,
  "releaseDate: '2026-04-24T00:00:00.000Z'",
].join('\n')

function fakeFetch(map: Record<string, { status?: number; body?: string; ok?: boolean; reject?: boolean; method?: string }>) {
  return vi.fn(async (url: string, opts: any = {}) => {
    const method = (opts.method || 'GET').toUpperCase()
    const key = `${method} ${url}`
    const entry = map[key] ?? map[url]
    if (!entry) return { ok: false, status: 404, async text() { return '' } }
    if (entry.reject) throw new Error('network down')
    const status = entry.status ?? 200
    const ok = entry.ok ?? (status >= 200 && status < 300)
    return { ok, status, async text() { return entry.body ?? '' } }
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
      // latest-mac.yml and latest-linux.yml return 404 by default
    })
    const r = await runValidation({ version: V, base: BASE, fetchImpl: f })
    expect(r.exitCode).toBe(0)
    expect(r.log.some((l: string) => l.includes('latest-mac.yml') && l.includes('skip'))).toBe(true)
    expect(r.log.some((l: string) => l.includes('latest-linux.yml') && l.includes('skip'))).toBe(true)
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
