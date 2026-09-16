import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'path'

/**
 * Finding the newest transcript means walking a directory the user has been filling up
 * for months, and it happens on the thread that pumps every PTY. The type of each entry
 * — file or directory — is something readdir already knows, so asking the OS again with
 * a stat per entry spends a syscall on an answer we were already handed.
 *
 * These tests count syscalls rather than measure time, because the syscall count is what
 * scales with how long someone has been using Codex.
 *
 * fs is replaced wholesale rather than spied on: `import * as fs` gives an ESM namespace
 * whose properties cannot be redefined, so vi.spyOn throws before any assertion runs.
 */
interface Node { name: string; dir: boolean }

const H = vi.hoisted(() => ({
  tree: {} as Record<string, { name: string; dir: boolean }[]>,
  dirPaths: new Set<string>(),
  mtimes: {} as Record<string, number>,
  statted: [] as string[],
}))

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const readdirSync = (dir: string, opts?: { withFileTypes?: boolean }) => {
    const entries = H.tree[dir]
    if (!entries) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    if (opts?.withFileTypes) {
      return entries.map(e => ({ name: e.name, isFile: () => !e.dir, isDirectory: () => e.dir }))
    }
    return entries.map(e => e.name)
  }
  const statSync = (p: string) => {
    H.statted.push(p)
    const isDir = H.dirPaths.has(p)
    return { isFile: () => !isDir, isDirectory: () => isDir, mtimeMs: H.mtimes[p] ?? 1 }
  }
  return { ...real, readdirSync, statSync, default: { ...real, readdirSync, statSync } }
})

import { findLatestCodexSessionFile, CODEX_SESSIONS_DIR } from '../../src/main/transcriptWatchers/codexWatcher'
import { findLatestGeminiSessionFile, GEMINI_DIR } from '../../src/main/transcriptWatchers/geminiWatcher'

function install(tree: Record<string, Node[]>, mtimes: Record<string, number>) {
  H.tree = tree
  H.mtimes = mtimes
  H.dirPaths = new Set<string>()
  for (const [dir, entries] of Object.entries(tree)) {
    for (const e of entries) if (e.dir) H.dirPaths.add(path.join(dir, e.name))
  }
}

beforeEach(() => {
  H.statted.length = 0
  H.tree = {}
  H.mtimes = {}
  H.dirPaths = new Set<string>()
})

const stattedDirs = () => H.statted.filter(p => H.dirPaths.has(p))

describe('transcript scan — syscalls per attach', () => {
  const codex = () => {
    const r = CODEX_SESSIONS_DIR
    install(
      {
        [r]: [
          { name: '2024', dir: true },
          { name: '2025', dir: true },
          { name: 'archive', dir: true },
          { name: 'top.jsonl', dir: false },
        ],
        [path.join(r, '2024')]: [{ name: 'a.jsonl', dir: false }],
        [path.join(r, '2025')]: [{ name: 'b.jsonl', dir: false }],
        [path.join(r, 'archive')]: [{ name: 'c.jsonl', dir: false }],
      },
      {
        [path.join(r, 'top.jsonl')]: 10,
        [path.join(r, '2024', 'a.jsonl')]: 20,
        [path.join(r, '2025', 'b.jsonl')]: 99,
        [path.join(r, 'archive', 'c.jsonl')]: 30,
      },
    )
    return r
  }

  it('never stats a directory while hunting for the latest Codex session', () => {
    codex()
    findLatestCodexSessionFile()
    expect(stattedDirs()).toEqual([])
  })

  // The optimisation must not change the answer: the newest transcript is the one the
  // terminal attaches to, and attaching to the wrong one shows another session's output.
  it('still picks the newest Codex transcript', () => {
    const r = codex()
    expect(findLatestCodexSessionFile()).toBe(path.join(r, '2025', 'b.jsonl'))
  })

  const gemini = () => {
    const r = GEMINI_DIR
    install(
      {
        [r]: [
          { name: 'tmp', dir: true },
          { name: 'sessions', dir: true },
          { name: 'flat.jsonl', dir: false },
        ],
        [path.join(r, 'tmp')]: [{ name: 'x.jsonl', dir: false }],
        [path.join(r, 'sessions')]: [{ name: 'y.jsonl', dir: false }],
      },
      {
        [path.join(r, 'flat.jsonl')]: 5,
        [path.join(r, 'tmp', 'x.jsonl')]: 7,
        [path.join(r, 'sessions', 'y.jsonl')]: 88,
      },
    )
    return r
  }

  it('never stats a directory while hunting for the latest Gemini session', () => {
    gemini()
    findLatestGeminiSessionFile()
    expect(stattedDirs()).toEqual([])
  })

  it('still picks the newest Gemini transcript', () => {
    const r = gemini()
    expect(findLatestGeminiSessionFile()).toBe(path.join(r, 'sessions', 'y.jsonl'))
  })

  // Gemini's flat-layout fallback re-walked the top level and stat'd every name a second
  // time, so a file sitting directly in ~/.gemini was stat'd once by the walk and again
  // by the fallback.
  it('stats each Gemini candidate only once', () => {
    gemini()
    findLatestGeminiSessionFile()
    expect(new Set(H.statted).size).toBe(H.statted.length)
  })
})
