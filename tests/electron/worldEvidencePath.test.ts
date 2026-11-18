import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EVIDENCE_PATH_ESCAPES, evidenceRef } from '../../src/main/world/evidencePath'

const noReal = async (p: string): Promise<string> => p
const failReal = async (): Promise<string> => {
  throw new Error('ENOENT')
}

describe('evidenceRef', () => {
  const made: string[] = []
  afterEach(async () => {
    for (const d of made.splice(0)) await rm(d, { recursive: true, force: true })
  })

  it('makes a path inside the root relative, with forward slashes, even when it does not exist', async () => {
    expect(await evidenceRef('/repo/src/a.ts', '/repo', { realpath: noReal, isWindows: false })).toBe('src/a.ts')
    expect(await evidenceRef('/repo/src/gone.ts', '/repo', { realpath: failReal, isWindows: false })).toBe('src/gone.ts')
  })

  it('judges a file that does not exist by its written path when the root is a link elsewhere', async () => {
    const realRoot = async (p: string): Promise<string> => {
      if (p === resolve('/repo')) return resolve('/real/repo')
      throw new Error('ENOENT')
    }
    expect(await evidenceRef('/repo/src/new.ts', '/repo', { realpath: realRoot, isWindows: false })).toBe('src/new.ts')
    expect(await evidenceRef('/real/repo/src/new.ts', '/repo', { realpath: realRoot, isWindows: false })).toBe('src/new.ts')
  })

  it('drops a path outside the root, the root itself, and an absolute path when there is no root', async () => {
    expect(await evidenceRef('/other/a.ts', '/repo', { realpath: noReal, isWindows: false })).toBeNull()
    expect(await evidenceRef('/repo/../other/a.ts', '/repo', { realpath: noReal, isWindows: false })).toBeNull()
    expect(await evidenceRef('/repo', '/repo', { realpath: noReal, isWindows: false })).toBeNull()
    expect(await evidenceRef('/repo/a.ts', null, { realpath: noReal, isWindows: false })).toBeNull()
    expect(await evidenceRef('D:\\x\\a.ts', '/repo', { realpath: noReal, isWindows: false })).toBeNull()
  })

  it('keeps a relative ref, normalized, and refuses one that escapes the root', async () => {
    expect(await evidenceRef('src\\a\\..\\b.ts', '/repo', { realpath: noReal, isWindows: false })).toBe('src/b.ts')
    expect(await evidenceRef('src/b.ts', null)).toBe('src/b.ts')
    await expect(evidenceRef('../x', '/repo', { realpath: noReal })).rejects.toThrow(EVIDENCE_PATH_ESCAPES)
    await expect(evidenceRef('..', null)).rejects.toThrow(EVIDENCE_PATH_ESCAPES)
    await expect(evidenceRef('a/../../x', null)).rejects.toThrow(EVIDENCE_PATH_ESCAPES)
    expect(await evidenceRef('.', '/repo', { realpath: noReal, isWindows: false })).toBeNull()
  })

  it('on Windows compares case-insensitively', async () => {
    if (process.platform !== 'win32') return
    expect(await evidenceRef('C:\\Repo\\src\\a.ts', 'c:\\repo', { realpath: noReal, isWindows: true })).toBe('src/a.ts')
    expect(await evidenceRef('D:\\x\\a.ts', 'C:\\repo', { realpath: noReal, isWindows: true })).toBeNull()
  })

  it('compares real paths: an alias of the root is inside, and a link that leaves is dropped or refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'evpath-'))
    made.push(dir)
    const root = join(dir, 'root')
    const out = join(dir, 'out')
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(out)
    await writeFile(join(root, 'src', 'a.ts'), 'x')
    await writeFile(join(out, 'o.ts'), 'x')
    expect(await evidenceRef(join(root, 'src', 'a.ts'), root)).toBe('src/a.ts')
    let linked = true
    try {
      await symlink(out, join(root, 'link'), 'junction')
      await symlink(root, join(dir, 'alias'), 'junction')
    } catch {
      linked = false
    }
    if (!linked) return
    expect(await evidenceRef(join(dir, 'alias', 'src', 'a.ts'), root)).toBe('src/a.ts')
    expect(await evidenceRef(join(root, 'link', 'o.ts'), root)).toBeNull()
    await expect(evidenceRef('link/o.ts', root)).rejects.toThrow(EVIDENCE_PATH_ESCAPES)
  })
})
