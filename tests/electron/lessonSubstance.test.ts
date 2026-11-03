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
  ['time-bound status', 'Still in progress today; waiting on the reviewer, will pick it up this afternoon.', 'progress -3'],
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
    'as long as', 'the reason', "don't", 'do not', 'avoid', 'requires',
  ])('recognises "%s"', (word) => {
    expect(connective(`The cache holds ${word} the key changes` + pad)).toBe(true)
  })

  it('adds +2 once, however many connectives there are', () => {
    const r = lessonSubstance('Never do this because it breaks, unless you must, instead of waiting' + pad)
    expect(r.reasons.filter((x) => x.startsWith('connective'))).toEqual(['connective +2'])
  })

  // "turns out" reports what someone found, and it is the extractor's own gotcha trigger: a sentence on it that says nothing more
  // used to be kept on that alone ("It turns out the file was already there, so I skipped that step." scored 2).
  it('does not take "turns out" for a rule or a mechanism', () => {
    expect(connective('It turns out the file was already there' + pad)).toBe(false)
    expect(connective('It turns out the file was already there, so I skipped that step' + pad)).toBe(false)
    expect(lessonSubstance('It turns out the file was already there, so I skipped that step.').score).toBeLessThan(KEEP_SCORE)
  })

  // A bare "so" or "since" is as common in narration as in explanation. Each counts where it joins a cause to what follows, and
  // only next to something a reader can search for: every lesson below names `ready`, so the word is all that differs.
  describe('a bare "so" or "since"', () => {
    const named = (clause: string): boolean => connective(`In \`ready\` ${clause}` + pad)

    it.each([
      'the watcher fires twice, so debounce the handler',
      'the watcher fires twice; so debounce the handler',
      'the watcher fires twice, so `debounce` the handler', // what follows may start with a backtick
      'the watcher fires twice, so (debounce it)',
      'the watcher fires twice, so  debounce the handler', // two spaces after "so"
      'the watcher fires twice,  so debounce the handler', // and before it
      'the watcher fires twice,\nso debounce the handler', // a wrapped line
      'the watcher fires twice, So debounce the handler',
      'the Tray is destroyed, since Electron destroys it on relaunch',
      'cap it at 200 MB since the viewer cannot open more', // a "since" needs no comma
      'Since the cache is cold, the first call is slow',
      'it is slow, since `v8` is cold', // a name in ticks is not a version
      'it is slow, since versions differ',
      // the words that make a clause "about the speaker" or "about when" are whole words
      'it fires twice, so it needs a debounce',
      'it fires twice, so weak refs are dropped',
      'it fires twice, so letters are doubled',
      'it fires twice, so farther listeners miss it',
      'it is slow, since lasting caches miss',
    ])('counts: %s', (clause) => {
      expect(named(clause)).toBe(true)
    })

    it.each([
      'we kept it, so I can put it back',
      'we kept it, so we can put it back',
      "we kept it, so let's put it back",
      'we kept it, so my notes are there',
      'we kept it, so our notes are there',
      'we kept it, so  I can put it back', // two spaces do not get a first-person clause past the check
      'we kept it, so\tI can put it back',
      'it works, so far',
      'it works, so  far',
      'we kept it, so I',
      'So the handler runs', // not after a comma or a semicolon
      // a colon is how a label ends ("Problem:", "Gotcha:", "Step 1:"), and a "So" after a label is a filler, not a cause
      'the watcher fires twice: so debounce the handler',
      'Problem: So `ci.yml` failed on the runner.',
      'Gotcha: so the build crashed with `ENOSPC`',
      'Step 1: so install the tool',
      'it works so the handler runs',
      'we kept it - so the handler runs',
      'the watcher fires twice,so debounce the handler', // nothing between the comma and "so"
      'we kept it, some of them come back', // not the word
      'we kept it, soon after',
      'we kept it, so-called notes',
      'a sincere apology',
      'it is slow, nonsince caches miss', // a word that only ends in "since"
      'it broke since this morning',
      'it broke since last week',
      'it broke since yesterday',
      'it broke since today',
      'it broke since tonight',
      'it broke since tomorrow',
      'it works since then',
      'it broke since the morning',
      'it broke since the afternoon',
      'it broke since the evening',
      'it broke since the start of the run',
      'it broke since the beginning of the run',
      'it broke since Monday',
      'it broke since tuesday',
      'it broke since Wednesday',
      'it broke since thursday',
      'it broke since FRIDAY',
      'it broke since Saturday',
      'it broke since sunday',
      'it broke since January',
      'it broke since february',
      'it broke since March',
      'it broke since April',
      'it broke since May',
      'it broke since June',
      'it broke since July',
      'it broke since August',
      'it broke since September',
      'it broke since October',
      'it broke since November',
      'it broke since December',
      'it broke since 2025',
      'it broke since 3 days',
      'it broke since v1.54',
      'it broke ever since the update',
      // the exclusions of "since" hold for wrapped and double-spaced text too, not only for a single space
      'it broke ever  since the update',
      'it broke ever\nsince the update',
      'it broke since the  morning',
      'it broke since the\nmorning',
      'it broke since the\tstart of the run',
    ])('does not count: %s', (clause) => {
      expect(named(clause)).toBe(false)
    })

    // The heuristic distiller writes "Problem: <sentence> -> Fix: <sentence>", and a turn that opens with "So" gives "Problem: So ...".
    // Neither lesson says anything, and neither is a cause joined to a consequence.
    it('does not lift the lessons the distiller writes after a filler "So" past the bar', () => {
      for (const text of [
        'Problem: So `ci.yml` failed on the runner. → Fix: Fixed by pushing again.',
        'Problem: So the build crashed with `ENOSPC`. → Fix: I fixed it.',
      ]) {
        expect(connective(text)).toBe(false)
        expect(lessonSubstance(text).score).toBeLessThan(KEEP_SCORE)
      }
    })

    it('does not count a "so" or "since" that ends the lesson (nothing follows it to join)', () => {
      expect(connective('In `ready` it broke, so')).toBe(false)
      expect(connective('In `ready` it broke since')).toBe(false)
    })

    it('does not count without something searchable in the lesson, which is what keeps status lines out', () => {
      for (const text of [
        'The deploy finished, so the new version is live.',
        'The tests passed, so the PR is ready for review.',
        'The reviewer has not answered yet, so the merge is pending.',
        'The branch is up to date, so no rebase is needed.',
        'The watcher fires twice, so debounce the handler by 50 ms' + pad,
        'Cap reports at 200 MB since the viewer cannot open more' + pad,
      ]) {
        expect(connective(text)).toBe(false)
        expect(lessonSubstance(text).score).toBeLessThan(KEEP_SCORE)
      }
    })

    it('lifts a lesson with one name in it from held back to kept, and a strong word needs no name', () => {
      const withName = 'Watch out: `fs.watch` fires twice on Windows for a single save, so debounce the handler by 50 ms.'
      expect(lessonSubstance(withName)).toEqual({ score: 3, reasons: ['identifiers +1', 'connective +2'] })
      const without = withName.replace('`fs.watch`', 'the file watcher')
      expect(lessonSubstance(without).score).toBe(0)
      expect(connective('The file watcher fires twice because a save writes twice' + pad)).toBe(true)
    })

    it('counts one "so" or "since" once, and a strong word with it still adds +2 once', () => {
      const r = lessonSubstance('Never skip `ready`, since Electron destroys the tray, so re-create it, because the user sees it' + pad)
      expect(r.reasons.filter((x) => x.startsWith('connective'))).toEqual(['connective +2'])
    })

    it('reads a long lesson in the time it reads a short one', () => {
      const long = 'x, so '.repeat(150) + 'since '.repeat(150) + ' '.repeat(600)
      const t0 = Date.now()
      lessonSubstance('`ready` ' + long)
      expect(Date.now() - t0).toBeLessThan(500)
    })
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
    'currently', 'for now', 'so far', 'in progress', 'awaiting', 'todo', 'to-do', 'upcoming', 'next sprint', 'still running', 'still failing',
    'still broken', "I'll", "I’ll", "I'm", 'I am', "I've", 'I have', 'I can', 'let me', 'we are', "we're", 'gonna', 'now I',
    // and the rest of the vocabulary, so that dropping any one of them fails a test
    'I will', "I'd", 'I could', 'I should', 'I need to', 'I want to', "we've", 'next I', 'then I', 'this afternoon', 'this evening',
    'this session', 'this sprint', 'later today', 'earlier today', 'last night', 'next week', 'next release', 'next step', 'next steps',
  ])('counts "%s"', (marker) => {
    expect(progress(`The queue is ${marker} the queue is` + pad)).toBe('progress -1')
  })

  it('leaves a plain third-person statement alone', () => {
    expect(progress('The queue drains in order and never reorders items that share a key' + pad)).toBeUndefined()
  })

  // These are as common in a lesson that holds as in one that does not, so they are not counted: the phrases the distiller turns a
  // decision into a lesson on, and engineering words whose meaning is not about the passage of time. Every sentence is invented.
  describe('what is not progress: the decision triggers of the distiller, and engineering vocabulary', () => {
    it.each([
      ["we'll", "We'll use `execFile` for git calls instead of `exec` because it never goes through a shell.", 'keep'],
      ["let's", "Let's use the `before` timestamp for paging because `memoryList` has no offset parameter.", 'keep'],
      ['we will', 'We will use `execFile` for git calls instead of `exec` because it never goes through a shell.', 'keep'],
      ['let us', 'Let us use the `before` timestamp for paging because `memoryList` has no offset parameter.', 'keep'],
      ['pending', 'A promise stays pending until `resolve` is called, so await it before reading `result` or you will see undefined.', 'keep'],
      // one identifier and no reason: held back, where counting "pending" against it had dropped it
      ['pending (a test)', 'Tests that are pending in `vitest` still count toward the total and a skipped suite hides a failing import.', 'candidate'],
      ['waiting on', 'The worker is waiting on the `index.lock` file; remove the stale lock only when no git process is running.', 'keep'],
      ['waiting for', 'Waiting for the `will-quit` event is wrong here because the memory host exits first and the final flush never runs.', 'keep'],
      ['ongoing', 'An ongoing `git rebase` leaves `.git/rebase-merge` in place, so `git status` reports the branch as detached until it finishes.', 'keep'],
      ['going to', 'The handler is going to receive the raw buffer, not a string, when `encoding` is omitted from `readFile`.', 'keep'],
      ['still open', 'The old handle was still open, which is why `fs.rename` failed with EPERM on Windows.', 'keep'],
    ])('does not count %s', (_marker, lesson, band) => {
      expect(progress(lesson)).toBeUndefined()
      expect(substanceBand(lessonSubstance(lesson).score)).toBe(band)
    })

    it('still counts the first-person and the time-bound ones next to them', () => {
      expect(progress("We'll use `execFile` today because it never goes through a shell." + pad)).toBe('progress -1') // today, not we'll
      expect(progress('The build is currently pending, still running, and we are waiting on it' + pad)).toBe('progress -3') // currently, still running, we are
    })
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

  // One Han, kana or Hangul character carries about a word, so 30 of them are as long as 60 Latin letters. A lesson written in them
  // is not too short to hold a cause and a fix for that reason.
  describe('in a script where one character is a word', () => {
    const short = (t: string): boolean => lessonSubstance(t).reasons.includes('short -2')

    it('counts each Chinese, Japanese or Korean character as two against the 60-character floor', () => {
      expect(short('字'.repeat(29))).toBe(true) // 58
      expect(short('字'.repeat(30))).toBe(false) // 60
      expect(short('あ'.repeat(30))).toBe(false) // kana
      expect(short('한'.repeat(30))).toBe(false) // Hangul
      expect(short('ア'.repeat(29))).toBe(true)
      expect(short('ᄀ'.repeat(30))).toBe(false) // Hangul Jamo (U+1100)
      expect(short('㐀'.repeat(30))).toBe(false) // Han, extension A (U+3400)
      expect(short('\uF900'.repeat(30))).toBe(false) // Han compatibility ideograph; an escape, because typed it is normalised to U+8C48, a different range
    })

    it('counts the full-width forms, and mixed text by what each character is', () => {
      expect(short('Ａ'.repeat(30))).toBe(false) // full-width Latin
      expect(short('ab' + '字'.repeat(29))).toBe(false) // 31 characters, 2 + 58 = 60
      expect(short('abc' + '字'.repeat(28))).toBe(true) // 31 characters, 3 + 56 = 59
    })

    // Every range is held at both of its ends, and by the character just outside each: a range that gave up its first or last
    // character, or took one more, would change which lessons are short with no other test noticing. The characters are made from
    // their code points: typed, a compatibility ideograph is normalised to a different range (see above).
    describe.each([
      ['Hangul Jamo', 0x1100, 0x11ff],
      ['Hiragana and Katakana', 0x3040, 0x30ff],
      ['Han, extension A', 0x3400, 0x4dbf],
      ['Han', 0x4e00, 0x9fff],
      ['Hangul syllables', 0xac00, 0xd7af],
      ['Han compatibility ideographs', 0xf900, 0xfaff],
      ['half-width and full-width forms', 0xff00, 0xffef],
    ])('the range of %s', (_name, lo, hi) => {
      const thirty = (code: number): string => String.fromCharCode(code).repeat(30)
      it('counts its first and its last character as wide', () => {
        expect(short(thirty(lo))).toBe(false)
        expect(short(thirty(hi))).toBe(false)
        expect(short(thirty(Math.floor((lo + hi) / 2)))).toBe(false)
      })
      it('counts the character before it and the one after it as one', () => {
        // U+FEFF, the character before the last range, is a space to trim(): the one before that stands in for it.
        expect(short(thirty(lo === 0xff00 ? 0xfefe : lo - 1))).toBe(true)
        expect(short(thirty(hi + 1))).toBe(true)
      })
    })

    it('counts U+4E00, the commonest Han character, as wide', () => {
      expect(short('一'.repeat(30))).toBe(false)
      expect(short('一'.repeat(29))).toBe(true)
    })

    it('leaves Latin text exactly as it was, and never makes a long text short', () => {
      expect(short('a'.repeat(59))).toBe(true)
      expect(short('a'.repeat(60))).toBe(false)
      expect(short('字'.repeat(500))).toBe(false)
    })

    it('lets a dense lesson that names something be kept, which the old count called too short', () => {
      const lesson = '在 Windows 上使用 `fs.rename` 替换被占用的文件会因 EPERM 失败，应先关闭句柄。'
      expect(lesson.length).toBeLessThan(60)
      expect(lessonSubstance(lesson).reasons).not.toContain('short -2')
      expect(substanceBand(lessonSubstance(lesson).score)).toBe('keep')
    })
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

// The numbers each rule turns on. A rule that moves by one character should fail a test, not change what agents are shown.
describe('lessonSubstance: the edges of each rule', () => {
  const ids = (text: string): string | undefined => lessonSubstance(text).reasons.find((r) => r.startsWith('identifiers'))
  const reasons = (text: string): string => lessonSubstance(text).reasons.join(', ')
  const has = (text: string, reason: string): boolean => lessonSubstance(text).reasons.includes(reason)
  const pad = ' in the long run of the work that was done across the whole week'

  it('counts a plain lower-case file name, which no code-case shape would catch', () => {
    expect(ids('Edit vite.config.ts first' + pad)).toBe('identifiers +1')
    expect(ids('Edit package.json first' + pad)).toBe('identifiers +1')
  })

  it('counts a two-character backticked span and a quoted command up to 60 characters, and no longer one', () => {
    expect(ids('Run `ls` first' + pad)).toBe('identifiers +1')
    expect(ids('Run `npm run build --workspaces --if-present` first' + pad)).toBe('identifiers +1') // 38 between the ticks
    expect(ids('Run `' + 'x'.repeat(31) + '` first' + pad)).toBe('identifiers +1') // 31: past a limit of 30
    expect(ids('Run `' + 'x'.repeat(60) + '` first' + pad)).toBe('identifiers +1')
    expect(ids('Run `' + 'x'.repeat(61) + '` first' + pad)).toBeUndefined() // over the cap: not a span, and not a code-case shape either
  })

  it('does not take a two-letter acronym for something to search for, and takes three letters', () => {
    expect(ids('The PR and the CI are green and ready' + pad)).toBeUndefined()
    expect(ids('It fails with ENOENT on that path' + pad)).toBe('identifiers +1')
    expect(ids('It dies with EOF on that pipe' + pad)).toBe('identifiers +1') // exactly three: the shortest that counts
  })

  it('calls an opener an announcement only when fewer than four words follow it', () => {
    expect(reasons('Root cause found. Now fixing it.')).toContain('announcement -3') // three words follow
    expect(reasons('Root cause found. Now fixing it today.')).not.toContain('announcement') // four words follow
  })

  it('does not count a 6-character hex string, or plain words made only of the letters a to f, as commit hashes', () => {
    expect(has('Landed in 3fa9c2, b81d0e and 9c7e5a' + pad, 'hashes -2')).toBe(false) // a short SHA needs 7
    expect(has('Landed in 3fa9c2e, b81d0e4 and 9c7e5a1' + pad, 'hashes -2')).toBe(true)
    expect(has('The defaced, effaced and deedeed entries' + pad, 'hashes -2')).toBe(false) // hex letters only: words
  })

  it('takes two key/value pairs for an ordinary quoted setting and three for residue', () => {
    expect(has('Set "strict": true and "target": "es2020" in the config' + pad, 'json -2')).toBe(false)
    expect(has('Set "strict": true, "target": "es2020" and "lib": "dom" in the config' + pad, 'json -2')).toBe(true)
  })

  it('reads a key of up to 40 characters as a key, and a longer one as no key', () => {
    const key = (n: number): string => 'k'.repeat(n)
    const three = (n: number): string => `Set "${key(n)}": 1, "${key(n)}": 2 and "${key(n)}": 3 in the config` + pad
    expect(has(three(40), 'json -2')).toBe(true)
    expect(has(three(41), 'json -2')).toBe(false)
  })

  it('takes an object or array that opens the text for residue, and not one that opens a sentence', () => {
    expect(has('{"a": 1}' + pad, 'json -2')).toBe(true)
    expect(has('[{"a"' + pad, 'json -2')).toBe(true)
    expect(has('The list [1, 2, 3] is sorted before it is stored' + pad, 'json -2')).toBe(false)
  })

  // A lesson that opens with a bracket or a brace is not residue unless what follows it is the start of a key, a string or a
  // nested object: a tag in square brackets or a placeholder in braces is how a sentence opens.
  it('does not take a lesson for residue because it opens with a tag in brackets or a placeholder in braces', () => {
    expect(has('[Windows only] Never close a handle you do not own because EPERM follows' + pad, 'json -2')).toBe(false)
    expect(has('{note} Never close a handle you do not own because EPERM follows' + pad, 'json -2')).toBe(false)
    expect(has('  [Windows only] Never close a handle you do not own because EPERM follows' + pad, 'json -2')).toBe(false)
    expect(has('  { "a": 1 }' + pad, 'json -2')).toBe(true) // and the opener may be indented, with space inside it
    expect(has('[ [1, 2], [3] ]' + pad, 'json -2')).toBe(true)
  })

  // The distiller cuts a lesson at 600 characters; the gate reads the first 1,200 of whatever it is given.
  describe('the window it reads', () => {
    const filler = (n: number): string => 'The queue drains in order and keeps the items that share a key together. '.repeat(Math.ceil(n / 76)).slice(0, n)

    it('sees an identifier and a connective at character 500, where a lesson of the length the distiller keeps can carry them', () => {
      const text = filler(500) + 'because retryHelper never retries a 4xx'
      expect(text.length).toBeLessThan(580)
      expect(ids(text)).toBe('identifiers +1')
      expect(has(text, 'connective +2')).toBe(true)
    })

    it('reads to character 1,200 and no further', () => {
      const at = (n: number): string => filler(n) + ' because retryHelper never retries a 4xx'
      expect(has(at(1150), 'connective +2')).toBe(true)
      expect(ids(at(1150))).toBe('identifiers +1')
      expect(has(at(1250), 'connective +2')).toBe(false) // starts after the window
      expect(ids(at(1250))).toBeUndefined()
    })

    // A bare "so" or "since" is read through the same window as everything else: one that starts after it does not count, though
    // the name that would carry it is inside.
    it('reads a bare so or since to character 1,200 and no further', () => {
      const so = (n: number): string => 'In `ready` ' + filler(n) + ', so debounce the handler'
      const since = (n: number): string => 'In `ready` ' + filler(n) + ' cap it since the viewer cannot open more'
      for (const at of [so, since]) {
        expect(has(at(1100), 'connective +2')).toBe(true)
        expect(has(at(1250), 'connective +2')).toBe(false) // starts after the window
        expect(ids(at(1250))).toBe('identifiers +1') // and the name in the first words is still inside it
      }
    })

    // The window is 1,200 characters, to the character: a word that ends at 1,200 is inside it, one that ends at 1,201 is cut.
    it('takes a word that ends at character 1,200 and not one that ends a character later', () => {
      const xs = (n: number): string => 'x '.repeat(Math.ceil(n / 2)).slice(0, n) // no identifier, connective or marker in it
      const inside = xs(1192) + ' because' // 1,200 characters, the last of them the final letter of "because"
      const cut = xs(1193) + ' because' // 1,201 characters: the window ends one letter short of the word
      expect([inside.length, cut.length]).toEqual([1200, 1201])
      expect(has(inside, 'connective +2')).toBe(true)
      expect(has(cut, 'connective +2')).toBe(false)
    })

    it('still takes the length of the whole text for the long and the short penalty, not of the window', () => {
      expect(has(filler(5000), 'long -1')).toBe(true)
      expect(has('a'.repeat(59), 'short -2')).toBe(true)
    })
  })

  it('takes "I will" for a first-person progress marker: an identifier does not carry a promise to the bar', () => {
    const text = 'I will rename retryHelper in the next change to match the others'
    expect(lessonSubstance(text).reasons).toContain('progress -1')
    expect(substanceBand(lessonSubstance(text).score)).toBe('drop')
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

// What this file is, and is not. The 60 lessons were written, and labelled, by the author of the gate, who then tuned the gate
// until the bars below held: it is a REGRESSION PIN for the gate's own behaviour, and 95% / 5% on it is not a measured precision.
// Sets nobody tuned against (about 200 lessons invented afterwards and labelled before they were scored, and 35 lessons the
// extractor wrote from invented turns, labelled blind) keep about 80 to 85 percent of the usable lessons and 0 to 20 percent of
// the not usable ones, which is inside what research doc 6.3 allows of a single rater's thresholds (in-sample recall 0.67,
// weighted precision 0.45). Real labels (decision D4: David labelling 100 lessons) would replace these numbers, and are still open.
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
