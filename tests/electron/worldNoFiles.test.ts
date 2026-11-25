// WP4b F-R9: a folder that gives no map says why. snapshotFromFiles marks a snapshot with no file to map with the
// reason (noFiles): the folder holds no file at all, only files in languages Lumopolis does not map, or it cannot be
// opened. whyNoFiles finds it only then, so a folder that maps pays nothing for it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { snapshotFromFiles, whyNoFiles } from '../../src/main/world/fileSnapshot'
import { FOLDER_EMPTY_MESSAGE, FOLDER_UNREADABLE_MESSAGE, FOLDER_UNSUPPORTED_MESSAGE, noFilesMessage, noFilesReasonOf } from '../../src/shared/world/types'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'world-nofiles-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const read = async (): Promise<string | null> => 'export const x = 1\n'

describe('whyNoFiles (WP4b F-R9)', () => {
  it('an empty folder, or one holding only empty folders and skipped ones, is empty', async () => {
    expect(await whyNoFiles(dir)).toBe('empty')
    await mkdir(join(dir, 'a', 'b'), { recursive: true })
    await mkdir(join(dir, 'node_modules', 'x'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'x', 'index.js'), 'x')
    expect(await whyNoFiles(dir)).toBe('empty')
  })

  it('a folder of files in no language Lumopolis maps is unsupported, however deep they are', async () => {
    await mkdir(join(dir, 'docs', 'deep'), { recursive: true })
    await writeFile(join(dir, 'docs', 'deep', 'notes.txt'), 'hello')
    expect(await whyNoFiles(dir)).toBe('unsupported')
  })

  it("source the folder's own .gitignore leaves out is no file to map: the folder is empty, not unsupported", async () => {
    await writeFile(join(dir, '.gitignore'), 'gen/' + String.fromCharCode(10))
    await mkdir(join(dir, 'gen'))
    await writeFile(join(dir, 'gen', 'a.ts'), 'export const a = 1' + String.fromCharCode(10))
    expect((await snapshotFromFiles(dir, { read })).noFiles).toBe('empty')
    // Housekeeping (dot-names) is no file of the folder's either; a plain file is.
    await mkdir(join(dir, '.vscode'))
    await writeFile(join(dir, '.vscode', 'settings.json'), '{}')
    expect(await whyNoFiles(dir)).toBe('empty')
    await writeFile(join(dir, 'gen', 'notes.md'), 'x')
    expect(await whyNoFiles(dir)).toBe('empty')
    await writeFile(join(dir, 'notes.md'), 'x')
    expect(await whyNoFiles(dir)).toBe('unsupported')
  })

  it('a folder that is gone, or a file and not a folder, is unreadable', async () => {
    expect(await whyNoFiles(join(dir, 'gone'))).toBe('unreadable')
    await writeFile(join(dir, 'f.txt'), 'x')
    expect(await whyNoFiles(join(dir, 'f.txt'))).toBe('unreadable')
  })

  it('a folder that opens but whose walk finds only unreadable names is unsupported', async () => {
    const walk = vi.fn(async () => ({ files: [], capped: false, unreadable: ['bad�.bin'] }))
    expect(await whyNoFiles(dir, { walk })).toBe('unsupported')
    expect(walk).toHaveBeenCalledWith(dir)
  })
})

describe('snapshotFromFiles marks a snapshot with nothing to map (WP4b F-R9)', () => {
  it('each reason, from the real folder', async () => {
    expect((await snapshotFromFiles(dir, { read })).noFiles).toBe('empty')
    await writeFile(join(dir, 'readme.txt'), 'hi')
    expect((await snapshotFromFiles(dir, { read })).noFiles).toBe('unsupported')
    expect((await snapshotFromFiles(join(dir, 'gone'), { read })).noFiles).toBe('unreadable')
  })

  it('a listing of files none of which maps is unsupported without a second look', async () => {
    const whyNoFiles = vi.fn(async () => 'empty' as const)
    const snap = await snapshotFromFiles('/r', { read, listFiles: async () => ['a.txt', 'b.png'], whyNoFiles })
    expect(snap.noFiles).toBe('unsupported')
    expect(whyNoFiles).not.toHaveBeenCalled()
  })

  it('an empty listing asks why, and a listing that failed does too', async () => {
    const whyNoFiles = vi.fn(async () => 'unreadable' as const)
    expect((await snapshotFromFiles('/r', { read, listFiles: async () => [], whyNoFiles })).noFiles).toBe('unreadable')
    expect((await snapshotFromFiles('/r', { read, listFiles: async () => { throw new Error('EACCES') }, whyNoFiles })).noFiles).toBe('unreadable')
    expect(whyNoFiles).toHaveBeenCalledWith('/r')
    expect(whyNoFiles).toHaveBeenCalledTimes(2)
  })

  it('a folder with a file to map is never marked, and never asks', async () => {
    await writeFile(join(dir, 'a.ts'), 'export const a = 1\n')
    const whyNoFiles = vi.fn(async () => 'empty' as const)
    const snap = await snapshotFromFiles(dir, { read, whyNoFiles })
    expect(snap.files).toEqual(['a.ts'])
    expect('noFiles' in snap).toBe(false)
    expect(whyNoFiles).not.toHaveBeenCalled()
  })

  it('every file read as absent still has its reason: the folder listed files Lumopolis maps, so it is unreadable', async () => {
    const snap = await snapshotFromFiles('/r', { read: async () => null, listFiles: async () => ['a.ts'], whyNoFiles: async () => 'empty' })
    expect(snap.files).toEqual([])
    expect(snap.noFiles).toBe('unreadable')
  })
})

describe('the words for each reason (WP4b F-R9)', () => {
  it('each reason has its own words, and the words give the reason back', () => {
    expect(noFilesMessage('empty')).toBe(FOLDER_EMPTY_MESSAGE)
    expect(noFilesMessage('unsupported')).toBe(FOLDER_UNSUPPORTED_MESSAGE)
    expect(noFilesMessage('unreadable')).toBe(FOLDER_UNREADABLE_MESSAGE)
    expect(noFilesMessage(undefined)).toBe(FOLDER_EMPTY_MESSAGE)
    for (const r of ['empty', 'unsupported', 'unreadable'] as const) expect(noFilesReasonOf(noFilesMessage(r))).toBe(r)
    expect(noFilesReasonOf('Lumopolis could not start git.')).toBeNull()
    expect(noFilesReasonOf(null)).toBeNull()
    expect(noFilesReasonOf(undefined)).toBeNull()
  })
})
