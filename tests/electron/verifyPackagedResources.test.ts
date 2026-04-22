/**
 * Verifier Unit Tests — Regression Guard for v1.11.5
 * ---------------------------------------------------
 * scripts/verifyPackagedResources.cjs is the LAST LINE OF DEFENSE against
 * shipping another broken installer. It runs as an electron-builder
 * afterPack hook and throws if the MCP adapter is missing from the
 * unpacked output.
 *
 * These tests construct fake `appOutDir` trees that mimic what
 * electron-builder produces for each platform, then verify:
 *   - missing adapter file throws with a clear, actionable message
 *   - 0-byte adapter file throws (a subtle failure mode)
 *   - present, non-empty adapter passes silently
 *   - resolveResourcesDir yields the correct path on Windows/Mac/Linux
 *   - The required-files list still covers the real runtime references
 *     (so if main/index.ts grows a new resource dep, this test fails until
 *     REQUIRED_RESOURCE_FILES is updated).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const verifier = require('../../scripts/verifyPackagedResources.cjs')

const REPO_ROOT = resolve(__dirname, '..', '..')

let sandbox: string

beforeEach(() => {
  sandbox = join(tmpdir(), `verify-res-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(sandbox, { recursive: true })
})

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {}
})

function makeWinFixture(appOutDir: string, includeAdapter: boolean, size = 123) {
  const res = join(appOutDir, 'resources')
  mkdirSync(join(res, 'mcp-adapter'), { recursive: true })
  if (includeAdapter) {
    writeFileSync(join(res, 'mcp-adapter', 'stdio-adapter.cjs'), 'x'.repeat(size))
  }
  return res
}

function makeMacFixture(appOutDir: string, includeAdapter: boolean) {
  const res = join(appOutDir, 'Termpolis.app', 'Contents', 'Resources')
  mkdirSync(join(res, 'mcp-adapter'), { recursive: true })
  if (includeAdapter) {
    writeFileSync(join(res, 'mcp-adapter', 'stdio-adapter.cjs'), 'x'.repeat(100))
  }
  return res
}

describe('verifyPackagedResources — resolveResourcesDir', () => {
  it('Windows: maps appOutDir/resources', () => {
    const out = '/tmp/fake/win-unpacked'
    expect(verifier.resolveResourcesDir(out, 'win32', 'Termpolis')).toBe(
      join(out, 'resources'),
    )
  })

  it('Linux: maps appOutDir/resources', () => {
    const out = '/tmp/fake/linux-unpacked'
    expect(verifier.resolveResourcesDir(out, 'linux', 'Termpolis')).toBe(
      join(out, 'resources'),
    )
  })

  it('macOS: maps appOutDir/<ProductName>.app/Contents/Resources', () => {
    const out = '/tmp/fake/mac'
    expect(verifier.resolveResourcesDir(out, 'darwin', 'Termpolis')).toBe(
      join(out, 'Termpolis.app', 'Contents', 'Resources'),
    )
  })

  it('macOS: respects a custom product filename', () => {
    const out = '/tmp/fake/mac-arm64'
    expect(verifier.resolveResourcesDir(out, 'darwin', 'MyCoolApp')).toBe(
      join(out, 'MyCoolApp.app', 'Contents', 'Resources'),
    )
  })

  it('mas (Mac App Store): same shape as darwin', () => {
    const out = '/tmp/fake/mas'
    expect(verifier.resolveResourcesDir(out, 'mas', 'Termpolis')).toBe(
      join(out, 'Termpolis.app', 'Contents', 'Resources'),
    )
  })
})

describe('verifyPackagedResources — verifyResourcesFolder', () => {
  it('passes silently when adapter exists and is non-empty (Windows layout)', () => {
    const out = join(sandbox, 'win-unpacked')
    const res = makeWinFixture(out, true)
    expect(() => verifier.verifyResourcesFolder(res)).not.toThrow()
  })

  it('passes silently when adapter exists (macOS layout)', () => {
    const out = join(sandbox, 'mac')
    const res = makeMacFixture(out, true)
    expect(() => verifier.verifyResourcesFolder(res)).not.toThrow()
  })

  it('THROWS when adapter file is missing', () => {
    const out = join(sandbox, 'win-unpacked')
    const res = makeWinFixture(out, false)
    // regression: this is exactly the v1.11.5 bug — folder exists, file doesn't
    expect(() => verifier.verifyResourcesFolder(res)).toThrow(/mcp-adapter\/stdio-adapter\.cjs/)
  })

  it('THROWS when adapter exists but is 0 bytes', () => {
    const out = join(sandbox, 'win-unpacked')
    const res = makeWinFixture(out, true, 0)
    expect(() => verifier.verifyResourcesFolder(res)).toThrow(/0 bytes/)
  })

  it('THROWS when resources directory itself does not exist', () => {
    expect(() => verifier.verifyResourcesFolder(join(sandbox, 'nope'))).toThrow(
      /Resources directory does not exist/,
    )
  })

  it('error message points at extraResources config (so next dev has a fix path)', () => {
    const out = join(sandbox, 'win-unpacked')
    const res = makeWinFixture(out, false)
    try {
      verifier.verifyResourcesFolder(res)
      throw new Error('should have thrown')
    } catch (err: any) {
      expect(err.message).toMatch(/extraResources/)
      expect(err.message).toMatch(/src\/mcp-adapter/)
    }
  })
})

describe('verifyPackagedResources — verifyFromAfterPack', () => {
  it('composes appOutDir + platform correctly (win)', () => {
    const out = join(sandbox, 'win-unpacked')
    makeWinFixture(out, true)
    expect(() =>
      verifier.verifyFromAfterPack({
        appOutDir: out,
        electronPlatformName: 'win32',
        packager: { appInfo: { productFilename: 'Termpolis' } },
      }),
    ).not.toThrow()
  })

  it('composes appOutDir + platform correctly (darwin)', () => {
    const out = join(sandbox, 'mac')
    makeMacFixture(out, true)
    expect(() =>
      verifier.verifyFromAfterPack({
        appOutDir: out,
        electronPlatformName: 'darwin',
        packager: { appInfo: { productFilename: 'Termpolis' } },
      }),
    ).not.toThrow()
  })

  it('throws with the resources path included when verification fails', () => {
    const out = join(sandbox, 'win-unpacked')
    makeWinFixture(out, false)
    expect(() =>
      verifier.verifyFromAfterPack({
        appOutDir: out,
        electronPlatformName: 'win32',
      }),
    ).toThrow(/win-unpacked/)
  })
})

describe('verifyPackagedResources — REQUIRED_RESOURCE_FILES contract', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(verifier.REQUIRED_RESOURCE_FILES)).toBe(true)
    expect(verifier.REQUIRED_RESOURCE_FILES.length).toBeGreaterThan(0)
  })

  it('includes the stdio adapter — every other check is cosmetic if this is missing', () => {
    expect(verifier.REQUIRED_RESOURCE_FILES).toContain('mcp-adapter/stdio-adapter.cjs')
  })

  it('every required file has a matching source file in the repo so the build can actually ship it', () => {
    for (const rel of verifier.REQUIRED_RESOURCE_FILES) {
      const src = rel.replace(/^mcp-adapter\//, 'src/mcp-adapter/')
      const abs = join(REPO_ROOT, src)
      expect(existsSync(abs), `source for required resource ${rel} not found at ${abs}`).toBe(true)
    }
  })
})
