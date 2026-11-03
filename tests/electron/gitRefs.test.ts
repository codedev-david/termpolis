// gitRefs.ts: the git plumbing (where HEAD and a branch point) on the thread pool. The trigger supervisor and the
// learning signals read it every 15 s per open repository; they used to do it with synchronous file calls on the main
// thread. These pin that the answers are the SAME as the synchronous plumbing's, on real files, and that nothing here
// makes a synchronous call or a process (counted).
// IMPORT ORDER: the counters first (they patch fs and child_process before the modules under test load).
import { arm, disarm, describeCounts, uninstall } from '../helpers/mainThreadCounters'
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { nodeAsyncFs, asAsync, gitDirOfAsync, headRefAsync, resolveRefAsync, targetRefAsync } from '../../src/main/gitRefs'
import { gitDirOf, headRef, resolveRef, targetRef } from '../../src/main/workflow/triggers'
import type { Workflow } from '../../src/renderer/src/types'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

let root: string
const realFs = { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } as never

function repo(name: string, files: Record<string, string>): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, ...rel.split('/'))
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, text)
  }
  return dir
}

const wf = (type: 'gitCommit' | 'gitPush', config: Record<string, string> = {}): Workflow => ({ trigger: { type, config } } as unknown as Workflow)

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'gitrefs-')) })
afterAll(() => { uninstall(); rmSync(root, { recursive: true, force: true }) })

describe('the asynchronous git plumbing gives the synchronous answers', () => {
  it('a plain repository: HEAD on a branch, a loose ref', async () => {
    const dir = repo('plain', { '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': SHA_A + '\n' })
    const gitDir = await gitDirOfAsync(dir, nodeAsyncFs)
    expect(gitDir).toBe(gitDirOf(dir, realFs))
    expect(await headRefAsync(gitDir as string, nodeAsyncFs)).toBe('refs/heads/main')
    expect(await headRefAsync(gitDir as string, nodeAsyncFs)).toBe(headRef(gitDir as string, realFs))
    expect(await resolveRefAsync(gitDir as string, 'refs/heads/main', nodeAsyncFs)).toBe(SHA_A)
    expect(await resolveRefAsync(gitDir as string, 'refs/heads/main', nodeAsyncFs)).toBe(resolveRef(gitDir as string, 'refs/heads/main', realFs))
  })

  it('a worktree or submodule: .git is a FILE naming the git dir, relative or absolute', async () => {
    const real = repo('real-gitdir', { 'HEAD': 'ref: refs/heads/topic\n', 'refs/heads/topic': SHA_B + '\n' })
    const rel = repo('wt-rel', { '.git': 'gitdir: ../real-gitdir\n' })
    const abs = repo('wt-abs', { '.git': `gitdir: ${real}\n` })
    expect(await gitDirOfAsync(rel, nodeAsyncFs)).toBe(gitDirOf(rel, realFs))
    expect(await gitDirOfAsync(abs, nodeAsyncFs)).toBe(real)
    expect(await headRefAsync(real, nodeAsyncFs)).toBe('refs/heads/topic')
  })

  it('no .git: not a repository', async () => {
    const dir = repo('nothing', { 'a.txt': 'x' })
    expect(await gitDirOfAsync(dir, nodeAsyncFs)).toBeNull()
    expect(gitDirOf(dir, realFs)).toBeNull()
  })

  it('a detached HEAD has no symbolic ref, and HEAD itself resolves to the sha it holds', async () => {
    const dir = repo('detached', { '.git/HEAD': SHA_C + '\n' })
    const gitDir = join(dir, '.git')
    expect(await headRefAsync(gitDir, nodeAsyncFs)).toBeNull()
    expect(await resolveRefAsync(gitDir, 'HEAD', nodeAsyncFs)).toBe(SHA_C)
  })

  it('a packed ref (no loose file) is found by walking packed-refs by bytes, comments and peeled lines skipped', async () => {
    const dir = repo('packed', {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${SHA_A} refs/heads/other\n^${SHA_C}\n${SHA_B} refs/heads/main\n`,
    })
    const gitDir = join(dir, '.git')
    expect(await resolveRefAsync(gitDir, 'refs/heads/main', nodeAsyncFs)).toBe(SHA_B)
    expect(await resolveRefAsync(gitDir, 'refs/heads/main', nodeAsyncFs)).toBe(resolveRef(gitDir, 'refs/heads/main', realFs))
    expect(await resolveRefAsync(gitDir, 'refs/heads/absent', nodeAsyncFs)).toBeNull()
  })

  it('a symbolic loose ref is followed, and an unreadable or malformed one falls through to packed-refs', async () => {
    const dir = repo('symbolic', {
      '.git/refs/heads/alias': 'ref: refs/heads/real\n',
      '.git/refs/heads/real': SHA_A + '\n',
      '.git/refs/heads/junk': 'not a sha at all\n',
      '.git/packed-refs': `${SHA_C} refs/heads/junk\n`,
    })
    const gitDir = join(dir, '.git')
    expect(await resolveRefAsync(gitDir, 'refs/heads/alias', nodeAsyncFs)).toBe(SHA_A)
    expect(await resolveRefAsync(gitDir, 'refs/heads/junk', nodeAsyncFs)).toBe(SHA_C)
  })

  it('targetRef: a commit trigger follows its branch or HEAD, a push trigger follows the remote branch', async () => {
    const dir = repo('target', { '.git/HEAD': 'ref: refs/heads/dev\n' })
    const gitDir = join(dir, '.git')
    for (const [w, want] of [
      [wf('gitCommit'), 'refs/heads/dev'],
      [wf('gitCommit', { branch: 'main' }), 'refs/heads/main'],
      [wf('gitPush'), 'refs/remotes/origin/dev'],
      [wf('gitPush', { remote: 'up', branch: 'rel' }), 'refs/remotes/up/rel'],
    ] as Array<[Workflow, string]>) {
      expect(await targetRefAsync(w.trigger.type, w.trigger.config ?? {}, gitDir, nodeAsyncFs)).toBe(want)
      expect(targetRef(w, gitDir, realFs)).toBe(want)
    }
  })

  it('targetRef: on a detached HEAD a trigger with no branch has nothing to follow; a .git file with no pointer is the git dir itself', async () => {
    const detached = repo('target-detached', { '.git/HEAD': SHA_C + '\n' })
    for (const type of ['gitCommit', 'gitPush'] as const) {
      const w = wf(type)
      expect(await targetRefAsync(w.trigger.type, w.trigger.config ?? {}, join(detached, '.git'), nodeAsyncFs)).toBeNull()
      expect(targetRef(w, join(detached, '.git'), realFs)).toBeNull()
    }
    const odd = repo('odd-dotgit', { '.git': 'this is not a gitdir pointer\n' })
    expect(await gitDirOfAsync(odd, nodeAsyncFs)).toBe(join(odd, '.git'))
    expect(gitDirOf(odd, realFs)).toBe(join(odd, '.git'))
  })

  it('asAsync wraps a synchronous fake with the same answers', async () => {
    const files = new Map<string, string>([[join('/r', '.git', 'HEAD'), 'ref: refs/heads/x\n']])
    const fake = asAsync(
      { existsSync: (p) => files.has(p) || p === join('/r', '.git'), readFileSync: (p) => { const v = files.get(p); if (v === undefined) throw new Error('EISDIR'); return v } },
      () => new Uint8Array(),
    )
    expect(await gitDirOfAsync('/r', fake)).toBe(join('/r', '.git'))
    expect(await headRefAsync(join('/r', '.git'), fake)).toBe('refs/heads/x')
  })

  it('asAsync hands the bytes reader through unchanged, and an unreadable HEAD is no symbolic ref (not an error)', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const asked: string[] = []
    const fake = asAsync(
      { existsSync: () => true, readFileSync: () => { throw new Error('EISDIR') } },
      (p) => { asked.push(p); return bytes },
    )
    expect(await fake.readBytes('/r/.git/packed-refs')).toBe(bytes)
    expect(asked).toEqual(['/r/.git/packed-refs'])
    expect(await headRefAsync('/r/.git', fake)).toBeNull() // HEAD cannot be read: the same quiet null as the sync original
  })
})

describe('no synchronous call and no process, counted', () => {
  it('twenty polls of a repository cost zero Sync calls and zero spawns on the main thread', async () => {
    const dir = repo('counted', { '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': SHA_A + '\n' })
    arm()
    for (let i = 0; i < 20; i++) {
      const gitDir = await gitDirOfAsync(dir, nodeAsyncFs)
      const ref = await headRefAsync(gitDir as string, nodeAsyncFs)
      await resolveRefAsync(gitDir as string, ref as string, nodeAsyncFs)
    }
    expect(describeCounts(disarm())).toBe('')
  })

  it('the synchronous originals DO make them: the counter sees what it is meant to catch', () => {
    const dir = repo('control', { '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': SHA_A + '\n' })
    arm()
    const gitDir = gitDirOf(dir, realFs) as string
    resolveRef(gitDir, 'refs/heads/main', realFs)
    const c = disarm()
    expect(c.sync.existsSync ?? 0).toBeGreaterThan(0) // a call made by src/main code, counted
  })
})
