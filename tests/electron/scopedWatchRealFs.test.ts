// scopedWatch on the REAL fs.watch of this platform: what a swarm writing into `.worktrees/` costs the
// thread that is watching, counted in events delivered to it, with a plain recursive watch of the same root
// as the control. Also the platform behaviour the design depends on: a directory with a watch open on it
// can still be deleted and renamed (so a branch switch that removes `docs/` is not blocked by us), a
// directory created later is picked up, and a junction is never followed.
//
// Everything is synthetic, in a temp dir. The negative claims ("nothing arrived") are only made after the
// control watcher has seen the last event of the ignored burst and a little more real time has passed.
// Writes are paced: the OS keeps a small change buffer (4 KB in libuv on Windows) and drops events when a
// tight loop overflows it, which would let a "nothing arrived" claim pass for the wrong reason.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { scopedRecursiveWatch, type ScopedWatch } from '../../src/main/scopedWatch'

let root: string
let control: string[] // what a plain recursive watch of the root is handed: the shape this module replaces
let controlWatcher: fs.FSWatcher | null
let seen: string[]
let w: ScopedWatch | null

const norm = (s: string): string => s.replace(/\\/g, '/')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function put(rel: string, content = 'x'): void {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

async function putAll(rels: string[]): Promise<void> {
  for (let i = 0; i < rels.length; i++) {
    put(rels[i])
    if (i % 3 === 2) await sleep(2)
  }
  await sleep(5)
}

const controlSaw = (tail: string): boolean => control.some((n) => n.endsWith(tail))
const seenAny = (re: RegExp): string[] => seen.filter((n) => re.test(n))
const ready = (n: number): Promise<void> => vi.waitFor(() => expect(w!.subscriptions).toBeGreaterThanOrEqual(n), { timeout: 20_000, interval: 25 })

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-scoped-real-'))
  for (const d of ['src', 'docs', '.worktrees/wt1/src', 'node_modules/x', 'dist', '.git']) fs.mkdirSync(path.join(root, d), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{}')
  control = []
  seen = []
  controlWatcher = fs.watch(root, { recursive: true }, (_e, f) => { if (f) control.push(norm(String(f))) })
  w = null
})
afterEach(() => {
  try { w?.close() } catch { /* closed */ }
  try { controlWatcher?.close() } catch { /* closed */ }
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* temp */ }
})

describe('scopedRecursiveWatch on the real fs.watch', () => {
  it('delivers the real changes of a recursive watch of the root, and NOT ONE event from the ignored subtrees the control is flooded with', async () => {
    w = scopedRecursiveWatch(fs.watch as never, root, (_e, f) => { if (f) seen.push(norm(f)) })
    await ready(2) // src and docs
    const burst: string[] = []
    for (let i = 0; i < 60; i++) burst.push(`.worktrees/wt1/src/a${i}.ts`, `node_modules/x/i${i}.js`, `dist/o${i}.js`)
    await putAll(burst)
    put('src/real.ts')
    put('docs/readme.md')
    put('top.txt')
    await vi.waitFor(() => expect(controlSaw('a59.ts') && controlSaw('i59.js') && controlSaw('o59.js')).toBe(true), { timeout: 20_000, interval: 25 })
    await vi.waitFor(() => expect(seen).toEqual(expect.arrayContaining(['src/real.ts', 'docs/readme.md', 'top.txt'])), { timeout: 20_000, interval: 25 })
    await sleep(300)
    // The control (what this module replaces) was handed the whole swarm; the scoped watch was handed none of it.
    const inside = /(^|\/)(\.worktrees|node_modules|dist)\//
    const controlInside = control.filter((n) => inside.test(n)).length
    const scopedInside = seenAny(inside).length
    expect(controlInside).toBeGreaterThanOrEqual(60)
    expect(scopedInside).toBe(0) // not one event from INSIDE an ignored subtree
    // What remains is the root hearing the ignored directories' OWN entries (`change:dist`: a file created in a
    // flat directory moves its modification time): at most one per flat write here, and none for the deep ones.
    const entries = seen.filter((n) => /^(\.worktrees|node_modules|dist)$/.test(n)).length
    expect(entries).toBeLessThanOrEqual(80)
  })

  it('a top-level directory created later is subscribed: a file written into it is reported', async () => {
    w = scopedRecursiveWatch(fs.watch as never, root, (_e, f) => { if (f) seen.push(norm(f)) })
    await ready(2)
    const before = w.subscriptions
    fs.mkdirSync(path.join(root, 'lib'))
    await ready(before + 1)
    await vi.waitFor(() => expect(seen).toContain('lib'), { timeout: 20_000, interval: 25 }) // the synthetic rename, at least
    put('lib/new.ts')
    await vi.waitFor(() => expect(seen).toContain('lib/new.ts'), { timeout: 20_000, interval: 25 })
  })

  it('a directory that is created ignored (a new .worktrees-style name) is never subscribed', async () => {
    w = scopedRecursiveWatch(fs.watch as never, root, (_e, f) => { if (f) seen.push(norm(f)) })
    await ready(2)
    const before = w.subscriptions
    fs.mkdirSync(path.join(root, 'build'))
    put('src/after.ts') // through the same pipe, so by the time it is seen the `build` rename has been looked at
    await vi.waitFor(() => expect(seen).toContain('src/after.ts'), { timeout: 20_000, interval: 25 })
    await sleep(300)
    put('build/out.js')
    await vi.waitFor(() => expect(controlSaw('build/out.js')).toBe(true), { timeout: 20_000, interval: 25 })
    await sleep(300)
    expect(w.subscriptions).toBe(before)
    expect(seenAny(/(^|\/)build\//)).toEqual([])
  })

  it('a watched directory can still be removed and renamed (we do not pin it), and a recreated one is subscribed again', async () => {
    w = scopedRecursiveWatch(fs.watch as never, root, (_e, f) => { if (f) seen.push(norm(f)) })
    await ready(2)
    // The point of this test is the PLATFORM: a recursive handle that blocked rmdir or rename would make a
    // branch switch that removes `docs/`, or an IDE rename of `src/`, fail for as long as Termpolis runs.
    fs.rmSync(path.join(root, 'docs'), { recursive: true })
    await vi.waitFor(() => expect(seen).toContain('docs'), { timeout: 20_000, interval: 25 })
    fs.mkdirSync(path.join(root, 'docs'))
    await vi.waitFor(() => expect(w!.subscriptions).toBe(2), { timeout: 20_000, interval: 25 })
    await sleep(100)
    put('docs/again.md')
    await vi.waitFor(() => expect(seen).toContain('docs/again.md'), { timeout: 20_000, interval: 25 })
    fs.renameSync(path.join(root, 'src'), path.join(root, 'source'))
    await vi.waitFor(() => expect(seen).toContain('source'), { timeout: 20_000, interval: 25 })
    await vi.waitFor(() => expect(w!.subscriptions).toBe(2), { timeout: 20_000, interval: 25 })
    put('source/x.ts')
    await vi.waitFor(() => expect(seen).toContain('source/x.ts'), { timeout: 20_000, interval: 25 })
  })

  it('a junction (or symlink) at the top level is not followed: its target is not watched through it', async () => {
    fs.mkdirSync(path.join(root, 'elsewhere'))
    try {
      fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'link'), 'junction')
    } catch {
      return // no permission to create links here: nothing to prove
    }
    w = scopedRecursiveWatch(fs.watch as never, root, (_e, f) => { if (f) seen.push(norm(f)) })
    await ready(3) // src, docs, elsewhere
    await sleep(200)
    expect(w.subscriptions).toBe(3)
  })

  it('close() leaves nothing watching: the root can be removed straight afterwards', async () => {
    w = scopedRecursiveWatch(fs.watch as never, root, (_e, f) => { if (f) seen.push(norm(f)) })
    await ready(2)
    w.close()
    controlWatcher?.close()
    controlWatcher = null
    fs.rmSync(root, { recursive: true, force: false })
    expect(fs.existsSync(root)).toBe(false)
  })
})
