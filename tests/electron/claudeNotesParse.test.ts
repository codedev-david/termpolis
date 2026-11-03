// Claude Code's saved notes, parsed into memory chunks. Everything here is PURE (text in, chunks
// out), so it needs no filesystem and no store. All note text below is synthetic.
import { describe, it, expect } from 'vitest'
import {
  MAX_CHUNK_CHARS,
  chunkNote,
  cwdsFromTranscript,
  encodeProjectFolder,
  hasNoteTags,
  isClaudeNote,
  isPortableType,
  noteFields,
  noteFileOfTags,
  noteTags,
  noteTypeOfTags,
  parseNote,
  projectCwdFor,
  withoutNotes,
  type ParsedNote,
} from '../../src/main/claudeNotesParse'

const NESTED = [
  '---',
  'name: widget_cache_rules',
  'description: "How the widget cache is invalidated: never by timer"',
  'metadata:',
  '  node_type: memory',
  '  type: feedback',
  '  originSessionId: 11111111-2222-3333-4444-555555555555',
  '---',
  '',
  'Invalidate on write, not on a timer.',
  '',
  '**Why:** a timer hides stale reads.',
].join('\n')

describe('parseNote: frontmatter', () => {
  it('reads the nested metadata form: name and description at the top, type under metadata', () => {
    expect(parseNote(NESTED, 'feedback_widget.md')).toEqual({
      name: 'widget_cache_rules',
      description: 'How the widget cache is invalidated: never by timer',
      type: 'feedback',
      body: 'Invalidate on write, not on a timer.\n\n**Why:** a timer hides stale reads.',
    })
  })

  it('reads the flat form: name, description and type all at the top', () => {
    const note = parseNote('---\nname: flat note\ndescription: one line\ntype: reference\n---\nBody text here.\n', 'x.md')
    expect(note).toEqual({ name: 'flat note', description: 'one line', type: 'reference', body: 'Body text here.' })
  })

  it('a top-level value beats the same key under metadata', () => {
    const note = parseNote('---\ntype: user\nmetadata:\n  type: project\n---\nSomething to say.', 'x.md')
    expect(note?.type).toBe('user')
  })

  it('strips matching quotes, unescapes a quoted double quote, and keeps colons inside the value', () => {
    const note = parseNote('---\nname: \'it\'\'s fine\'\ndescription: "say \\"hi\\": then go"\ntype: project\n---\nBody.', 'x.md')
    expect(note?.name).toBe("it's fine")
    expect(note?.description).toBe('say "hi": then go')
  })

  it('leaves an unquoted value with a hash in it alone (it is not a YAML comment here)', () => {
    const note = parseNote('---\nname: n\ndescription: fixes #123 for good\ntype: project\n---\nBody.', 'x.md')
    expect(note?.description).toBe('fixes #123 for good')
  })

  it('joins a folded or literal block description onto one line', () => {
    const note = parseNote('---\nname: n\ndescription: >\n  first part\n  second part\n\n  third part\ntype: project\n---\nBody.', 'x.md')
    expect(note?.description).toBe('first part second part third part')
    const lit = parseNote('---\nname: n\ndescription: |-\n  one\n  two\ntype: user\n---\nBody.', 'x.md')
    expect(lit?.description).toBe('one two')
    expect(lit?.type).toBe('user')
  })

  it('ignores comment lines, blank lines, lines that are not key: value, and nested keys outside metadata', () => {
    const note = parseNote([
      '---',
      '# a comment',
      '',
      'not a pair',
      'name: kept',
      'other:',
      '  type: user',
      'metadata:',
      '  type: reference',
      '---',
      'Body.',
    ].join('\n'), 'x.md')
    expect(note?.name).toBe('kept')
    expect(note?.type).toBe('reference') // the `type` under `other:` did not count
  })

  it('a `metadata:` key that carries a value on its own line does not open a block', () => {
    const note = parseNote('---\nname: n\nmetadata: inline\n  type: user\n---\nBody.', 'x.md')
    expect(note?.type).toBe('untyped')
  })

  it('a type it does not know, or none at all, is untyped; case is ignored', () => {
    expect(parseNote('---\nname: n\ntype: gossip\n---\nBody.', 'x.md')?.type).toBe('untyped')
    expect(parseNote('---\nname: n\n---\nBody.', 'x.md')?.type).toBe('untyped')
    expect(parseNote('---\nname: n\ntype: " Feedback "\n---\nBody.', 'x.md')?.type).toBe('feedback')
  })

  it('treats an unterminated frontmatter block as plain body text', () => {
    const note = parseNote('---\nname: n\nBody never closed', 'half.md')
    expect(note?.name).toBe('half')
    expect(note?.body).toContain('Body never closed')
  })
})

describe('parseNote: shapes of file', () => {
  it('reads a note with no frontmatter: the name is its first heading, the type is untyped', () => {
    const note = parseNote('# Deploy checklist\n\nRun the smoke test first.', 'deploy.md')
    expect(note).toEqual({ name: 'Deploy checklist', description: '', type: 'untyped', body: '# Deploy checklist\n\nRun the smoke test first.' })
  })

  it('falls back to the file name when there is no name and no heading', () => {
    expect(parseNote('Just a line.', 'plain_note.md')?.name).toBe('plain_note')
  })

  // The closing hashes of an ATX heading are not part of its name; a hash that is part of a word, or that stands alone, is.
  it.each([
    ['# Deploy checklist', 'Deploy checklist'],
    ['# Deploy checklist ##', 'Deploy checklist'],
    ['# Deploy checklist #', 'Deploy checklist'],
    ['## Deploy checklist \t## \t', 'Deploy checklist'],
    ['#   Deploy checklist   ', 'Deploy checklist'],
    ['# C#', 'C#'],
    ['# Deploy checklist##', 'Deploy checklist##'],
    ['# ##', '##'],
    ['# # #', '#'], // one level of closing hashes: the last
    ['# a ## b', 'a ## b'],
    ['# a # #', 'a #'],
    ['# a \t#\t #\t ', 'a \t#'],
  ])('reads the heading %j as the name %j', (heading, name) => {
    expect(parseNote(`${heading}\n\nText.`, 'f.md')?.name).toBe(name)
  })

  // A note is read on the main process, in the indexer's tick, and a file of any shape may be among them: a long run of blanks in a
  // heading must cost time in proportion to its length (it once cost its square, seconds for a note at the 64 KB limit).
  it('names a heading with a long run of blanks in it without taking seconds', () => {
    for (const blanks of [' ', ' \t']) {
      const heading = `# a${blanks.repeat(Math.floor(65_000 / blanks.length))}b`
      const started = performance.now()
      expect(parseNote(heading, 'f.md')?.name).toBe(`a${blanks.repeat(Math.floor(65_000 / blanks.length))}b`)
      expect(parseNote(`${heading} ##`, 'f.md')?.name).toBe(`a${blanks.repeat(Math.floor(65_000 / blanks.length))}b`)
      // Generous for a loaded CI box; the pattern it replaced took seconds on each of these.
      expect(performance.now() - started).toBeLessThan(1_000)
    }
  })

  it('survives a byte order mark and CRLF line endings', () => {
    const crlf = '﻿' + NESTED.replace(/\n/g, '\r\n')
    expect(parseNote(crlf, 'x.md')).toEqual(parseNote(NESTED, 'x.md'))
    expect(parseNote('---\r\nname: n\r\n---\r\nOne\r\rTwo', 'x.md')?.body).toBe('One\n\nTwo')
  })

  it('a note with only a description still has something to say; one with nothing does not', () => {
    expect(parseNote('---\nname: n\ndescription: only this\ntype: user\n---\n', 'x.md')).toMatchObject({ description: 'only this', body: '' })
    expect(parseNote('---\nname: n\ntype: user\n---\n  \n', 'x.md')).toBeNull()
    expect(parseNote('', 'x.md')).toBeNull()
    expect(parseNote('﻿   \r\n', 'x.md')).toBeNull()
  })
})

// Deterministic text with no repeats and no spaces, so chunks cut from it are all different.
const noise = (n: number): string => {
  let x = 12345
  return Array.from({ length: n }, () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return 'abcdefghijklmnopqrstuvwxyz'[x % 26] }).join('')
}

const note = (over: Partial<ParsedNote> = {}): ParsedNote => ({ name: 'cache rules', description: 'when to invalidate', type: 'reference', body: 'Invalidate on write.', ...over })

describe('chunkNote', () => {
  it('a short note is one chunk, prefixed with its name and description so it stands alone', () => {
    expect(chunkNote(note())).toEqual(['cache rules — when to invalidate\n\nInvalidate on write.'])
  })

  it('without a description the prefix is the name alone', () => {
    expect(chunkNote(note({ description: '' }))).toEqual(['cache rules\n\nInvalidate on write.'])
  })

  it('a note that is only a description is one chunk made of the prefix', () => {
    expect(chunkNote(note({ body: '' }))).toEqual(['cache rules — when to invalidate'])
  })

  it('a note with nothing at all gives no chunks', () => {
    expect(chunkNote(note({ name: '', description: '', body: '' }))).toEqual([])
  })

  // PRIVACY.md and DOCUMENTATION.md say "pieces of at most 1,800 characters" (the embedder reads about 512 tokens).
  it('keeps to 1,800 characters, to the character: a chunk of exactly that is one piece and one more is two', () => {
    expect(MAX_CHUNK_CHARS).toBe(1800)
    const head = 'cache rules — when to invalidate\n\n' // what every chunk of this note opens with
    const room = MAX_CHUNK_CHARS - head.length
    const exact = chunkNote(note({ body: noise(room) }))
    expect(exact).toHaveLength(1)
    expect(exact[0].length).toBe(1800)
    const over = chunkNote(note({ body: noise(room) + '\n\n' + 'z' }))
    expect(over).toHaveLength(2)
    expect(over.every((c) => c.length <= 1800)).toBe(true)
    const oneLine = chunkNote(note({ body: noise(room + 1) })) // one unbroken line, a character too long
    expect(oneLine.length).toBeGreaterThan(1)
    expect(oneLine.every((c) => c.length <= 1800)).toBe(true)
  })

  it('clips a name at 100 characters and a description at 280, each ending in an ellipsis, and no sooner', () => {
    const prefixOf = (name: string, description: string): string => chunkNote(note({ name, description, body: 'b' }))[0].split('\n\n')[0]
    expect(prefixOf('n'.repeat(100), 'd')).toBe(`${'n'.repeat(100)} — d`) // 100 stays whole
    expect(prefixOf('n'.repeat(101), 'd')).toBe(`${'n'.repeat(99)}… — d`) // 101 is cut to 100 with the ellipsis
    expect(prefixOf('n', 'd'.repeat(280))).toBe(`n — ${'d'.repeat(280)}`)
    expect(prefixOf('n', 'd'.repeat(281))).toBe(`n — ${'d'.repeat(279)}…`)
  })

  it('splits a long note at paragraph boundaries, every chunk within the limit and prefixed', () => {
    const paras = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ` + 'word '.repeat(60).trim())
    const chunks = chunkNote(note({ body: paras.join('\n\n') }))
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS)
      expect(c.startsWith('cache rules — when to invalidate\n\n')).toBe(true)
    }
    // Nothing is lost and nothing is cut mid-paragraph: every paragraph appears whole in exactly one chunk.
    for (const p of paras) expect(chunks.filter((c) => c.includes(p))).toHaveLength(1)
  })

  it('keeps a heading with the paragraph that follows it, even stacked headings', () => {
    // The two headings would fit after the filler; the paragraph under them would not. Without the glue the
    // first chunk would end on a bare heading.
    const filler = 'x'.repeat(1740)
    const chunks = chunkNote(note({ body: `${filler}\n\n# Title\n\n## Sub\n\nAfter the headings.` }))
    expect(chunks).toHaveLength(2)
    expect(chunks[1]).toContain('# Title\n\n## Sub\n\nAfter the headings.')
    expect(chunks[0]).not.toContain('# Title')
  })

  it('a heading with no paragraph after it stays where it is', () => {
    const chunks = chunkNote(note({ body: 'Intro.\n\n## Last heading' }))
    expect(chunks).toHaveLength(1)
    expect(chunks[0].endsWith('## Last heading')).toBe(true)
  })

  it('splits one oversized paragraph at its line breaks', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i} ` + 'y'.repeat(60))
    const chunks = chunkNote(note({ body: lines.join('\n') }))
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS)
    for (const l of lines) expect(chunks.some((c) => c.includes(l))).toBe(true)
  })

  it('cuts one oversized line at a space when it has one, else hard, and never splits an emoji', () => {
    const spaced = chunkNote(note({ body: 'alpha '.repeat(500).trim() }))
    expect(spaced.length).toBeGreaterThan(1)
    for (const c of spaced) {
      expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS)
      // No word cut in half: everything after the prefix is whole 'alpha' words.
      expect(c.split('\n\n').slice(1).join(' ').split(/\s+/).every((w) => w === 'alpha')).toBe(true)
    }
    const text = noise(5000)
    const solid = chunkNote(note({ body: text }))
    expect(solid.length).toBeGreaterThan(2)
    for (const c of solid) expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS)
    expect(solid.map((c) => c.split('\n\n')[1]).join('')).toBe(text) // a hard cut loses nothing
    // A space too early in the line to be worth cutting at (here, one after 10 characters) is not used.
    const early = chunkNote(note({ body: `${'a'.repeat(10)} ${noise(4000)}` }))
    expect(early.length).toBeGreaterThan(2)
    for (const c of early) expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS)
  })

  it('never splits an emoji at a cut, however the room falls', () => {
    // The prefix is 33 characters, so the room is odd and a naive cut lands between the two halves of an emoji.
    const body = Array.from({ length: 1500 }, (_, i) => String.fromCodePoint(0x1f600 + ((i * 7 + (i >> 3)) % 80))).join('')
    const emoji = chunkNote(note({ description: 'when to invalidate!', body }))
    expect(emoji.length).toBeGreaterThan(1)
    for (const c of emoji) {
      expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS)
      const last = c.charCodeAt(c.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    }
    // Every emoji survives whole and in order: putting the pieces back together gives the body.
    expect(emoji.map((c) => c.split('\n\n')[1]).join('')).toBe(body)
  })

  it('a long name and description are clipped so the body keeps most of the room', () => {
    const chunks = chunkNote(note({ name: 'n'.repeat(500), description: 'd'.repeat(900), body: 'b'.repeat(4000) }))
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS)
    expect(chunks[0].split('\n\n')[0].length).toBeLessThanOrEqual(400)
  })

  it('clipping a name never leaves half an emoji before the ellipsis', () => {
    // 100 characters of name room: the cut at 99 falls between the halves of the 50th emoji.
    const head = chunkNote(note({ name: '\u{1F600}'.repeat(200), description: '', body: 'x' }))[0].split('\n\n')[0]
    expect(head.endsWith('…')).toBe(true)
    const beforeEllipsis = head.charCodeAt(head.length - 2)
    expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false)
  })

  it('a note with no name and no description is its body alone, with no prefix', () => {
    expect(chunkNote(note({ name: '', description: '', body: 'Only the body.' }))).toEqual(['Only the body.'])
  })

  it('a run of spaces longer than a chunk is dropped, not stored', () => {
    // Line one is a word and then 2,000 spaces; line two is 2,000 spaces and then a word.
    const block = `x${' '.repeat(2000)}\n${' '.repeat(2000)}tail`
    const chunks = chunkNote(note({ body: block }))
    expect(chunks.every((c) => c.length <= MAX_CHUNK_CHARS)).toBe(true)
    const body = chunks.map((c) => c.split('\n\n')[1]).join('\n')
    expect(body).toContain('x')
    expect(body).toContain('tail')
    expect(body.trim().length).toBeLessThan(40)
  })

  it('keeps a text two chunks would share once', () => {
    // The same paragraph twice, far enough apart to land in two chunks.
    const para = 'same words '.repeat(100).trim()
    const filler = 'f'.repeat(1700)
    expect(chunkNote(note({ body: `${para}\n\n${filler}\n\n${para}` }))).toHaveLength(2)
  })

  it('is deterministic', () => {
    const n = note({ body: 'a\n\nb\n\n' + 'c '.repeat(1200) })
    expect(chunkNote(n)).toEqual(chunkNote(n))
  })
})

describe('noteFields, noteTags, isPortableType', () => {
  it('maps a type to the kind and importance the memory store gets, never `message`', () => {
    expect(noteFields('reference')).toEqual({ kind: 'fact', importance: 0.9 })
    expect(noteFields('user')).toEqual({ kind: 'fact', importance: 0.9 })
    expect(noteFields('feedback')).toEqual({ kind: 'decision', importance: 0.9 })
    expect(noteFields('project')).toEqual({ kind: 'note', importance: 0.8 })
    expect(noteFields('untyped')).toEqual({ kind: 'note', importance: 0.8 })
  })

  it('tags carry the type and the file, which is how a search tells a note from a chunk', () => {
    expect(noteTags('feedback', 'feedback_cache.md')).toEqual(['type:feedback', 'note:feedback_cache.md'])
    expect(noteTags('untyped', 'n'.repeat(300) + '.md')[1].length).toBeLessThanOrEqual(105)
  })

  it('only reference, feedback and user notes may travel to another project', () => {
    expect(isPortableType('reference')).toBe(true)
    expect(isPortableType('feedback')).toBe(true)
    expect(isPortableType('user')).toBe(true)
    expect(isPortableType('project')).toBe(false)
    expect(isPortableType('untyped')).toBe(false)
    expect(isPortableType(null)).toBe(false)
  })

  it('reads the note type back from a stored row\'s tags', () => {
    expect(noteTypeOfTags(['note:a.md', 'type:feedback'])).toBe('feedback')
    expect(noteTypeOfTags(['type:untyped'])).toBe('untyped')
    expect(noteTypeOfTags(['type:gossip', 'type:user'])).toBe('user') // an unknown type is passed over
    expect(noteTypeOfTags(['type:gossip'])).toBeNull()
    expect(noteTypeOfTags(['note:a.md', 42, 'other'])).toBeNull()
    expect(noteTypeOfTags(undefined)).toBeNull()
    expect(noteTypeOfTags('type:user')).toBeNull()
  })

  it('reads the file a chunk came from back from its tags: all the chunks of one note name the same one', () => {
    expect(noteFileOfTags(['type:user', 'note:style.md'])).toBe('style.md')
    expect(noteFileOfTags(noteTags('feedback', 'feedback_cache.md'))).toBe('feedback_cache.md') // the importer's own tags
    expect(noteFileOfTags([7, null, 'note:a.md', 'note:b.md'])).toBe('a.md') // the first, and anything that is not text passed over
    expect(noteFileOfTags(['type:user'])).toBeNull()
    expect(noteFileOfTags(['note:'])).toBeNull() // a tag with no file in it names none
    expect(noteFileOfTags(['xnote:plan.md'])).toBeNull() // the tag has to BEGIN with note:, not merely hold it
    expect(noteFileOfTags(['type:note:plan.md'])).toBeNull()
    expect(noteFileOfTags(['xnote:a.md', 'note:b.md'])).toBe('b.md') // and a tag that only looks like one is passed over
    expect(noteFileOfTags([])).toBeNull()
    expect(noteFileOfTags(undefined)).toBeNull()
    expect(noteFileOfTags('note:x.md')).toBeNull() // text is not a list of tags
  })

  // A stored row's tags are whatever the store was given, and the primer reads them for every hit: something that is not a list
  // must answer "none", not throw (a number or an object is not even iterable, and text only looked harmless because its characters are).
  it('reads a tag list and nothing else: whatever is not a list names no file, and never throws', () => {
    for (const odd of [5, {}, true, 'note:plan.md', () => 1, { 0: 'note:plan.md', length: 1 }]) expect(noteFileOfTags(odd)).toBeNull()
    expect(noteFileOfTags(['type:reference', 'note:plan.md'])).toBe('plan.md')
  })
})

describe('what is an imported note', () => {
  it('a row is a note by its source, and by its author when it names one', () => {
    expect(isClaudeNote({ source: 'claude-notes', agentId: 'claude-notes' })).toBe(true)
    expect(isClaudeNote({ source: 'claude-notes' })).toBe(true)
    expect(isClaudeNote({ source: 'claude-notes', agentId: 'claude' })).toBe(false) // an agent cannot pass itself off as one
    expect(isClaudeNote({ source: 'claude', agentId: 'claude-notes' })).toBe(false)
    expect(isClaudeNote({})).toBe(false)
    expect(isClaudeNote(null)).toBe(false)
    expect(isClaudeNote('claude-notes')).toBe(false)
  })

  it('a row carries note tags when one of its tags names a file', () => {
    expect(hasNoteTags({ tags: ['type:user', 'note:a.md'] })).toBe(true)
    expect(hasNoteTags({ tags: ['type:user'] })).toBe(false)
    expect(hasNoteTags({ tags: [7] })).toBe(false)
    expect(hasNoteTags({ tags: 'note:a.md' })).toBe(false)
    expect(hasNoteTags({})).toBe(false)
    expect(hasNoteTags(null)).toBe(false)
  })

  it('withoutNotes drops tagged rows and hands back the same array when there are none', () => {
    const a = { id: 'a', tags: ['x'] }
    const b = { id: 'b', tags: ['note:b.md'] }
    const none = [a, { id: 'c' }]
    expect(withoutNotes(none)).toBe(none)
    expect(withoutNotes([a, b])).toEqual([a])
    expect(withoutNotes('nope' as never)).toBe('nope')
  })
})

describe('which project a folder belongs to', () => {
  it('encodes a path the way Claude Code names its folder: everything but letters and digits is a dash', () => {
    expect(encodeProjectFolder('C:\\Users\\Dev\\repos\\app')).toBe('C--Users-Dev-repos-app')
    expect(encodeProjectFolder('/home/dev/my.app')).toBe('-home-dev-my-app')
    expect(encodeProjectFolder('C:\\r\\.worktrees\\x')).toBe('C--r--worktrees-x')
  })

  it('finds the working directory the folder was named for', () => {
    expect(projectCwdFor('C--Users-Dev-repos-app', ['C:\\Users\\Dev\\repos\\app'])).toBe('C:\\Users\\Dev\\repos\\app')
    expect(projectCwdFor('-home-dev-app', ['/home/dev/app/'])).toBe('/home/dev/app') // a trailing slash is dropped
  })

  it('finds it through a parent when the session moved into a subfolder or a worktree', () => {
    expect(projectCwdFor('C--r-app', ['C:\\r\\app\\.worktrees\\feat\\src'])).toBe('C:\\r\\app')
    expect(projectCwdFor('-home-dev-app', ['/home/dev/app/packages/ui'])).toBe('/home/dev/app')
  })

  it('takes the first working directory that fits, and ignores case', () => {
    expect(projectCwdFor('c--r-app', ['D:\\other', 'C:\\R\\App'])).toBe('C:\\R\\App')
  })

  it('is null when no working directory encodes to the folder, or there is none', () => {
    expect(projectCwdFor('C--r-app', ['C:\\r\\other', '/'])).toBeNull()
    expect(projectCwdFor('C--r-app', [])).toBeNull()
    expect(projectCwdFor('-x', ['/x'])).toBe('/x') // one segment under the root
    expect(projectCwdFor('-y', ['/x'])).toBeNull() // and the root itself is never a project
  })

  // A path and its parents are asked about as a whole: a parent ends where a separator begins, and what it is named for has the
  // length of the path. These are the shapes that tell a parent from a prefix that is not one.
  it('takes a parent only at a separator, never part-way through a name', () => {
    expect(projectCwdFor('C--r-ap', ['C:\\r\\app'])).toBeNull() // C:\r\ap is not a parent of C:\r\app
    expect(projectCwdFor('C--r', ['C:\\r\\app'])).toBe('C:\\r') // C:\r is
    expect(projectCwdFor('C-', ['C:\\r\\app'])).toBe('C:') // and so is C:
    expect(projectCwdFor('C--r-app-x', ['C:\\r\\app'])).toBeNull() // a folder named for a longer path than this one
    expect(projectCwdFor('-home-dev', ['/home/dev/app/ui'])).toBe('/home/dev')
    expect(projectCwdFor('-home', ['/home/dev/app'])).toBe('/home')
    expect(projectCwdFor('-', ['/home'])).toBeNull() // the root is not a project
    expect(projectCwdFor('', ['/home', 'C:\\r'])).toBeNull() // and a folder with no name belongs to no path
  })

  it('counts doubled and mixed separators, and drops only the ones at the end', () => {
    expect(projectCwdFor('a-', ['a//b'])).toBe('a/') // the parent of a//b that ends at its last separator keeps the first
    expect(projectCwdFor('a', ['a//b'])).toBe('a')
    expect(projectCwdFor('a-b', ['a//b'])).toBeNull()
    expect(projectCwdFor('a--b', ['a//b'])).toBe('a//b')
    expect(projectCwdFor('C--r-app', ['C:\\r\\app\\\\//'])).toBe('C:\\r\\app') // a run of trailing separators of either kind
    expect(projectCwdFor('C--r', ['C:/r\\app'])).toBe('C:/r')
    expect(projectCwdFor('x', ['/x/', '/x'])).toBeNull() // the separator at the front is a dash in the folder's name too
  })

  it('ignores the space around a path, and a path with only separators in it', () => {
    expect(projectCwdFor('-home-dev-app', ['  /home/dev/app  '])).toBe('/home/dev/app')
    // Space is trimmed before the separators at the end are, so one that sits before them is part of the path.
    expect(projectCwdFor('-home-dev-app-', ['/home/dev/app /'])).toBe('/home/dev/app ')
    expect(projectCwdFor('-home-dev-app', ['/home/dev/app /'])).toBeNull()
    expect(projectCwdFor('-', ['///', '\\', ' / '])).toBeNull()
    expect(projectCwdFor('-x', ['', '   ', '/x'])).toBe('/x')
  })

  it('measures a path in the characters it is named in, an emoji being two', () => {
    const cwd = '/work/\u{1F600}/app'
    expect(projectCwdFor(encodeProjectFolder(cwd), [cwd])).toBe(cwd)
    expect(projectCwdFor(encodeProjectFolder('/work/\u{1F600}'), [cwd])).toBe('/work/\u{1F600}')
    expect(projectCwdFor('-work--', [cwd])).toBeNull() // half an emoji is not a parent
  })

  // Same reason as the heading: this runs on text read from a transcript, whose working directory may be any length (the head of
  // one is 256 KB). Asking about every parent in turn, each encoded afresh, took the square of the length; a run of separators at
  // the end, stripped by a pattern, the same.
  it('answers for a path of tens of thousands of characters without taking seconds', () => {
    const started = performance.now()
    expect(projectCwdFor('zzz', ['/a'.repeat(16_384)])).toBeNull()
    expect(projectCwdFor('zzz', [`${'/'.repeat(20_000)}a`])).toBeNull()
    expect(projectCwdFor('-a', [`/a${'/b'.repeat(16_384)}`])).toBe('/a')
    expect(projectCwdFor('zzz', cwdsFromTranscript(`{"cwd":"${'/'.repeat(200_000)}"}`))).toBeNull()
    // Generous for a loaded CI box; each of the first three took seconds before.
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('reads the distinct working directories out of the start of a transcript', () => {
    const text = [
      '{"type":"summary"}',
      '{"cwd":"C:\\\\r\\\\app","type":"user"}',
      'not json but "cwd" is in it',
      '{"cwd":"C:\\\\r\\\\app"}',
      '{"cwd":"C:\\\\r\\\\app\\\\src"}',
      '{"cwd":42}',
      'null "cwd"',
      '{"cwd":"","x":1}',
      '{"cwd":"C:\\\\r\\\\cut off',
    ].join('\n')
    expect(cwdsFromTranscript(text)).toEqual(['C:\\r\\app', 'C:\\r\\app\\src'])
    expect(cwdsFromTranscript('')).toEqual([])
  })

  // A transcript is read to 256 KB, which holds thousands of distinct directories; each new one was once compared with every one before it
  // (an array's includes), which is quadratic. The text here is five times that, so the old form takes seconds (about five on a quiet
  // machine) where this one takes tens of milliseconds, and the bound is generous for a loaded CI box.
  it('dedupes the working directories of a long transcript without comparing each with every one before it', () => {
    const distinct = 50_000
    const lines: string[] = []
    for (let i = 0; i < distinct; i++) lines.push(`{"cwd":"C:\\\\w\\\\${i}"}`)
    for (let i = 0; i < 100; i++) lines.push('{"cwd":"C:\\\\w\\\\7"}', '{"cwd":"C:\\\\w\\\\49999"}') // and the same ones again
    const started = performance.now()
    const cwds = cwdsFromTranscript(lines.join('\n'))
    const took = performance.now() - started
    expect(cwds).toHaveLength(distinct)
    expect(cwds[0]).toBe('C:\\w\\0')
    expect(cwds[distinct - 1]).toBe('C:\\w\\49999') // in the order they first appeared
    expect(took).toBeLessThan(1_500)
  })
})
