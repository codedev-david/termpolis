// discoverRepoFiles with git answered by a mock: the cases real git will not produce on demand (a submodule listing
// that fails, names that are not valid UTF-8, nested repositories past the cap).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const answers = vi.hoisted(() => ({ fn: null as null | ((args: string[]) => string) }))
vi.mock('../../src/main/gitCommand', () => ({
  safeGitAsync: vi.fn(async (args: string[]) => (answers.fn as (a: string[]) => string)(args))
}))

import { discoverRepoFiles, repoListingNotes } from '../../src/main/codeIngest'
import { MAP_FILE_CAP } from '../../src/main/repoFileList'

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-mock-'))
})
afterEach(() => {
  answers.fn = null
  fs.rmSync(root, { recursive: true, force: true })
})

const rel = (files: string[]): string[] => files.map((f) => path.relative(root, f).split(path.sep).join('/')).sort()

describe('discoverRepoFiles (git mocked)', () => {
  it('keeps the own listing when the submodule listing fails', async () => {
    fs.writeFileSync(path.join(root, '.gitmodules'), '[submodule "libs/shared"]\n\tpath = libs/shared\n')
    answers.fn = (args) => {
      if (args.includes('--recurse-submodules')) throw Object.assign(new Error('fatal: not a git repository: libs/shared/.git'), { code: 128 })
      return 'H .gitmodules\0H libs/shared\0H src/a.ts\0? src/b.ts\0'
    }
    expect(rel(await discoverRepoFiles(root))).toEqual(['.gitmodules', 'libs/shared', 'src/a.ts', 'src/b.ts'])
    expect(repoListingNotes(root)).toEqual({ nestedCapped: false, unreadable: [], nested: [] })
  })

  it('lists nothing when git refuses the folder, and keeps no notes for it', async () => {
    answers.fn = () => {
      throw Object.assign(new Error('fatal: not a git repository'), { code: 128 })
    }
    expect(await discoverRepoFiles(root)).toEqual([])
    expect(repoListingNotes(root)).toBeNull()
  })

  it('notes the names it could not read and nested repositories past the cap, under any spelling of the root', async () => {
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: elsewhere\n')
    fs.mkdirSync(path.join(root, 'big'))
    fs.writeFileSync(path.join(root, 'big', '.git'), 'gitdir: elsewhere\n')
    const many = Array.from({ length: MAP_FILE_CAP + 1 }, (_, i) => `H f${i}.ts`).join('\0')
    answers.fn = (args) => (args[args.indexOf('-C') + 1].endsWith('big') ? `${many}\0` : 'H a.ts\0H b�.ts\0? big/\0')
    const files = await discoverRepoFiles(root)
    expect(files.length).toBe(1 + MAP_FILE_CAP)
    const notes = repoListingNotes(`${root.replace(/\\/g, '/')}/`)
    expect(notes?.nestedCapped).toBe(true)
    expect(notes?.unreadable).toEqual(['b�.ts'])
    expect(notes?.nested).toEqual(['big'])
    // Another spelling of the root by case finds the notes only where the file system folds case.
    const upper = repoListingNotes(root.replace(/\\/g, '/').toUpperCase())
    if (process.platform === 'win32' || process.platform === 'darwin') expect(upper).toBe(notes)
    else expect(upper).toBeNull()
  })

  it('folds the notes key to lower case only on Windows and macOS', async () => {
    answers.fn = () => 'H a.ts\0'
    const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor
    try {
      for (const [os, folds] of [['linux', false], ['win32', true], ['darwin', true]] as const) {
        Object.defineProperty(process, 'platform', { value: os })
        const at = `${root}${os}/Repo`
        await discoverRepoFiles(at)
        expect(repoListingNotes(at)).not.toBeNull()
        expect(repoListingNotes(at.toLowerCase()) !== null).toBe(folds)
      }
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('walks a nested repository git refuses as a plain folder, by the same rules: skip folders, its own .gitignore, the cap', async () => {
    fs.mkdirSync(path.join(root, 'refused', 'src'), { recursive: true })
    fs.mkdirSync(path.join(root, 'refused', 'node_modules', 'p'), { recursive: true })
    fs.mkdirSync(path.join(root, 'refused', 'gen'), { recursive: true })
    fs.writeFileSync(path.join(root, 'refused', '.git'), 'gitdir: elsewhere\n')
    fs.writeFileSync(path.join(root, 'refused', '.gitignore'), 'gen/\n')
    fs.writeFileSync(path.join(root, 'refused', 'src', 'r.ts'), 'x')
    fs.writeFileSync(path.join(root, 'refused', 'src', 'app.bundle.js'), 'x')
    fs.writeFileSync(path.join(root, 'refused', 'node_modules', 'p', 'i.js'), 'x')
    fs.writeFileSync(path.join(root, 'refused', 'gen', 'g.ts'), 'x')
    // A second one with no .gitignore of its own: everything outside the skipped folders.
    fs.mkdirSync(path.join(root, 'plain', 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(root, 'plain', '.git'), 'gitdir: elsewhere\n')
    fs.writeFileSync(path.join(root, 'plain', 'p.ts'), 'x')
    fs.writeFileSync(path.join(root, 'plain', 'node_modules', 'n.js'), 'x')
    answers.fn = (args) => {
      const at = args[args.indexOf('-C') + 1]
      if (args.includes('--git-common-dir')) return `${at}/.git\n`
      if (at.endsWith('refused') || at.endsWith('plain')) throw Object.assign(new Error('fatal: detected dubious ownership'), { code: 128 })
      return 'H a.ts\0? refused/\0? plain/\0? missing/\0'
    }
    expect(rel(await discoverRepoFiles(root))).toEqual(['a.ts', 'plain/p.ts', 'refused/.gitignore', 'refused/src/r.ts'])
    expect(repoListingNotes(root)?.nested).toEqual(['plain', 'refused'])
  })
})
