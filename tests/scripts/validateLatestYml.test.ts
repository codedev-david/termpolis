import { describe, it, expect } from 'vitest'
// @ts-expect-error — untyped CJS script
import { validateParsed, parseArgs } from '../../scripts/validateLatestYml.cjs'

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
