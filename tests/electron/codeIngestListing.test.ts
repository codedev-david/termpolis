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
    expect(repoListingNotes(root)).toEqual({ capped: false, unreadable: [] })
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
    const notes = repoListingNotes(`${root.replace(/\\/g, '/').toUpperCase()}/`)
    expect(notes?.capped).toBe(true)
    expect(notes?.unreadable).toEqual(['b�.ts'])
  })
})
