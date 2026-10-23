// @vitest-environment node
//
// Carrying a Claude Code conversation to another account's profile (src/main/accountCarry.ts, R25),
// in real temp folders: found by its id one folder down, copied under the folder of the same name,
// an older copy there replaced and any other kept beside it, never through a link, and nothing to
// do when both profiles share `projects/`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { carryTranscript, findTranscript } from '../../src/main/accountCarry'
import { accountFs } from '../../src/main/accountFs'
import type { AccountFs } from '../../src/main/accountFs'

const ID = '3f2a9c1e-5b7d-4e8f-a012-3456789abcde'
let root: string
let a: string
let b: string

function put(file: string, text: string, mtimeSec?: number): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
  if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tp-carry-'))
  a = join(root, 'a', 'projects')
  b = join(root, 'b', 'projects')
  mkdirSync(a, { recursive: true })
  // The target's profile folder exists (the switch checks it): its projects/ may not.
  mkdirSync(join(root, 'b'))
})

afterEach(() => {
  // Links first, as links, so the delete below can never walk through one.
  for (const d of [join(root, 'link-projects'), join(a, 'C--repo', ID, 'linked')]) {
    try { if (existsSync(d)) accountFs.unlinkLink(d) } catch { /* not a link */ }
  }
  rmSync(root, { recursive: true, force: true })
})

describe('findTranscript', () => {
  it('finds the newest copy of the id one folder down, in any of the folders given', () => {
    put(join(a, 'C--repo', `${ID}.jsonl`), 'old', 1000)
    put(join(b, 'C--repo-wt', `${ID}.jsonl`), 'newer', 2000)
    put(join(a, 'C--other', 'x.jsonl'), 'other')
    writeFileSync(join(a, 'not-a-folder.txt'), 'x')
    const found = findTranscript([a, b, join(root, 'missing')], ID)!
    expect(found).toEqual({ projects: b, folder: 'C--repo-wt', mtimeMs: 2000_000, size: 5 })
    expect(findTranscript([a], '01a1664b-6312-7121-97f6-88c7f6793c64')).toBeNull()
  })

  it('refuses anything but a session id', () => {
    expect(() => findTranscript([a], '../x')).toThrow('not a session id')
  })
})

describe('carryTranscript', () => {
  it('copies the transcript and its subagents\' folder under the folder of the same name', () => {
    put(join(a, 'C--repo', `${ID}.jsonl`), '{"a":1}\n')
    put(join(a, 'C--repo', ID, 'agent-1.jsonl'), 'sub')
    put(join(a, 'C--repo', ID, 'deep', 'agent-2.jsonl'), 'deeper')
    expect(carryTranscript([a], b, ID, 77)).toEqual({ kind: 'carried' })
    expect(readFileSync(join(b, 'C--repo', `${ID}.jsonl`), 'utf8')).toBe('{"a":1}\n')
    expect(readFileSync(join(b, 'C--repo', ID, 'agent-1.jsonl'), 'utf8')).toBe('sub')
    expect(readFileSync(join(b, 'C--repo', ID, 'deep', 'agent-2.jsonl'), 'utf8')).toBe('deeper')
  })

  it('replaces an older, shorter copy at the target, as a round trip leaves one', () => {
    put(join(a, 'C--repo', `${ID}.jsonl`), 'the conversation, longer now', 3000)
    put(join(b, 'C--repo', `${ID}.jsonl`), 'the conversation', 1000)
    expect(carryTranscript([a], b, ID, 77)).toEqual({ kind: 'carried' })
    expect(readFileSync(join(b, 'C--repo', `${ID}.jsonl`), 'utf8')).toBe('the conversation, longer now')
    expect(readdirSync(join(b, 'C--repo'))).toEqual([`${ID}.jsonl`])
  })

  it('keeps a newer or longer copy at the target beside the one carried, and says so', () => {
    put(join(a, 'C--repo', `${ID}.jsonl`), 'short', 3000)
    put(join(b, 'C--repo', `${ID}.jsonl`), 'longer than the source', 1000)
    expect(carryTranscript([a], b, ID, 77)).toEqual({ kind: 'carried', kept: `${ID}.jsonl.bak-77` })
    expect(readFileSync(join(b, 'C--repo', `${ID}.jsonl`), 'utf8')).toBe('short')
    expect(readFileSync(join(b, 'C--repo', `${ID}.jsonl.bak-77`), 'utf8')).toBe('longer than the source')
  })

  it('carries nothing when the newest copy is the target\'s own, or the two share projects/', () => {
    put(join(a, 'C--repo', `${ID}.jsonl`), 'old', 1000)
    put(join(b, 'C--repo', `${ID}.jsonl`), 'newer', 2000)
    expect(carryTranscript([a, b], b, ID, 1)).toEqual({ kind: 'shared' })
    const linked = join(root, 'link-projects')
    accountFs.link(a, linked)
    expect(carryTranscript([a], linked, ID, 1)).toEqual({ kind: 'shared' })
  })

  it('finds nothing to carry for a session in no folder', () => {
    expect(carryTranscript([a], b, ID, 1)).toEqual({ kind: 'not-found' })
    expect(existsSync(b)).toBe(false)
  })

  it('copies a subagent file only where the target has none or an older one, and never through a link', () => {
    put(join(a, 'C--repo', `${ID}.jsonl`), 'x', 3000)
    put(join(a, 'C--repo', ID, 'agent-1.jsonl'), 'new sub', 3000)
    put(join(a, 'C--repo', ID, 'agent-2.jsonl'), 'old sub', 1000)
    const elsewhere = join(root, 'elsewhere')
    put(join(elsewhere, 'secret.jsonl'), 'never')
    symlinkSync(elsewhere, join(a, 'C--repo', ID, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    put(join(b, 'C--repo', ID, 'agent-1.jsonl'), 'stale', 1000)
    put(join(b, 'C--repo', ID, 'agent-2.jsonl'), 'kept, newer', 2000)
    carryTranscript([a], b, ID, 1)
    expect(readFileSync(join(b, 'C--repo', ID, 'agent-1.jsonl'), 'utf8')).toBe('new sub')
    expect(readFileSync(join(b, 'C--repo', ID, 'agent-2.jsonl'), 'utf8')).toBe('kept, newer')
    expect(existsSync(join(b, 'C--repo', ID, 'linked'))).toBe(false)
  })

  it('leaves out a subagent file gone since its folder was listed', () => {
    put(join(a, 'C--repo', `${ID}.jsonl`), 'x')
    put(join(a, 'C--repo', ID, 'gone.jsonl'), 'y')
    const fsx: AccountFs = { ...accountFs, stat: (p) => (p.endsWith('gone.jsonl') && p.startsWith(a) ? null : accountFs.stat(p)) }
    expect(carryTranscript([a], b, ID, 1, fsx)).toEqual({ kind: 'carried' })
    expect(existsSync(join(b, 'C--repo', ID, 'gone.jsonl'))).toBe(false)
  })

  it('makes the target\'s folders private where it makes them', () => {
    put(join(a, 'C--repo', `${ID}.jsonl`), 'x')
    carryTranscript([a], b, ID, 1)
    if (process.platform !== 'win32') expect(statSync(join(b, 'C--repo')).mode & 0o777).toBe(0o700)
    expect(existsSync(join(b, 'C--repo', `${ID}.jsonl`))).toBe(true)
  })
})

describe('the fs seam\'s copy', () => {
  it('copies a file and keeps it private; never a .claude.json, a credential or a link', () => {
    put(join(a, 'f.jsonl'), 'x')
    accountFs.copyFile(join(a, 'f.jsonl'), join(a, 'g.jsonl'))
    expect(readFileSync(join(a, 'g.jsonl'), 'utf8')).toBe('x')
    if (process.platform !== 'win32') expect(statSync(join(a, 'g.jsonl')).mode & 0o777).toBe(0o600)
    expect(() => accountFs.copyFile(join(a, 'f.jsonl'), join(a, '.claude.json'))).toThrow('refused: .claude.json is never copied')
    expect(() => accountFs.copyFile(join(a, '.claude.json'), join(a, 'h'))).toThrow(/\.claude\.json is read only for named fields/)
    expect(() => accountFs.copyFile(join(a, 'f.jsonl'), join(a, '.credentials.json'))).toThrow()
    mkdirSync(join(a, 'dir'))
    expect(() => accountFs.copyFile(join(a, 'dir'), join(a, 'h'))).toThrow('is not a file')
  })
})
