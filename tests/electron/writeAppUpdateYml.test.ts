/**
 * Tests for scripts/writeAppUpdateYml.cjs — the regression guard for issue #14.
 *
 * The Windows two-phase signing build (`--win --dir` then
 * `--win nsis --prepackaged`) skips the electron-builder pack phase that writes
 * resources/app-update.yml, so v1.15.4/v1.15.5 shipped without it and Windows
 * auto-update died with "ENOENT ... app-update.yml". This script regenerates
 * the file from package.json and verifies it before upload.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

const mod = require('../../scripts/writeAppUpdateYml.cjs')

const FAKE_PKG = {
  name: 'termpolis',
  build: {
    productName: 'Termpolis',
    publish: [
      { provider: 'github', owner: 'codedev-david', repo: 'termpolis', releaseType: 'release' },
    ],
  },
}

let sandbox: string
beforeEach(() => {
  sandbox = join(tmpdir(), `appupd-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(sandbox, { recursive: true })
})
afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {}
})

describe('writeAppUpdateYml — buildAppUpdateYml', () => {
  it('emits provider/owner/repo/updaterCacheDirName from build.publish', () => {
    const yml = mod.buildAppUpdateYml(FAKE_PKG)
    expect(yml).toContain('provider: github')
    expect(yml).toContain('owner: codedev-david')
    expect(yml).toContain('repo: termpolis')
    expect(yml).toContain('updaterCacheDirName: termpolis-updater')
    expect(yml.endsWith('\n')).toBe(true)
  })

  it('derives the cache dir name from productName (matches electron-builder)', () => {
    expect(mod.updaterCacheDirName(FAKE_PKG)).toBe('termpolis-updater')
    expect(mod.updaterCacheDirName({ name: 'foo bar', build: {} })).toBe('foo bar-updater')
  })

  it('accepts publish as a bare object (not an array)', () => {
    const pkg = {
      name: 'termpolis',
      build: { productName: 'Termpolis', publish: { provider: 'github', owner: 'o', repo: 'r' } },
    }
    expect(mod.buildAppUpdateYml(pkg)).toContain('owner: o')
  })

  it('throws when publish is missing', () => {
    expect(() => mod.buildAppUpdateYml({ name: 'x', build: {} })).toThrow(/build\.publish/)
  })

  it('throws on a non-github / incomplete provider', () => {
    expect(() => mod.buildAppUpdateYml({ build: { publish: [{ provider: 's3' }] } })).toThrow(/github/)
    expect(() =>
      mod.buildAppUpdateYml({ build: { publish: [{ provider: 'github', owner: 'o' }] } }),
    ).toThrow(/owner\+repo/)
  })

  it('stays in sync with the real package.json (owner/repo)', () => {
    const realPkg = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf-8'))
    const yml = mod.buildAppUpdateYml(realPkg)
    expect(yml).toContain('owner: codedev-david')
    expect(yml).toContain('repo: termpolis')
    expect(yml).toContain('provider: github')
  })
})

describe('writeAppUpdateYml — write + verify', () => {
  it('writes app-update.yml into a resources dir', () => {
    const out = mod.writeAppUpdateYml(sandbox, FAKE_PKG)
    expect(existsSync(out)).toBe(true)
    expect(readFileSync(out, 'utf-8')).toContain('provider: github')
  })

  it('throws when the resources dir does not exist', () => {
    expect(() => mod.writeAppUpdateYml(join(sandbox, 'nope'), FAKE_PKG)).toThrow(/does not exist/)
  })

  it('verify passes for a freshly written file', () => {
    mod.writeAppUpdateYml(sandbox, FAKE_PKG)
    expect(() => mod.verifyAppUpdateYml(sandbox)).not.toThrow()
  })

  it('verify THROWS when app-update.yml is missing (the issue #14 regression)', () => {
    expect(() => mod.verifyAppUpdateYml(sandbox)).toThrow(/ENOENT|missing/)
  })

  it('verify THROWS when the file is empty', () => {
    writeFileSync(join(sandbox, 'app-update.yml'), '')
    expect(() => mod.verifyAppUpdateYml(sandbox)).toThrow(/empty/)
  })

  it('verify THROWS when a required key is absent', () => {
    writeFileSync(join(sandbox, 'app-update.yml'), 'provider: github\nowner: x\n')
    expect(() => mod.verifyAppUpdateYml(sandbox)).toThrow(/repo:/)
  })
})
