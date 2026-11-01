// Claude Code's saved notes, as memory. Claude keeps what it learns about a project in small
// markdown files under ~/.claude/projects/<folder>/memory/ -- hand-curated, one fact to a file, and
// private to Claude in that one project. This module is the PURE half of bringing them into Termpolis's
// memory: text in, chunks and store fields out, so it tests without a filesystem or a store.
// claudeNotesIngest.ts does the reading, the manifest and the writing.
//
// Two shapes of frontmatter occur in the wild, and both are read:
//     ---                               ---
//     name: x                           name: x
//     description: y                    description: y
//     type: feedback                    metadata:
//     ---                                 type: feedback
//                                       ---

import { normalizeNewlines } from './lineEndings'

/** The agent id AND the source every imported note is stored under. It is how the primer, the
 *  search and the Settings panel tell a curated note from a transcript chunk. */
export const NOTES_SOURCE = 'claude-notes'

/** The embedder window is about 512 tokens; this keeps a chunk inside it with room for its prefix. */
export const MAX_CHUNK_CHARS = 1800

const NAME_CLIP = 100
const DESCRIPTION_CLIP = 280
const FILE_TAG_CLIP = 100

export type NoteType = 'reference' | 'feedback' | 'user' | 'project' | 'untyped'

export interface ParsedNote {
  name: string
  description: string
  type: NoteType
  body: string
}

const TYPES: readonly NoteType[] = ['reference', 'feedback', 'user', 'project']

function noteType(raw: string | undefined): NoteType {
  const t = (raw || '').trim().toLowerCase()
  return (TYPES as readonly string[]).includes(t) ? (t as NoteType) : 'untyped'
}

/** A value as YAML spells it: `"a \"b\""` and `'it''s'` lose their quotes; anything else is kept as written. */
function unquote(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(["\\])/g, '$1')
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  return v
}

/** The frontmatter lines and the text after them, or no frontmatter (a note may have none, and one
 *  that never closes is treated as plain text rather than half-trusted). */
function splitFrontmatter(text: string): { front: string[] | null; body: string } {
  const lines = text.split('\n')
  if (lines[0].trimEnd() !== '---') return { front: null, body: text }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === '---') return { front: lines.slice(1, i), body: lines.slice(i + 1).join('\n') }
  }
  return { front: null, body: text }
}

const indentOf = (line: string): number => line.length - line.trimStart().length

/** `key: value` pairs at the top of the frontmatter, and under a `metadata:` key. Block scalars (`>`, `|`)
 *  are joined onto one line. Anything this does not understand is skipped: a note is never refused for it. */
function parseFront(lines: string[]): { top: Record<string, string>; meta: Record<string, string> } {
  const top: Record<string, string> = {}
  const meta: Record<string, string> = {}
  let block: 'top' | 'meta' | 'skip' = 'top'
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = indentOf(line)
    if (indent === 0) block = 'top' // a top-level line closes whatever nested block was open
    const m = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    let value = m[2].trim()
    if (indent === 0 && value === '') { block = key === 'metadata' ? 'meta' : 'skip'; continue }
    if (/^[>|][+-]?\d*$/.test(value)) {
      const parts: string[] = []
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || indentOf(lines[i + 1]) > indent)) {
        i++
        if (lines[i].trim()) parts.push(lines[i].trim())
      }
      value = parts.join(' ')
    }
    if (indent === 0) top[key] = unquote(value)
    else if (block === 'meta') meta[key] = unquote(value)
  }
  return { top, meta }
}

function firstHeading(body: string): string {
  const m = /^#{1,6}[ \t]+(.+)$/m.exec(body)
  return m ? m[1].replace(/[ \t]+#+[ \t]*$/, '').trim() : ''
}

/**
 * One note file, read. Null when it has nothing to say: no description and no body, which is what a
 * template left unfilled or an emptied file looks like. A note with no frontmatter is read as it is,
 * named for its first heading, else its file.
 */
export function parseNote(raw: string, fileName: string): ParsedNote | null {
  const text = normalizeNewlines(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
  const { front, body: rest } = splitFrontmatter(text)
  const fm = parseFront(front ?? [])
  const body = rest.trim()
  const description = (fm.top.description || fm.meta.description || '').trim()
  if (!description && !body) return null
  const name = (fm.top.name || fm.meta.name || '').trim() || firstHeading(body) || fileName.replace(/\.md$/i, '')
  return { name, description, type: noteType(fm.top.type || fm.meta.type), body }
}

/** Never leave half an emoji at a cut: back off one when the cut would strand a high surrogate. */
function safeCut(s: string, cut: number): number {
  const c = s.charCodeAt(cut - 1)
  return c >= 0xd800 && c <= 0xdbff ? cut - 1 : cut
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, safeCut(s, max - 1))}\u2026`
}

/** What every chunk of the note opens with, so a chunk read alone still says which note it is from. */
function headOf(note: ParsedNote): string {
  const name = clip(note.name.trim(), NAME_CLIP)
  const description = clip(note.description.trim(), DESCRIPTION_CLIP)
  return name && description ? `${name} \u2014 ${description}` : name || description
}

/** Cut one line to pieces of at most `room`, at a space when one is near the end, else wherever it falls. */
function splitLine(line: string, room: number): string[] {
  const out: string[] = []
  let rest = line
  while (rest.length > room) {
    let cut = rest.lastIndexOf(' ', room)
    if (cut < room / 2) cut = safeCut(rest, room)
    const piece = rest.slice(0, cut).trimEnd()
    if (piece) out.push(piece)
    rest = rest.slice(cut).trimStart()
  }
  if (rest) out.push(rest)
  return out
}

/** Cut one oversized paragraph at its line breaks. */
function splitLong(block: string, room: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const line of block.split('\n')) {
    for (const piece of line.length > room ? splitLine(line, room) : [line]) {
      if (!cur) cur = piece
      else if (cur.length + 1 + piece.length <= room) cur += `\n${piece}`
      else { out.push(cur); cur = piece }
    }
  }
  out.push(cur) // a block is trimmed, so its last line is not empty and `cur` never is
  return out
}

/** The body as paragraphs, each heading kept with the paragraph under it (stacked headings go together). */
function bodyBlocks(body: string): string[] {
  const out: string[] = []
  let pending: string[] = []
  for (const block of body.split(/\n(?:[ \t]*\n)+/).map((b) => b.trim()).filter(Boolean)) {
    if (/^#{1,6}[ \t]/.test(block) && !block.includes('\n')) { pending.push(block); continue }
    out.push([...pending, block].join('\n\n'))
    pending = []
  }
  if (pending.length > 0) out.push(pending.join('\n\n'))
  return out
}

/**
 * The note as the texts to store: paragraphs packed into chunks of at most MAX_CHUNK_CHARS, never cut
 * mid-paragraph unless one paragraph is bigger than a chunk, each chunk opening with the note's name and
 * description. A note that is only a description is one chunk made of that. Deterministic, and a text
 * that two chunks would share is kept once.
 */
export function chunkNote(note: ParsedNote): string[] {
  const head = headOf(note)
  const room = MAX_CHUNK_CHARS - (head ? head.length + 2 : 0)
  const bodies: string[] = []
  let cur = ''
  for (const piece of bodyBlocks(note.body).flatMap((b) => (b.length > room ? splitLong(b, room) : [b]))) {
    if (!cur) cur = piece
    else if (cur.length + 2 + piece.length <= room) cur += `\n\n${piece}`
    else { bodies.push(cur); cur = piece }
  }
  if (cur) bodies.push(cur)
  if (bodies.length === 0) return head ? [head] : []
  return Array.from(new Set(bodies.map((b) => (head ? `${head}\n\n${b}` : b))))
}

/**
 * What the memory store is told about a note of this type. `kind` is never `message`, so the idle decay
 * pass (which forgets cold message chunks) leaves notes alone; `importance` sits above the 0.6 bar
 * memory_anticipate keeps results at.
 */
export function noteFields(type: NoteType): { kind: 'fact' | 'decision' | 'note'; importance: number } {
  if (type === 'reference' || type === 'user') return { kind: 'fact', importance: 0.9 }
  if (type === 'feedback') return { kind: 'decision', importance: 0.9 }
  return { kind: 'note', importance: 0.8 }
}

/** The two tags a note's chunks carry: its type, and the file it came from. */
export function noteTags(type: NoteType, fileName: string): string[] {
  return [`type:${type}`, `note:${clip(fileName, FILE_TAG_CLIP)}`]
}

/** The note type a stored row's tags name, or null. */
export function noteTypeOfTags(tags: unknown): NoteType | null {
  if (!Array.isArray(tags)) return null
  for (const t of tags) {
    if (typeof t === 'string' && t.startsWith('type:')) {
      const v = t.slice(5)
      if (v === 'untyped' || (TYPES as readonly string[]).includes(v)) return v as NoteType
    }
  }
  return null
}

/** Only these may be lent to another project (when the user allows it). A `project` note describes one
 *  project's own state and never travels. */
export function isPortableType(type: NoteType | null): boolean {
  return type === 'reference' || type === 'feedback' || type === 'user'
}

/** A stored row that is one of the notes this module imported. */
export function isClaudeNote(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false
  const { source, agentId } = row as { source?: unknown; agentId?: unknown }
  return source === NOTES_SOURCE && (agentId === undefined || agentId === NOTES_SOURCE)
}

/** A row carrying the tags imported notes carry. The idle consolidation passes only see a row's tags, so
 *  this is how they know to leave a note alone: never merged into another memory, archived, or copied
 *  into a summary. */
export function hasNoteTags(row: unknown): boolean {
  const tags = row && typeof row === 'object' ? (row as { tags?: unknown }).tags : undefined
  return Array.isArray(tags) && tags.some((t) => typeof t === 'string' && t.startsWith('note:'))
}

/** `rows` without the notes (see hasNoteTags). The same array comes back when none is there. */
export function withoutNotes<T>(rows: T[]): T[] {
  if (!Array.isArray(rows)) return rows
  return rows.some(hasNoteTags) ? rows.filter((r) => !hasNoteTags(r)) : rows
}

// ---- Which project a folder's notes belong to ----

/** How Claude Code names a project's folder: every character that is not a letter or digit becomes `-`. */
export function encodeProjectFolder(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * The project path a Claude Code folder stands for, found among the working directories its sessions
 * recorded: the one whose name encodes to the folder's, or a parent of one (a session that moved into a
 * subfolder or a worktree still belongs to the folder it started in). Null when none does -- the
 * folder's notes are then left alone rather than filed under a project they might not belong to.
 */
export function projectCwdFor(folder: string, cwds: readonly string[]): string | null {
  const want = folder.toLowerCase()
  for (const cwd of cwds) {
    let p = cwd.trim().replace(/[\\/]+$/, '')
    while (p) {
      if (encodeProjectFolder(p).toLowerCase() === want) return p
      const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
      if (cut <= 0) break
      p = p.slice(0, cut)
    }
  }
  return null
}

/** The distinct `cwd` values in the start of a session transcript, in the order they appear. The last line
 *  of a partial read may be cut off; it just does not parse. */
export function cwdsFromTranscript(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"cwd"')) continue
    let o: unknown
    try { o = JSON.parse(line) } catch { continue }
    const cwd = (o as { cwd?: unknown } | null)?.cwd
    if (typeof cwd === 'string' && cwd && !out.includes(cwd)) out.push(cwd)
  }
  return out
}
