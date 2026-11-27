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

// confinedTextReader, as it is, with what each reader it makes reads recorded: a confined discovery reads its text
// files (a .git pointer, a nested repository's .gitignore, a .gitmodules) through it.
const textReads = vi.hoisted(() => ({ list: [] as Array<{ folder: string; file: string }> }))
vi.mock('../../src/main/world/folderSafety', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/world/folderSafety')>()
  return {
    ...real,
    confinedTextReader: (folder: string, ...rest: unknown[]) => {
      const read = (real.confinedTextReader as (...a: unknown[]) => (p: string) => Promise<string>)(folder, ...rest)
      return (file: string) => { textReads.list.push({ folder, file }); return read(file) }
    },
  }
})

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

  it('confined, a walked nested repository whose .gitignore is a link out of the folder takes no rules from it (Codex r4 M4)', async (ctx) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-out-'))
    try {
      fs.writeFileSync(path.join(outside, 'rules'), 'hidden.ts\n')
      fs.mkdirSync(path.join(root, 'refused'))
      fs.writeFileSync(path.join(root, 'refused', '.git'), 'gitdir: elsewhere\n')
      fs.writeFileSync(path.join(root, 'refused', 'hidden.ts'), 'x')
      fs.writeFileSync(path.join(root, 'refused', 'r.ts'), 'x')
      try {
        fs.symlinkSync(path.join(outside, 'rules'), path.join(root, 'refused', '.gitignore'), 'file')
      } catch {
        ctx.skip() // Windows without developer mode or admin cannot make file links
      }
      answers.fn = (args) => {
        const at = args[args.indexOf('-C') + 1]
        if (args.includes('--git-common-dir')) return `${at}/.git\n`
        if (at.endsWith('refused')) throw Object.assign(new Error('fatal: detected dubious ownership'), { code: 128 })
        return 'H a.ts\0? refused/\0'
      }
      // Unconfined, the linked file's rules apply: hidden.ts is left out. (The walk lists no link: the .gitignore is not.)
      expect(rel(await discoverRepoFiles(root))).toEqual(['a.ts', 'refused/r.ts'])
      // Confined to the folder, the link is not followed: no rules, so hidden.ts is listed.
      expect(rel(await discoverRepoFiles(root, { confineTo: root }))).toEqual(['a.ts', 'refused/hidden.ts', 'refused/r.ts'])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("confined, discovery reads its text files with the confined text reader of the folder (Codex r4 M3)", async () => {
    fs.mkdirSync(path.join(root, 'refused'))
    fs.writeFileSync(path.join(root, 'refused', '.git'), 'gitdir: elsewhere\n')
    fs.writeFileSync(path.join(root, 'refused', '.gitignore'), 'hidden.ts\n')
    fs.writeFileSync(path.join(root, 'refused', 'hidden.ts'), 'x')
    answers.fn = (args) => {
      const at = args[args.indexOf('-C') + 1]
      if (args.includes('--git-common-dir')) return `${at}/.git\n`
      if (at.endsWith('refused')) throw Object.assign(new Error('fatal: detected dubious ownership'), { code: 128 })
      return 'H a.ts\0? refused/\0'
    }
    textReads.list = []
    expect(rel(await discoverRepoFiles(root, { confineTo: root }))).not.toContain('refused/hidden.ts')
    const read = textReads.list.map((r) => [r.folder, path.relative(root, r.file).split(path.sep).join('/')])
    expect(read).toContainEqual([root, 'refused/.git'])
    expect(read).toContainEqual([root, 'refused/.gitignore'])
    // Unconfined: no confined reader at all.
    textReads.list = []
    await discoverRepoFiles(root)
    expect(textReads.list).toEqual([])
  })

  it('confined, a root whose real path is outside the folder lists nothing (Opus R3-n2)', async () => {
    answers.fn = () => 'H a.ts\0'
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-other-'))
    try {
      expect(rel(await discoverRepoFiles(root, { confineTo: root }))).toEqual(['a.ts'])
      expect(await discoverRepoFiles(root, { confineTo: other })).toEqual([])
      expect(await discoverRepoFiles(path.join(root, 'missing'), { confineTo: root })).toEqual([])
      expect(await discoverRepoFiles(root, { confineTo: path.join(other, 'missing') })).toEqual([])
      expect(await discoverRepoFiles('', { confineTo: root })).toEqual([])
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it('keeps the notes of the listing started last, when one started before it comes back after it (Codex r4 M2)', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    let reached!: () => void
    const atOld = new Promise<void>((r) => { reached = r })
    let phase: 'old' | 'new' = 'old'
    answers.fn = ((): string | Promise<string> => {
      if (phase === 'new') return 'H a.ts\0H new�.ts\0'
      reached()
      return held.then(() => 'H a.ts\0H old�.ts\0')
    }) as unknown as (a: string[]) => string
    const late = discoverRepoFiles(root)
    await atOld
    phase = 'new'
    await discoverRepoFiles(root)
    expect(repoListingNotes(root)?.unreadable).toEqual(['new�.ts'])
    release()
    await late
    // The late one's files still go to the sweep that asked for them; its notes do not replace the newer ones.
    expect(repoListingNotes(root)?.unreadable).toEqual(['new�.ts'])
    // A listing started after both lands as any does.
    answers.fn = () => 'H a.ts\0H last�.ts\0'
    await discoverRepoFiles(root)
    expect(repoListingNotes(root)?.unreadable).toEqual(['last�.ts'])
  })

  for (const how of ['fails', 'is refused by the confinement'] as const) {
    it(`drops the notes of a listing that comes back after a newer one that ${how} (Codex r5 2)`, async () => {
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-other-'))
      try {
        let release!: () => void
        const held = new Promise<void>((r) => { release = r })
        let reached!: () => void
        const atOld = new Promise<void>((r) => { reached = r })
        let phase: 'old' | 'new' = 'old'
        answers.fn = ((): string | Promise<string> => {
          if (phase === 'new') throw Object.assign(new Error('fatal: not a git repository'), { code: 128 })
          reached()
          return held.then(() => 'H a.ts H old�.ts ')
        }) as unknown as (a: string[]) => string
        const late = discoverRepoFiles(root)
        await atOld
        phase = 'new'
        expect(await discoverRepoFiles(root, how === 'fails' ? {} : { confineTo: other })).toEqual([])
        release()
        // Its files still go to the sweep that asked for them; its notes (the name it could not read) do not land.
        expect(rel(await late)).toEqual(['a.ts'])
        expect(repoListingNotes(root)).toBeNull()
      } finally {
        fs.rmSync(other, { recursive: true, force: true })
      }
    })
  }
})
