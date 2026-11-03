// A platform probe, not a unit test of our code: the assumption claudeSessionList.ts stands on.
//
// The reflect pass remembers a Claude Code project folder's transcript list and keys that memory on the FOLDER's own
// mtime: while it has not changed, only the newest few transcripts are statted again (the ones being written to).
// That is right only if a folder's mtime moves whenever a transcript is CREATED, DELETED or RENAMED in it, and does not
// need to move when one is appended to. Lane C assumed this for NTFS (the unit suites there use an injected fs); the
// 3-minute full re-stat bounds the damage if it is wrong. This file proves it on the real file system of every CI
// runner (windows-latest NTFS, macos-latest APFS, ubuntu-latest ext4/overlay), so the assumption has a spec that can
// fail instead of a line in a hand-off.
//
// It waits for the file system's clock to tick between the steps (coarse clocks: ext4 ~4 ms, HFS+ 1 s, FAT 2 s) and tries
// a few times before it fails, so a slow tick is not a false red. Scratch folder only; nothing of the user's is read.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fsp, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const mtimeOf = async (p: string): Promise<number> => (await fsp.stat(p)).mtimeMs

/** Run `change` until the mtime of `target` (a folder, or a file) is later than `before` (a coarse clock may need a second try). */
async function mtimeMovesAfter(target: string, before: number, change: (attempt: number) => Promise<void>): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(attempt === 0 ? 30 : 300)
    await change(attempt)
    if ((await mtimeOf(target)) > before) return true
  }
  return false
}

let root = ''
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'termpolis-dirmtime-')) })
afterAll(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* scratch */ } })

describe('a folder\'s mtime on this file system', () => {
  it('moves when a file is CREATED in it', async () => {
    const dir = join(root, 'create')
    await fsp.mkdir(dir)
    const before = await mtimeOf(dir)
    expect(await mtimeMovesAfter(dir, before, (i) => fsp.writeFile(join(dir, `session-${i}.jsonl`), '{}\n'))).toBe(true)
  }, 20_000)

  it('moves when a file is DELETED from it', async () => {
    const dir = join(root, 'delete')
    await fsp.mkdir(dir)
    for (let i = 0; i < 8; i++) await fsp.writeFile(join(dir, `session-${i}.jsonl`), '{}\n')
    const before = await mtimeOf(dir)
    expect(await mtimeMovesAfter(dir, before, (i) => fsp.unlink(join(dir, `session-${i}.jsonl`)))).toBe(true)
  }, 20_000)

  it('moves when a file is RENAMED in it', async () => {
    const dir = join(root, 'rename')
    await fsp.mkdir(dir)
    for (let i = 0; i < 8; i++) await fsp.writeFile(join(dir, `session-${i}.jsonl`), '{}\n')
    const before = await mtimeOf(dir)
    expect(await mtimeMovesAfter(dir, before, (i) => fsp.rename(join(dir, `session-${i}.jsonl`), join(dir, `moved-${i}.jsonl`)))).toBe(true)
  }, 20_000)

  it('control: the folder\'s mtime is a number the listing can compare (finite, positive), the file\'s own mtime moves on append', async () => {
    const dir = join(root, 'append')
    await fsp.mkdir(dir)
    const file = join(dir, 'session.jsonl')
    await fsp.writeFile(file, '{}\n')
    const dirMtime = await mtimeOf(dir)
    expect(Number.isFinite(dirMtime) && dirMtime > 0).toBe(true)
    // What the listing relies on for an APPENDED transcript is the file's own mtime (it restats the newest few), not the folder's.
    const fileBefore = await mtimeOf(file)
    expect(await mtimeMovesAfter(file, fileBefore, () => fsp.appendFile(file, '{"more":1}\n'))).toBe(true)
  }, 20_000)
})
