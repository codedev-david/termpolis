// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  CANDIDATE_IMPORTANCE,
  CANDIDATE_SCORE,
  CANDIDATE_TAG,
  KEEP_SCORE,
  LESSON_AGENT_ID,
  importanceForScore,
  isCandidate,
  lessonSubstance,
  substanceBand,
  withoutCandidates,
} from '../../src/main/lessonSubstance'

// The substance gate scores what a stored lesson SAYS, from its text alone. Every sentence below is
// invented; none comes from a real memory store.

describe('the bars', () => {
  it('keeps at 2, holds back at 1, drops below', () => {
    expect(KEEP_SCORE).toBe(2)
    expect(CANDIDATE_SCORE).toBe(1)
    expect(CANDIDATE_TAG).toBe('candidate')
    expect(substanceBand(5)).toBe('keep')
    expect(substanceBand(2)).toBe('keep')
    expect(substanceBand(1)).toBe('candidate')
    expect(substanceBand(0)).toBe('drop')
    expect(substanceBand(-4)).toBe('drop')
  })

  it('sets a keeper\'s importance from its score, from the anticipate bar upward', () => {
    expect(importanceForScore(2)).toBe(0.6)
    expect(importanceForScore(3)).toBe(0.7)
    expect(importanceForScore(4)).toBe(0.8)
    expect(importanceForScore(5)).toBe(0.9)
    expect(importanceForScore(40)).toBe(0.9) // capped
    expect(importanceForScore(-3)).toBe(0.6) // floored: only keepers are ever sent here
    expect(importanceForScore(Number.NaN)).toBe(0.6)
    // A candidate sits below the 0.6 bar memory_anticipate uses, so it can never qualify on importance.
    expect(CANDIDATE_IMPORTANCE).toBe(0.45)
    expect(CANDIDATE_IMPORTANCE).toBeLessThan(importanceForScore(KEEP_SCORE))
  })
})

describe('isCandidate / withoutCandidates', () => {
  it('reads the tag off any row shape and never throws', () => {
    expect(isCandidate({ tags: ['candidate'] })).toBe(true)
    expect(isCandidate({ tags: ['x', 'candidate', 'y'] })).toBe(true)
    expect(isCandidate({ tags: ['x'] })).toBe(false)
    expect(isCandidate({ tags: [] })).toBe(false)
    expect(isCandidate({})).toBe(false)
    expect(isCandidate({ tags: 'candidate' as unknown as string[] })).toBe(false)
    expect(isCandidate(null as unknown as object)).toBe(false)
    expect(isCandidate(undefined as unknown as object)).toBe(false)
  })

  // `candidate` is an ordinary word. An agent that tags a note of its own with it (a hiring note, a candidate fix)
  // must not find that note gone from every recall: only what groundEpisode wrote, under its own agent id, is held
  // back. A row that does not say who wrote it (a primer hit, a consolidation entry) is judged by its tag alone.
  it('holds back only what the lesson writer stored: an agent\'s own note carrying the word is shown as usual', () => {
    expect(LESSON_AGENT_ID).toBe('mneme')
    expect(isCandidate({ tags: ['candidate'], agentId: 'mneme' })).toBe(true)
    expect(isCandidate({ tags: ['candidate'], agentId: undefined })).toBe(true)
    expect(isCandidate({ tags: ['candidate'] })).toBe(true)
    expect(isCandidate({ tags: ['candidate'], agentId: 'claude' })).toBe(false)
    expect(isCandidate({ tags: ['candidate'], agentId: 'user' })).toBe(false)
    expect(isCandidate({ tags: ['candidate'], agentId: '' })).toBe(false)
    expect(isCandidate({ tags: ['candidate'], agentId: null })).toBe(false)
    const own = { id: 'own', agentId: 'codex', tags: ['candidate', 'hiring'] }
    const held = { id: 'held', agentId: 'mneme', tags: ['candidate'] }
    expect(withoutCandidates([own, held]).map((r) => r.id)).toEqual(['own'])
  })

  it('takes anything that is not an object for an ordinary row', () => {
    for (const row of ['candidate', 7, true, Symbol.iterator]) expect(isCandidate(row)).toBe(false)
  })

  it('hands back anything that is not a list exactly as it came, rather than throw on a read path', () => {
    const notAList = { nodes: [], edges: [] }
    expect(withoutCandidates(notAList as unknown as unknown[])).toBe(notAList)
    expect(withoutCandidates(null as unknown as unknown[])).toBeNull()
    expect(withoutCandidates(undefined as unknown as unknown[])).toBeUndefined()
  })

  it('drops candidates and hands back the same array when there are none', () => {
    const plain = [{ id: 'a', tags: ['x'] }, { id: 'b' }]
    expect(withoutCandidates(plain)).toBe(plain)
    const mixed = [{ id: 'a' }, { id: 'b', tags: ['candidate'] }, { id: 'c', tags: ['y'] }]
    expect(withoutCandidates(mixed).map((r) => r.id)).toEqual(['a', 'c'])
    expect(withoutCandidates([])).toEqual([])
  })
})

// One per junk shape found in the study of a real store, re-created with invented text.
const JUNK: Array<[shape: string, text: string, reason: string | null]> = [
  ['announcement', 'Root cause found.', 'announcement -3'],
  ['next marker', 'Next:', 'announcement -3'],
  ['memory updated', 'Memory updated.', 'announcement -3'],
  ['first-person plan', "I'll now run the full suite, then push the branch and tell the team tomorrow.", 'progress -2'],
  ['time-bound status', 'Still in progress today; waiting on the reviewer, will pick it up this afternoon.', 'progress -4'],
  ['table row', '| **Owner** | Not decided yet, revisit next sprint |', 'progress -1'],
  ['commit-hash dump', 'Commits so far: 3fa9c21, b81d0e4, 9c7e5a2 and e04b6d8, all pushed.', 'hashes -2'],
  ['json residue', '{"status":"ok","count":3,"items":[{"id":"a1"}]}', 'json -2'],
  ['too short', 'Fixed it.', 'short -2'],
  ['question to the user', 'Want me to send either of the two messages and then write up the follow-up pull request?', null],
  ['dangling fragment', 'Here is what I found:', 'announcement -3'],
  ['test-run narration', '608 files passed (1 skipped), 14,626 tests passed (16 skipped), 0 failed on the first run.', null],
]

const GOOD: Array<[shape: string, text: string]> = [
  ['cause with identifiers', 'The watcher fired before `fs.writeFile` flushed, so `readState` saw an empty file; await the flush callback first.'],
  ['rule with a reason', 'Never call `app.quit()` from the `will-quit` handler because it re-enters the quit sequence and hangs.'],
  ['problem and fix', 'Problem: npm install dies with EACCES on the global prefix. → Fix: set a user-level prefix with `npm config set prefix`.'],
  ['environment gotcha', '`NPM_CONFIG_IGNORE_SCRIPTS=true` in the tool shell means `npm ci` never downloads the Electron binary.'],
  ['decision with a why', 'We use HNSW instead of brute force in `memoryIndex.ts` because the store holds 180k vectors.'],
  ['version pin', 'Pin `electron-builder` to 24.13.3: version 25 drops the `--publish never` handling and CI uploads every artifact twice.'],
  ['platform gotcha', 'On Windows `fs.rename` over an open file fails with EPERM; write a temp file in the same folder and rename it after closing.'],
  ['api semantics', '`memoryList` caps at 500 rows and has no offset, so page with the `before` cursor.'],
  ['test trap', '`vi.mock(\'fs\')` does not reach modules that import `node:fs`; inject the filesystem instead.'],
  ['ci gotcha', 'The coverage gate runs only when the Windows job runs, so a branch left uncovered passes in `vitest` locally and fails in CI.'],
  ['security rule', 'Redact secrets before hashing in `memoryWrite`, so that the content hash and the vector carry the redacted text.'],
  ['build setting', 'Set `NODE_OPTIONS=--max-old-space-size=4096` for the renderer build: vite runs out of heap on the editor bundle otherwise.'],
]

describe('lessonSubstance: the junk shapes', () => {
  it.each(JUNK)('drops %s', (_shape, text, reason) => {
    const r = lessonSubstance(text)
    expect(r.score).toBeLessThan(CANDIDATE_SCORE)
    expect(substanceBand(r.score)).toBe('drop')
    if (reason) expect(r.reasons).toContain(reason)
    else expect(r.reasons).toEqual([])
  })
})

describe('lessonSubstance: the good shapes', () => {
  it.each(GOOD)('keeps %s', (_shape, text) => {
    const r = lessonSubstance(text)
    expect(r.score).toBeGreaterThanOrEqual(KEEP_SCORE)
    expect(substanceBand(r.score)).toBe('keep')
    expect(r.reasons.length).toBeGreaterThan(0)
  })
})

describe('lessonSubstance: identifiers a later reader can search for', () => {
  const ids = (text: string): string | undefined => lessonSubstance(text).reasons.find((r) => r.startsWith('identifiers'))
  // Padding keeps every probe above the 60-character floor so only the identifier rule is in play.
  const pad = ' in the long run of the work that was done across the whole week'

  it('counts a backticked span', () => { expect(ids('Run `npm ci` first' + pad)).toBe('identifiers +1') })
  it('counts a file name', () => { expect(ids('See notes in swarmMemory.ts first' + pad)).toBe('identifiers +1') })
  it('counts camelCase', () => { expect(ids('The groundEpisode step runs first' + pad)).toBe('identifiers +1') })
  it('counts PascalCase with two humps', () => { expect(ids('The TerminalManager step runs first' + pad)).toBe('identifiers +1') })
  it('counts a SCREAMING code', () => { expect(ids('It fails with ENOENT on that path' + pad)).toBe('identifiers +1') })
  it('counts snake_case', () => { expect(ids('The memory_search call runs first' + pad)).toBe('identifiers +1') })

  it('does not count ordinary words, versions, common acronyms or shouting', () => {
    expect(ids('The Linux build on v1.54.4 follows the API and JSON rules, NEVER the old ones' + pad)).toBeUndefined()
    expect(ids('Build 12.3 and e.g. the thing, i.e. nothing ECMAScript' + pad)).toBeUndefined()
  })

  it('counts each identifier once, whatever its case or how often it recurs', () => {
    expect(ids('Run `memoryWrite` then memoryWrite then MEMORYWRITE again' + pad)).toBe('identifiers +1')
  })

  it('adds up to +3 and no more', () => {
    expect(ids('Run `npm ci`, then groundEpisode, then memory_search' + pad)).toBe('identifiers +3')
    expect(ids('Run `npm ci`, groundEpisode, memory_search, ENOENT and notes.md' + pad)).toBe('identifiers +3')
  })

  it('ignores a backtick span that is blank or one character once trimmed', () => {
    expect(ids('Run `x` first' + pad)).toBeUndefined()
    expect(ids('Run `  ` and ` x ` first' + pad)).toBeUndefined()
  })

  it('counts a backticked name and the same name outside ticks once, and a file name once', () => {
    expect(ids('Run `app.quit()` first' + pad)).toBe('identifiers +1') // one span, not the span plus a file-like "app.quit"
    expect(ids('Read swarmMemory.ts first' + pad)).toBe('identifiers +1') // a file whose name is also camelCase
    expect(ids('Read src/main/lessonSubstance.ts first' + pad)).toBe('identifiers +1')
  })
})

describe('lessonSubstance: a rule or a mechanism', () => {
  const connective = (text: string): boolean => lessonSubstance(text).reasons.includes('connective +2')
  const pad = ' while the work was being done across the whole week of the release'

  it.each([
    'because', 'so that', 'in order to', 'only when', 'only if', 'never', 'always', 'must', 'instead of',
    'rather than', 'unless', 'otherwise', 'which means', 'due to', 'caused by', 'therefore', 'whenever',
    'as long as', 'turns out', 'the reason', "don't", 'do not', 'avoid', 'requires',
  ])('recognises "%s"', (word) => {
    expect(connective(`The cache holds ${word} the key changes` + pad)).toBe(true)
  })

  it('adds +2 once, however many connectives there are', () => {
    const r = lessonSubstance('Never do this because it breaks, unless you must, instead of waiting' + pad)
    expect(r.reasons.filter((x) => x.startsWith('connective'))).toEqual(['connective +2'])
  })

  it('does not take a bare "so" or "since" for a rule', () => {
    expect(connective('The old values are saved, so some of them come back since the last run' + pad)).toBe(false)
  })
})

describe('lessonSubstance: announcements with no content', () => {
  const announced = (text: string): boolean => lessonSubstance(text).reasons.includes('announcement -3')

  it.each([
    'Root cause found.', 'The root cause is found', 'Found the root cause!', 'Found it.', 'Bug identified.',
    'Next:', 'Next steps:', 'Next - ', 'Memory updated', 'Notes saved.', 'Done.', 'Finished', 'All set.',
    'Got it.', 'OK, understood.', 'Noted.', 'Here is what I found:', "Here's the plan:", 'See above.', 'See below for more',
    'The rest:', '- Done.', '**Next:**',
  ])('catches "%s"', (text) => { expect(announced(text)).toBe(true) })

  it('lets the same opening stand when real content follows it', () => {
    expect(announced('Root cause found. The watcher fired before the file was flushed to disk.')).toBe(false)
    expect(announced('Next steps: rotate the signing key, then rebuild the installer on the clean runner.')).toBe(false)
  })

  it('does not mistake an ordinary sentence for one', () => {
    expect(announced('Nexus is the artifact store the pipeline pushes to and reads from again.')).toBe(false)
    expect(announced('Doneness of the build is decided by the exit code of the last step run.')).toBe(false)
  })
})

describe('lessonSubstance: progress and time-bound markers', () => {
  const progress = (text: string): string | undefined => lessonSubstance(text).reasons.find((r) => r.startsWith('progress'))
  const pad = ' with the long list of other things that had to be looked at in the repository'

  it('takes 1 off for each marker', () => {
    expect(progress("I'll look at that" + pad)).toBe('progress -1')
    expect(progress("I'll look at that today" + pad)).toBe('progress -2')
    expect(progress("Let me look at that today, I'm on it" + pad)).toBe('progress -3')
  })

  it('stops at -4', () => {
    expect(progress("I'll do it today, tomorrow, tonight and this week, currently, right now" + pad)).toBe('progress -4')
  })

  it.each([
    'today', 'yesterday', 'tomorrow', 'tonight', 'this morning', 'this week', 'just now', 'right now', 'at the moment',
    'currently', 'for now', 'so far', 'in progress', 'pending', 'waiting for', 'waiting on', 'todo', 'to-do', 'next sprint', 'still open',
    "I'll", "I’ll", "I'm", 'I am', "I've", 'I have', 'I can', 'let me', "let's", "we'll", 'we are', 'going to', 'now I',
  ])('counts "%s"', (marker) => {
    expect(progress(`The queue is ${marker} the queue is` + pad)).toBe('progress -1')
  })

  it('leaves a plain third-person statement alone', () => {
    expect(progress('The queue drains in order and never reorders items that share a key' + pad)).toBeUndefined()
  })
})

describe('lessonSubstance: length', () => {
  const reasons = (n: number): string[] => lessonSubstance('a'.repeat(n)).reasons

  it('takes 2 off under 60 characters', () => {
    expect(reasons(59)).toContain('short -2')
    expect(reasons(60)).not.toContain('short -2')
    expect(lessonSubstance('').reasons).toContain('short -2')
  })

  it('measures the trimmed text', () => {
    expect(lessonSubstance(`   ${'a'.repeat(58)}   `).reasons).toContain('short -2')
  })

  it('takes 1 off at 580 characters or more, where the distiller truncates', () => {
    expect(reasons(579)).not.toContain('long -1')
    expect(reasons(580)).toContain('long -1')
    expect(reasons(2000)).toContain('long -1')
  })
})

describe('lessonSubstance: bare commit hashes', () => {
  const hashes = (text: string): boolean => lessonSubstance(text).reasons.includes('hashes -2')
  const pad = ' while the work was being done across the whole week of the release cycle'

  it('takes 2 off for three or more, but not for one or two', () => {
    expect(hashes('Landed in 3fa9c21' + pad)).toBe(false)
    expect(hashes('Landed in 3fa9c21 and b81d0e4' + pad)).toBe(false)
    expect(hashes('Landed in 3fa9c21, b81d0e4 and 9c7e5a2' + pad)).toBe(true)
  })

  it('counts only hex that has a digit and a letter, like a real SHA', () => {
    expect(hashes('Ids 1234567, 7654321 and 1234567890 appear' + pad)).toBe(false)
    expect(hashes('Words deadbeef, facade and decade and deface appear' + pad)).toBe(false)
    expect(hashes('Landed in 3FA9C21, B81D0E4 and 9C7E5A2' + pad)).toBe(true)
  })
})

describe('lessonSubstance: json residue', () => {
  const json = (text: string): boolean => lessonSubstance(text).reasons.includes('json -2')
  const pad = ' while the work was being done across the whole week of the release cycle'

  it('catches an object or array that opens the text', () => {
    expect(json('{"a":1}' + pad)).toBe(true)
    expect(json('  [{"a":1}]' + pad)).toBe(true)
    expect(json('[ "x", "y" ]' + pad)).toBe(true)
  })

  it('catches three or more key/value pairs', () => {
    expect(json('Got a "id": 1 and "name": "x" and "ok": true' + pad)).toBe(true)
  })

  it('catches escaped quotes and unicode escapes left from stringifying', () => {
    expect(json('He said \\"hello\\" to them' + pad)).toBe(true)
    expect(json('Cut at \\u00e9 and \\u2019 in the middle' + pad)).toBe(true)
  })

  it('leaves one inline setting, a path with backslashes and a single escape alone', () => {
    expect(json('Set `"strict": true` in the config file' + pad)).toBe(false)
    expect(json('The file lives at C:\\new\\table\\test\\notes and is read' + pad)).toBe(false)
    expect(json('The anchor had its \\u00b7 escape' + pad)).toBe(false)
  })
})

describe('lessonSubstance: the score adds up and the call is safe', () => {
  it('sums the features into an integer', () => {
    const r = lessonSubstance('Never call `app.quit()` from the `will-quit` handler: it re-enters the quit sequence and the app hangs.')
    expect(r.score).toBe(4) // identifiers +2, connective +2
    expect(r.reasons).toEqual(['identifiers +2', 'connective +2'])
    const bad = lessonSubstance("I'll rename `oldName` today.")
    expect(bad.score).toBe(-3) // identifiers +1, progress -2, short -2
    expect(bad.reasons).toEqual(['identifiers +1', 'progress -2', 'short -2'])
    expect(Number.isInteger(bad.score)).toBe(true)
  })

  it('gives the same answer every time, whatever was scored in between', () => {
    const a = 'Never call `app.quit()` from the `will-quit` handler because it hangs the whole app.'
    const first = lessonSubstance(a)
    lessonSubstance('Root cause found.')
    lessonSubstance("I'll do it today and tomorrow, 3fa9c21 b81d0e4 9c7e5a2")
    expect(lessonSubstance(a)).toEqual(first)
  })

  it.each<[string, unknown]>([
    ['empty', ''],
    ['blank', '   \n\t  '],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { content: 'x' }],
    ['five million characters', 'x '.repeat(2_500_000)],
    ['binary', String.fromCharCode(...Array.from({ length: 4000 }, (_, i) => (i * 7919) % 256))],
    ['NULs', '\0'.repeat(1000)],
    ['a lone surrogate', 'ab\ud800cd'],
    ['a hundred thousand backticks', '`'.repeat(100_000)],
    ['one very long token', `${'a.'.repeat(5000)}b`],
    ['a long run of path characters', '/a'.repeat(6000)],
  ])('never throws on %s', (_what, input) => {
    const r = lessonSubstance(input as string)
    expect(Number.isFinite(r.score)).toBe(true)
    expect(Array.isArray(r.reasons)).toBe(true)
  })

  it('does not go quadratic on a hostile long token', () => {
    const t0 = Date.now()
    lessonSubstance(`${'a.'.repeat(20_000)}b`)
    lessonSubstance(`${'a-'.repeat(20_000)}`)
    expect(Date.now() - t0).toBeLessThan(250)
  })

  it('scores 10,000 lessons in under 500 ms (best of three, so a busy machine does not flap it)', () => {
    const golden = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'lessonsGolden.json'), 'utf8')) as { lessons: Array<{ content: string }> }
    const texts: string[] = []
    for (let i = 0; i < 10_000; i++) texts.push(golden.lessons[i % golden.lessons.length].content)
    let best = Infinity
    for (let run = 0; run < 3; run++) {
      const t0 = Date.now()
      for (const t of texts) lessonSubstance(t)
      best = Math.min(best, Date.now() - t0)
    }
    expect(best).toBeLessThan(500)
  })
})

describe('the golden file: 60 invented lessons, 20 per class', () => {
  const golden = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'lessonsGolden.json'), 'utf8')) as {
    synthetic: boolean
    lessons: Array<{ id: string; label: 'usable' | 'marginal' | 'not-usable'; content: string }>
  }
  const of = (label: string) => golden.lessons.filter((l) => l.label === label)
  const keepRate = (label: string, from = KEEP_SCORE): number =>
    of(label).filter((l) => lessonSubstance(l.content).score >= from).length / of(label).length
  const mean = (label: string): number =>
    of(label).reduce((s, l) => s + lessonSubstance(l.content).score, 0) / of(label).length

  it('is what it says it is', () => {
    expect(golden.synthetic).toBe(true)
    expect(golden.lessons).toHaveLength(60)
    expect(of('usable')).toHaveLength(20)
    expect(of('marginal')).toHaveLength(20)
    expect(of('not-usable')).toHaveLength(20)
    expect(new Set(golden.lessons.map((l) => l.id)).size).toBe(60)
    expect(new Set(golden.lessons.map((l) => l.content)).size).toBe(60)
  })

  it('carries no private text: no home-folder path, e-mail address or URL', () => {
    const all = JSON.stringify(golden)
    expect(all).not.toMatch(/Users[\\/]|\/home\/|@[a-z0-9-]+\.[a-z]{2,}|https?:\/\//i)
  })

  // These two lines are the regression guard: a change to the gate that loses usable lessons or lets
  // narration through fails here. They describe the mechanism on invented text, not real-world precision.
  it('keeps at least 90% of the usable lessons', () => {
    expect(keepRate('usable')).toBeGreaterThanOrEqual(0.9)
  })

  it('keeps at most 15% of the not-usable lessons', () => {
    expect(keepRate('not-usable')).toBeLessThanOrEqual(0.15)
  })

  it('ranks usable above marginal above not usable', () => {
    expect(keepRate('marginal')).toBeLessThan(keepRate('usable'))
    expect(mean('usable')).toBeGreaterThan(mean('marginal'))
    expect(mean('marginal')).toBeGreaterThan(mean('not-usable'))
  })

  it('writes almost nothing of the not-usable class at all', () => {
    expect(keepRate('not-usable', CANDIDATE_SCORE)).toBeLessThanOrEqual(0.2)
  })
})
