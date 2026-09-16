import { describe, it, expect } from 'vitest'
import { resolve as pathResolve } from 'path'
import {
  zsplit,
  parseBranchHeader,
  parseNumstatZ,
  parseStatusZ,
  isUnmerged,
  buildChanges,
  countChanges,
  parseUnpushedZ,
  resolveInsideRepo,
  synthesizeUntrackedDiff,
  UNTRACKED_MAX_BYTES,
} from '../../src/main/gitChanges'

/** Build a NUL-terminated record stream the way git writes one. */
const z = (...recs: string[]) => recs.map(r => `${r}\0`).join('')

describe('zsplit', () => {
  it('drops the trailing empty field git leaves behind', () => {
    expect(zsplit('a\0b\0')).toEqual(['a', 'b'])
  })

  it('returns nothing for empty output', () => {
    expect(zsplit('')).toEqual([])
  })

  it('keeps a final record that has no trailing NUL', () => {
    expect(zsplit('a\0b')).toEqual(['a', 'b'])
  })

  it('preserves an empty record in the middle (the rename numstat form)', () => {
    expect(zsplit('12\t3\t\0old\0new\0')).toEqual(['12\t3\t', 'old', 'new'])
  })
})

describe('parseBranchHeader', () => {
  it('reads branch, ahead and behind together', () => {
    expect(parseBranchHeader('## main...origin/main [ahead 1, behind 2]'))
      .toEqual({ branch: 'main', ahead: 1, behind: 2 })
  })

  it('reads ahead on its own', () => {
    expect(parseBranchHeader('## main...origin/main [ahead 3]'))
      .toEqual({ branch: 'main', ahead: 3, behind: 0 })
  })

  it('reads behind on its own', () => {
    expect(parseBranchHeader('## main...origin/main [behind 4]'))
      .toEqual({ branch: 'main', ahead: 0, behind: 4 })
  })

  it('reports 0/0 when tracking with nothing to sync', () => {
    expect(parseBranchHeader('## feat/x...origin/feat/x'))
      .toEqual({ branch: 'feat/x', ahead: 0, behind: 0 })
  })

  it('reports 0/0 with no upstream at all — nowhere to push is not "needs pushing"', () => {
    expect(parseBranchHeader('## local-only'))
      .toEqual({ branch: 'local-only', ahead: 0, behind: 0 })
  })

  it('unwraps a fresh repo with no commits yet', () => {
    expect(parseBranchHeader('## No commits yet on main'))
      .toEqual({ branch: 'main', ahead: 0, behind: 0 })
  })
})

describe('parseNumstatZ', () => {
  it('reads added and removed counts', () => {
    const m = parseNumstatZ(z('12\t3\tsrc/a.ts'))
    expect(m.get('src/a.ts')).toEqual({ added: 12, removed: 3, binary: false })
  })

  it('flags a binary file and zeroes its counts', () => {
    const m = parseNumstatZ(z('-\t-\tlogo.png'))
    expect(m.get('logo.png')).toEqual({ added: 0, removed: 0, binary: true })
  })

  it('attributes a rename to the NEW path, skipping both path records', () => {
    // `12\t3\t\0old\0new\0` — the path field is empty and the two paths follow.
    const m = parseNumstatZ(z('12\t3\t', 'src/old.ts', 'src/new.ts') + z('1\t1\tother.ts'))
    expect(m.get('src/new.ts')).toEqual({ added: 12, removed: 3, binary: false })
    expect(m.has('src/old.ts')).toBe(false)
    // The cursor must advance by three, or this next record is mis-read.
    expect(m.get('other.ts')).toEqual({ added: 1, removed: 1, binary: false })
  })

  it('survives a truncated rename at the end of the stream', () => {
    const m = parseNumstatZ(z('12\t3\t', 'src/old.ts'))
    expect(m.get('')).toEqual({ added: 12, removed: 3, binary: false })
  })

  it('skips a record with no tabs', () => {
    expect(parseNumstatZ(z('garbage')).size).toBe(0)
  })

  it('skips a record with only one tab', () => {
    expect(parseNumstatZ(z('12\tonly-one')).size).toBe(0)
  })

  it('treats an unparseable count as zero rather than NaN', () => {
    const m = parseNumstatZ(z('x\ty\tweird.ts'))
    expect(m.get('weird.ts')).toEqual({ added: 0, removed: 0, binary: false })
  })
})

describe('parseStatusZ', () => {
  it('reads the branch header and the entries after it', () => {
    const out = z('## main...origin/main [ahead 2]', ' M src/a.ts', '?? new.ts')
    const r = parseStatusZ(out)
    expect(r).toMatchObject({ branch: 'main', ahead: 2, behind: 0 })
    expect(r.records).toEqual([
      { x: ' ', y: 'M', file: 'src/a.ts' },
      { x: '?', y: '?', file: 'new.ts' },
    ])
  })

  it('works with no header record at all', () => {
    const r = parseStatusZ(z('M  src/a.ts'))
    expect(r.branch).toBe('')
    expect(r.records).toEqual([{ x: 'M', y: ' ', file: 'src/a.ts' }])
  })

  it('pairs a rename with its old path and does not emit the old path as a record', () => {
    const r = parseStatusZ(z('## main', 'R  src/new.ts', 'src/old.ts', ' M other.ts'))
    expect(r.records).toEqual([
      { x: 'R', y: ' ', file: 'src/new.ts', oldFile: 'src/old.ts' },
      { x: ' ', y: 'M', file: 'other.ts' },
    ])
  })

  it('pairs a copy the same way', () => {
    const r = parseStatusZ(z('C  b.ts', 'a.ts'))
    expect(r.records).toEqual([{ x: 'C', y: ' ', file: 'b.ts', oldFile: 'a.ts' }])
  })

  it('tolerates a rename record with no following path', () => {
    const r = parseStatusZ(z('R  src/new.ts'))
    expect(r.records).toEqual([{ x: 'R', y: ' ', file: 'src/new.ts', oldFile: '' }])
  })

  it('skips a record too short to be an entry', () => {
    expect(parseStatusZ(z('## main', ' M ')).records).toEqual([])
  })

  it('does NOT trim — a filename may legitimately end in a space', () => {
    // git emits the name raw under -z; trimming it produces a path that will not open.
    expect(parseStatusZ(z(' M weird name ')).records).toEqual([
      { x: ' ', y: 'M', file: 'weird name ' },
    ])
  })
})

describe('isUnmerged', () => {
  it.each([
    ['U', 'U'],
    ['U', 'D'],
    ['A', 'U'],
    ['A', 'A'],
    ['D', 'D'],
  ])('treats %s%s as a conflict', (x, y) => {
    expect(isUnmerged(x, y)).toBe(true)
  })

  it.each([
    [' ', 'M'],
    ['M', ' '],
    ['A', 'M'],
    ['?', '?'],
  ])('treats %s%s as an ordinary change', (x, y) => {
    expect(isUnmerged(x, y)).toBe(false)
  })
})

describe('buildChanges', () => {
  it('splits staged, unstaged and untracked, attaching line counts', () => {
    const status = z('## main...origin/main [ahead 1]', 'M  staged.ts', ' M work.ts', '?? new.ts')
    const r = buildChanges(status, z('4\t2\twork.ts'), z('9\t0\tstaged.ts'))
    expect(r.branch).toBe('main')
    expect(r.ahead).toBe(1)
    expect(r.staged).toEqual([
      { file: 'staged.ts', status: 'M', added: 9, removed: 0, binary: false },
    ])
    expect(r.unstaged).toEqual([
      { file: 'work.ts', status: 'M', added: 4, removed: 2, binary: false },
    ])
    expect(r.untracked).toEqual([
      { file: 'new.ts', status: '??', added: 0, removed: 0, binary: false },
    ])
  })

  it('lists a file in BOTH sections when it is staged and then edited again (MM)', () => {
    // Two different diffs of one path — the rail has to be able to open each.
    const r = buildChanges(z('MM both.ts'), z('1\t1\tboth.ts'), z('5\t5\tboth.ts'))
    expect(r.staged).toEqual([{ file: 'both.ts', status: 'M', added: 5, removed: 5, binary: false }])
    expect(r.unstaged).toEqual([{ file: 'both.ts', status: 'M', added: 1, removed: 1, binary: false }])
  })

  it('files a conflict once, as U, under unstaged', () => {
    const r = buildChanges(z('UU conflict.ts'), '', '')
    expect(r.staged).toEqual([])
    expect(r.unstaged).toEqual([{ file: 'conflict.ts', status: 'U', added: 0, removed: 0, binary: false }])
  })

  it('carries the old path through on a rename', () => {
    const r = buildChanges(z('R  new.ts', 'old.ts'), '', z('2\t0\tnew.ts'))
    expect(r.staged).toEqual([
      { file: 'new.ts', oldFile: 'old.ts', status: 'R', added: 2, removed: 0, binary: false },
    ])
  })

  it('marks a binary entry and leaves its counts at zero', () => {
    const r = buildChanges(z(' M logo.png'), z('-\t-\tlogo.png'), '')
    expect(r.unstaged[0]).toEqual({ file: 'logo.png', status: 'M', added: 0, removed: 0, binary: true })
  })

  it('defaults counts to zero when numstat has nothing for the file', () => {
    const r = buildChanges(z(' D gone.ts'), '', '')
    expect(r.unstaged[0]).toEqual({ file: 'gone.ts', status: 'D', added: 0, removed: 0, binary: false })
  })

  it('returns empty sections for a clean tree', () => {
    const r = buildChanges(z('## main...origin/main'), '', '')
    expect(r).toEqual({ branch: 'main', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] })
  })
})

describe('countChanges', () => {
  it('counts each category separately', () => {
    const status = z(
      '## main...origin/main [ahead 2, behind 1]',
      'M  a.ts',
      ' M b.ts',
      'MM c.ts',
      '?? d.ts',
      'UU e.ts',
    )
    expect(countChanges(status)).toEqual({
      branch: 'main',
      ahead: 2,
      behind: 1,
      staged: 2,   // a.ts + c.ts
      unstaged: 2, // b.ts + c.ts
      untracked: 1,
      conflicted: 1,
    })
  })

  it('reports all zeroes on a clean, synced repo', () => {
    expect(countChanges(z('## main...origin/main'))).toEqual({
      branch: 'main', ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0,
    })
  })
})

describe('resolveInsideRepo', () => {
  it('resolves a repo-relative path', () => {
    const root = pathResolve('/repo')
    expect(resolveInsideRepo(root, 'src/a.ts')).toBe(pathResolve(root, 'src/a.ts'))
  })

  it('refuses a path that climbs out of the repo', () => {
    expect(resolveInsideRepo(pathResolve('/repo'), '../secrets.env')).toBeNull()
  })

  it('refuses a sibling directory that merely shares a prefix', () => {
    expect(resolveInsideRepo(pathResolve('/repo'), '../repo-evil/x.ts')).toBeNull()
  })

  it('allows the repo root itself', () => {
    const root = pathResolve('/repo')
    expect(resolveInsideRepo(root, '.')).toBe(root)
  })

  it('refuses an absolute path pointing elsewhere', () => {
    expect(resolveInsideRepo(pathResolve('/repo'), pathResolve('/elsewhere/x.ts'))).toBeNull()
  })
})

describe('synthesizeUntrackedDiff', () => {
  it('emits an add-only hunk for a text file', () => {
    const out = synthesizeUntrackedDiff('new.ts', Buffer.from('a\nb\n'))
    expect(out).toBe(
      'diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n',
    )
  })

  it('annotates a missing trailing newline instead of inventing one', () => {
    const out = synthesizeUntrackedDiff('new.ts', Buffer.from('a\nb'))
    expect(out).toContain('@@ -0,0 +1,2 @@\n+a\n+b\n')
    expect(out).toContain('\\ No newline at end of file')
  })

  it('emits a hunk-less diff for an empty file', () => {
    const out = synthesizeUntrackedDiff('empty.ts', Buffer.from(''))
    expect(out).toBe('diff --git a/empty.ts b/empty.ts\nnew file mode 100644\n--- /dev/null\n+++ b/empty.ts\n')
    expect(out).not.toContain('@@')
  })

  it('calls a NUL-containing file binary rather than rendering control bytes', () => {
    const out = synthesizeUntrackedDiff('blob.bin', Buffer.from([0x41, 0x00, 0x42]))
    expect(out).toContain('Binary files /dev/null and b/blob.bin differ')
    expect(out).not.toContain('@@')
  })

  it('calls an oversized file binary rather than parsing megabytes on a click', () => {
    const big = Buffer.alloc(UNTRACKED_MAX_BYTES + 1, 0x41)
    expect(synthesizeUntrackedDiff('big.log', big)).toContain('Binary files')
  })

  it('produces a preamble the shared diff parser recognises as a new file', () => {
    expect(synthesizeUntrackedDiff('x.ts', Buffer.from('hi\n'))).toContain('new file mode 100644')
  })
})

// ---------------------------------------------------------------------------
// parseUnpushedZ — the rail's Unpushed section
//
// Exists because the sidebar dot counts `ahead` as outstanding work while the rail
// counted only working-tree files. A repo that was clean but one commit ahead pulsed
// amber and then said "Nothing changed — the working tree is clean", which is the one
// thing a mark must never do. The rule the rail keeps now: anything that makes the dot
// pulse has a row you can click.
//
// The record separator is emitted BY THE FORMAT (`%x00`), not by `-z`. git specifies
// `-z` for the --raw / --name-only streams; leaning on it for --format would be relying
// on a shape git never promised. git still writes a newline after each commit's format
// output, so every record after the first arrives with one attached.
// ---------------------------------------------------------------------------
describe('parseUnpushedZ', () => {
  /** One commit exactly as `--format=%H%x1f%h%x1f%s%x1f%ar%x00` writes it. */
  const commit = (sha: string, short: string, subject: string, when: string) =>
    `${sha}\x1f${short}\x1f${subject}\x1f${when}\0`

  it('reads one commit into its four fields', () => {
    const out = commit('a'.repeat(40), 'aaaaaaa', 'fix: stop the dot lying', '2 hours ago')
    expect(parseUnpushedZ(out)).toEqual([{
      sha: 'a'.repeat(40),
      shortSha: 'aaaaaaa',
      subject: 'fix: stop the dot lying',
      relativeDate: '2 hours ago',
    }])
  })

  it('strips the newline git writes after each record, so the next sha is usable', () => {
    // Without this the second sha arrives as '\nbbbb…' and `git show` rejects it, so the
    // row would open an error instead of a diff.
    const out = commit('a'.repeat(40), 'aaaaaaa', 'first', '1 day ago')
      + '\n' + commit('b'.repeat(40), 'bbbbbbb', 'second', '3 minutes ago')
    const got = parseUnpushedZ(out)
    expect(got.map(c => c.sha)).toEqual(['a'.repeat(40), 'b'.repeat(40)])
    expect(got[1].subject).toBe('second')
  })

  it('keeps a subject containing spaces, colons and em dashes verbatim', () => {
    const subject = 'feat(rail): show unpushed work — the dot already counts it'
    expect(parseUnpushedZ(commit('c'.repeat(40), 'ccccccc', subject, '5 seconds ago'))[0].subject)
      .toBe(subject)
  })

  it('returns no commits for an empty stream, which is the already-pushed case', () => {
    expect(parseUnpushedZ('')).toEqual([])
  })

  it('drops a record the buffer cut short rather than emitting undefined fields', () => {
    // maxBuffer truncation is the realistic way this happens. Losing the row beats
    // rendering the word "undefined" in the rail.
    expect(parseUnpushedZ('deadbeef\x1fdeadbee\0')).toEqual([])
  })
})
