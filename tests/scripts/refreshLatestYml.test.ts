// Verifies the post-signing latest.yml refresh that fixes the auto-update
// SHA mismatch (v1.11.23/24 regression).

import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
// @ts-expect-error — untyped CJS script
import { hashAndSize, refreshParsed, refreshOnDisk, parseArgs } from '../../scripts/refreshLatestYml.cjs'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-refresh-test-'))
}

describe('refreshLatestYml — refreshParsed (pure)', () => {
  const validYml = () => ({
    version: '1.11.25',
    files: [{ url: 'Termpolis.Setup.1.11.25.exe', sha512: 'OLD', size: 1 }],
    path: 'Termpolis.Setup.1.11.25.exe',
    sha512: 'OLD',
    releaseDate: '2026-04-29T00:00:00.000Z',
  })

  it('updates files[].sha512 and size on the matching entry', () => {
    const out = refreshParsed(validYml(), 'Termpolis.Setup.1.11.25.exe', 'NEW', 12345)
    expect(out.files[0].sha512).toBe('NEW')
    expect(out.files[0].size).toBe(12345)
  })

  it('updates the top-level sha512 when path matches the installer', () => {
    const out = refreshParsed(validYml(), 'Termpolis.Setup.1.11.25.exe', 'NEW', 12345)
    expect(out.sha512).toBe('NEW')
  })

  it('leaves top-level sha512 alone when the installer is not the primary path', () => {
    const yml = validYml()
    yml.files.push({ url: 'auxiliary.exe', sha512: 'AUX', size: 999 })
    const out = refreshParsed(yml, 'auxiliary.exe', 'NEW-AUX', 1000)
    expect(out.files[1].sha512).toBe('NEW-AUX')
    expect(out.files[1].size).toBe(1000)
    expect(out.sha512).toBe('OLD') // top-level unchanged because path != auxiliary.exe
  })

  it('returns null when no files[] entry matches the installer name', () => {
    expect(refreshParsed(validYml(), 'unknown.exe', 'X', 1)).toBeNull()
  })

  it('returns null for non-mapping input', () => {
    expect(refreshParsed(null, 'x', 'y', 1)).toBeNull()
    expect(refreshParsed('a string', 'x', 'y', 1)).toBeNull()
    expect(refreshParsed([], 'x', 'y', 1)).toBeNull()
  })

  it('returns null when files[] is missing or empty', () => {
    const yml = validYml() as any
    delete yml.files
    expect(refreshParsed(yml, 'x', 'y', 1)).toBeNull()
    expect(refreshParsed({ ...validYml(), files: [] }, 'x', 'y', 1)).toBeNull()
  })
})

describe('refreshLatestYml — hashAndSize', () => {
  it('returns the SHA512 (base64) and byte size of the file', () => {
    const dir = tmpDir()
    const file = path.join(dir, 'a.bin')
    const buf = Buffer.from('hello world')
    fs.writeFileSync(file, buf)
    const expected = crypto.createHash('sha512').update(buf).digest('base64')

    const result = hashAndSize(file)
    expect(result.sha512).toBe(expected)
    expect(result.size).toBe(buf.length)
  })
})

describe('refreshLatestYml — refreshOnDisk', () => {
  let dir: string
  let installer: string
  let yml: string

  beforeEach(() => {
    dir = tmpDir()
    installer = path.join(dir, 'Termpolis.Setup.1.11.25.exe')
    yml = path.join(dir, 'latest.yml')
  })

  it('rewrites the file on disk so YAML SHA matches the actual installer bytes', () => {
    fs.writeFileSync(installer, Buffer.from('SIGNED-INSTALLER-BYTES'))
    const expectedSha = crypto.createHash('sha512').update(fs.readFileSync(installer)).digest('base64')
    fs.writeFileSync(yml, [
      'version: 1.11.25',
      'files:',
      '  - url: Termpolis.Setup.1.11.25.exe',
      '    sha512: STALE',
      '    size: 1',
      'path: Termpolis.Setup.1.11.25.exe',
      'sha512: STALE',
      "releaseDate: '2026-04-29T00:00:00.000Z'",
    ].join('\n'))

    const result = refreshOnDisk({ installer, yml })
    expect(result.ok).toBe(true)

    const text = fs.readFileSync(yml, 'utf8')
    expect(text).toContain(`sha512: ${expectedSha}`)
    expect(text).not.toContain('STALE')
  })

  it('returns an error when the installer file is missing', () => {
    fs.writeFileSync(yml, 'version: 1.0.0\nfiles: []\n')
    const result = refreshOnDisk({ installer, yml })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/installer missing/)
  })

  it('returns an error when the yml file is missing', () => {
    fs.writeFileSync(installer, Buffer.from('x'))
    const result = refreshOnDisk({ installer, yml })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/yml missing/)
  })

  it('returns an error when the installer has no matching files[] entry', () => {
    fs.writeFileSync(installer, Buffer.from('x'))
    fs.writeFileSync(yml, [
      'version: 1.11.25',
      'files:',
      '  - url: someone-else.exe',
      '    sha512: X',
      '    size: 1',
      'path: someone-else.exe',
      'sha512: X',
    ].join('\n'))
    const result = refreshOnDisk({ installer, yml })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no files\[\]\.url entry/)
  })

  it('flags missing required arguments', () => {
    expect(refreshOnDisk({ installer: null, yml }).ok).toBe(false)
    expect(refreshOnDisk({ installer, yml: null }).ok).toBe(false)
  })

  it('returns a parse error for malformed YAML', () => {
    fs.writeFileSync(installer, Buffer.from('x'))
    fs.writeFileSync(yml, ': : : not yaml\n  : :')
    const result = refreshOnDisk({ installer, yml })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/YAML parse failed/)
  })
})

describe('refreshLatestYml — parseArgs', () => {
  it('parses --installer and --yml', () => {
    const args = parseArgs(['--installer', '/a.exe', '--yml', '/b.yml'])
    expect(args.installer).toBe('/a.exe')
    expect(args.yml).toBe('/b.yml')
  })

  it('leaves both null when nothing is passed', () => {
    const args = parseArgs([])
    expect(args.installer).toBeNull()
    expect(args.yml).toBeNull()
  })
})
