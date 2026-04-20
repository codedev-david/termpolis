import { describe, it, expect } from 'vitest'
import { parseUnifiedDiff, diffStat, hunkPatch } from '../../src/renderer/src/lib/diffParser'

const TWO_FILE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line one
-old
+new
+added
 line four
@@ -10,2 +11,2 @@
 keep
-drop
+insert
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+first line
+second line
`

describe('parseUnifiedDiff', () => {
  it('returns empty array for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })

  it('splits a multi-file diff into one DiffFile per `diff --git`', () => {
    const files = parseUnifiedDiff(TWO_FILE_DIFF)
    expect(files).toHaveLength(2)
    expect(files[0].file).toBe('src/a.ts')
    expect(files[1].file).toBe('src/b.ts')
  })

  it('counts adds/removes per file', () => {
    const files = parseUnifiedDiff(TWO_FILE_DIFF)
    expect(files[0].added).toBe(3)   // +new, +added, +insert
    expect(files[0].removed).toBe(2) // -old, -drop
    expect(files[1].added).toBe(2)
    expect(files[1].removed).toBe(0)
  })

  it('detects new-file status', () => {
    const files = parseUnifiedDiff(TWO_FILE_DIFF)
    expect(files[1].status).toBe('A')
  })

  it('detects modified status', () => {
    const files = parseUnifiedDiff(TWO_FILE_DIFF)
    expect(files[0].status).toBe('M')
  })

  it('detects rename status', () => {
    const renameDiff = `diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`
    const files = parseUnifiedDiff(renameDiff)
    expect(files).toHaveLength(1)
    expect(files[0].status).toBe('R')
    expect(files[0].oldFile).toBe('old.ts')
    expect(files[0].file).toBe('new.ts')
  })

  it('detects deleted status', () => {
    const delDiff = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index abc..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`
    const files = parseUnifiedDiff(delDiff)
    expect(files[0].status).toBe('D')
    expect(files[0].removed).toBe(1)
  })

  it('flags binary files', () => {
    const binDiff = `diff --git a/img.png b/img.png
index 111..222
Binary files a/img.png and b/img.png differ
`
    const files = parseUnifiedDiff(binDiff)
    expect(files[0].binary).toBe(true)
    expect(files[0].hunks).toEqual([])
  })

  it('parses multiple hunks per file', () => {
    const files = parseUnifiedDiff(TWO_FILE_DIFF)
    expect(files[0].hunks).toHaveLength(2)
  })

  it('gives each hunk a unique id', () => {
    const files = parseUnifiedDiff(TWO_FILE_DIFF)
    const ids = files.flatMap(f => f.hunks.map(h => h.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('stores hunk start line parsed from @@ header', () => {
    const files = parseUnifiedDiff(TWO_FILE_DIFF)
    expect(files[0].hunks[0].startLine).toBe(1)
    expect(files[0].hunks[1].startLine).toBe(11)
  })

  it('hunk.patch includes preamble + only that hunk', () => {
    const files = parseUnifiedDiff(TWO_FILE_DIFF)
    const h0 = files[0].hunks[0]
    expect(h0.patch).toContain('diff --git a/src/a.ts b/src/a.ts')
    expect(h0.patch).toContain('+new')
    expect(h0.patch).not.toContain('+insert') // second hunk must be excluded
  })

  it('ignores orphan lines before first diff header', () => {
    const garbage = `some noise
more noise
` + TWO_FILE_DIFF
    const files = parseUnifiedDiff(garbage)
    expect(files).toHaveLength(2)
  })

  it('tolerates missing hunk start line in @@ header', () => {
    const weird = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ malformed @@
+foo
`
    const files = parseUnifiedDiff(weird)
    expect(files).toHaveLength(1)
    expect(files[0].hunks[0].startLine).toBe(0)
  })

  it('handles trailing "\\ No newline at end of file" markers', () => {
    const diff = `diff --git a/a b/a
--- a/a
+++ b/a
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
`
    const files = parseUnifiedDiff(diff)
    expect(files[0].added).toBe(1)
    expect(files[0].removed).toBe(1)
  })
})

describe('diffStat', () => {
  it('aggregates totals across files', () => {
    const files = parseUnifiedDiff(TWO_FILE_DIFF)
    const stat = diffStat(files)
    expect(stat.files).toBe(2)
    expect(stat.added).toBe(5)
    expect(stat.removed).toBe(2)
    expect(stat.hunks).toBe(3)
  })

  it('returns zeros for empty diff', () => {
    expect(diffStat([])).toEqual({ files: 0, added: 0, removed: 0, hunks: 0 })
  })
})

describe('hunkPatch', () => {
  it('returns the pre-built patch string', () => {
    const files = parseUnifiedDiff(TWO_FILE_DIFF)
    expect(hunkPatch(files[0].hunks[0])).toBe(files[0].hunks[0].patch)
  })
})
