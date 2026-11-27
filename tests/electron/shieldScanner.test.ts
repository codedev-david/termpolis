// The Commit Shield scanner's stable copy (I1, holdb-review): a hook names a copy in userData, not the app's own folder,
// which an AppImage, a snap revision or a translocated macOS app does not keep.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { keepScannerCopy, refreshScannerCopy, SHIELD_SCANNER_FILES, type ScannerCopyDeps } from '../../src/main/shieldScanner'

const SRC = '/app/resources/mcp-adapter'
const DEST = '/home/me/.config/termpolis/commit-shield'

function fakeFs(seed: Record<string, string>) {
  const files = new Map(Object.entries(seed))
  const ops: string[] = []
  const deps: ScannerCopyDeps = {
    read: (p) => files.get(p) ?? null,
    write: (p, d) => { files.set(p, d); ops.push(`write ${p}`) },
    rename: (a, b) => { files.set(b, files.get(a)!); files.delete(a); ops.push(`rename ${b}`) },
  }
  return { files, ops, deps }
}
const shipped = (v: string): Record<string, string> =>
  Object.fromEntries(SHIELD_SCANNER_FILES.map((f) => [join(SRC, f), `${f} ${v}`]))

describe('keepScannerCopy', () => {
  it('copies every file the scanner loads, the entry file last, and answers the copy', () => {
    const fs = fakeFs(shipped('v1'))
    expect(keepScannerCopy(SRC, DEST, fs.deps)).toBe(join(DEST, 'termpolis-githook.cjs'))
    for (const f of SHIELD_SCANNER_FILES) expect(fs.files.get(join(DEST, f))).toBe(`${f} v1`)
    expect(fs.ops.at(-1)).toBe(`rename ${join(DEST, 'termpolis-githook.cjs')}`)
    expect([...fs.files.keys()].some((k) => k.endsWith('.tmp'))).toBe(false)
  })

  it('leaves a copy that is already the same alone, and rewrites only what an update changed', () => {
    const fs = fakeFs(shipped('v1'))
    keepScannerCopy(SRC, DEST, fs.deps)
    fs.ops.length = 0
    expect(keepScannerCopy(SRC, DEST, fs.deps)).toBe(join(DEST, 'termpolis-githook.cjs'))
    expect(fs.ops).toEqual([])
    fs.files.set(join(SRC, 'secretRules.cjs'), 'secretRules.cjs v2')
    keepScannerCopy(SRC, DEST, fs.deps)
    expect(fs.ops).toEqual([`write ${join(DEST, 'secretRules.cjs')}.tmp`, `rename ${join(DEST, 'secretRules.cjs')}`])
  })

  it('answers null when a shipped file is missing or a write fails, so the hook names the shipped scanner', () => {
    const missing = fakeFs(shipped('v1'))
    missing.files.delete(join(SRC, 'binPath.cjs'))
    expect(keepScannerCopy(SRC, DEST, missing.deps)).toBeNull()
    const full = fakeFs(shipped('v1'))
    expect(keepScannerCopy(SRC, DEST, { ...full.deps, write: () => { throw new Error('EACCES') } })).toBeNull()
  })

  it('refreshScannerCopy brings a copy that is there up to date, and makes none where Protect never made one', () => {
    const src = (): string => SRC
    const dest = (): string => DEST
    const none = fakeFs(shipped('v1'))
    expect(refreshScannerCopy(true, src, dest, none.deps)).toBe(false)
    expect(none.ops).toEqual([])
    const fs = fakeFs(shipped('v1'))
    keepScannerCopy(SRC, DEST, fs.deps)
    fs.files.set(join(SRC, 'termpolis-githook.cjs'), 'termpolis-githook.cjs v2')
    expect(refreshScannerCopy(false, src, dest, fs.deps)).toBe(false) // a dev build leaves it alone
    expect(fs.files.get(join(DEST, 'termpolis-githook.cjs'))).toBe('termpolis-githook.cjs v1')
    expect(refreshScannerCopy(true, src, dest, fs.deps)).toBe(true)
    expect(fs.files.get(join(DEST, 'termpolis-githook.cjs'))).toBe('termpolis-githook.cjs v2')
    fs.files.delete(join(SRC, 'dataDir.cjs'))
    expect(refreshScannerCopy(true, src, dest, fs.deps)).toBe(false)
    // It runs in the middle of the app's start, so a folder that can't be named is false, never a throw.
    expect(refreshScannerCopy(true, src, () => { throw new Error('no userData') }, fs.deps)).toBe(false)
  })

  // The list has to be the scanner's whole closure: a copy missing a file it requires would fail to load, and the hook
  // fails open on that.
  it('lists every file termpolis-githook.cjs requires, and each of theirs', () => {
    const dir = resolve(__dirname, '../../src/mcp-adapter')
    const seen = new Set<string>()
    const walk = (name: string): void => {
      if (seen.has(name)) return
      seen.add(name)
      const text = readFileSync(join(dir, name), 'utf8')
      for (const m of text.matchAll(/require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)) walk(m[1])
    }
    walk('termpolis-githook.cjs')
    expect([...seen].sort()).toEqual([...SHIELD_SCANNER_FILES].sort())
  })
})
