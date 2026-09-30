// Line-level edits to Codex's config.toml. Codex rewrites this file itself (folder-trust
// answers, MCP tool approvals) and people edit it by hand, so Termpolis never re-serializes
// it: a scanner finds the tables and keys, an edit adds, replaces or removes only the lines
// Termpolis owns, and every other byte stays as it was — comments, key order, quoting, blank
// lines, line endings, a BOM. A file the scanner can't read with certainty is refused, never
// guessed at, and so is any shape of `mcp_servers.termpolis` other than plain table headers.
//
// The scanner is not a TOML validator. It tracks exactly what decides where a table or a key
// statement starts and ends: comments, the four string forms (a multi-line one can hold a line
// that looks like a header) and bracket depth (an array can span lines).

interface Line {
  text: string
  /** '\n', '\r\n', or '' for a last line without a newline. */
  eol: string
}

interface KeyStmt {
  /** Dotted key, decoded: `"a b".c` is ['a b', 'c']. */
  key: string[]
  /** First and last line of the statement; a multi-line array or string spans several. */
  line: number
  last: number
  /** Where the value starts in `lines[line].text`. */
  valueAt: number
}

interface Table {
  /** [] for the root table: the lines before the first header. */
  path: string[]
  /** An `[[array of tables]]` entry. */
  array: boolean
  /** The header line, or -1 for the root table. */
  header: number
  /** One past the table's last line: the next header, or the end of the file. */
  end: number
  keys: KeyStmt[]
}

interface Doc {
  bom: boolean
  /** The file's line ending, for lines Termpolis adds. */
  eol: string
  lines: Line[]
  tables: Table[]
}

interface ScanState {
  /** Inside a multi-line string that began on an earlier line. */
  ml: '"""' | "'''" | null
  /** Open `[` / `{` brackets carried over from earlier lines. */
  depth: number
}

export type TomlEdit = { text: string; changed: boolean } | { error: string }

export interface CodexServerSpec {
  command: string
  args: string[]
  /** Environment the command needs: the Electron-as-node fallback's ELECTRON_RUN_AS_NODE. */
  env?: Record<string, string>
}

export type CodexServerState =
  | { state: 'error'; error: string }
  | { state: 'absent' }
  /** `command` / `args` are undefined when they are missing or not a plain one-line value. */
  | { state: 'present'; command?: string; args?: string[] }

const SERVER = ['mcp_servers', 'termpolis']

/** What older Termpolis versions wrote as `env` when no system node was found. */
const ELECTRON_NODE_ENV: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' }

const ESCAPES = new Map<string, string>([
  ['b', '\b'], ['t', '\t'], ['n', '\n'], ['f', '\f'], ['r', '\r'], ['e', '\x1b'], ['"', '"'], ['\\', '\\'],
])

const HEX_DIGITS: Record<string, number> = { u: 4, U: 8, x: 2 }

function skipWs(text: string, i: number): number {
  while (text[i] === ' ' || text[i] === '\t') i++
  return i
}

/** Only whitespace or a comment from `i` to the end of the line. */
function restIsEmpty(text: string, i: number): boolean {
  const j = skipWs(text, i)
  return j >= text.length || text[j] === '#'
}

function isBareKeyChar(c: string): boolean {
  // TOML 1.0 bare keys, plus the non-ASCII letters TOML 1.1 allows.
  return /[A-Za-z0-9_-]/.test(c) || c.charCodeAt(0) >= 0x80
}

/** A basic string ("…") starting at `i`, decoded. Null for a malformed one. */
function parseBasicString(text: string, i: number): { value: string; next: number } | null {
  let out = ''
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j]
    if (c === '"') return { value: out, next: j + 1 }
    if (c !== '\\') {
      out += c
      continue
    }
    const e = text[++j]
    const simple = ESCAPES.get(e)
    if (simple !== undefined) {
      out += simple
      continue
    }
    const len = HEX_DIGITS[e]
    const hex = text.slice(j + 1, j + 1 + (len ?? 0))
    if (!len || hex.length !== len || !/^[0-9A-Fa-f]+$/.test(hex)) return null
    const cp = parseInt(hex, 16)
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null
    out += String.fromCodePoint(cp)
    j += len
  }
  return null
}

/** A one-line basic or literal string starting at `i`, decoded. */
function parseStringAt(text: string, i: number): { value: string; next: number } | null {
  if (text.startsWith('"""', i) || text.startsWith("'''", i)) return null
  if (text[i] === '"') return parseBasicString(text, i)
  if (text[i] !== "'") return null
  const j = text.indexOf("'", i + 1)
  return j < 0 ? null : { value: text.slice(i + 1, j), next: j + 1 }
}

function parseKeyPart(text: string, i: number): { value: string; next: number } | null {
  if (text[i] === '"' || text[i] === "'") return parseStringAt(text, i)
  let j = i
  while (j < text.length && isBareKeyChar(text[j])) j++
  return j === i ? null : { value: text.slice(i, j), next: j }
}

/** A dotted key at `i`; `next` is the first character after it and its trailing space. */
function parseKey(text: string, i: number): { path: string[]; next: number } | null {
  const path: string[] = []
  i = skipWs(text, i)
  for (;;) {
    const part = parseKeyPart(text, i)
    if (!part) return null
    path.push(part.value)
    i = skipWs(text, part.next)
    if (text[i] !== '.') return { path, next: i }
    i = skipWs(text, i + 1)
  }
}

function parseHeader(text: string, i: number): { path: string[]; array: boolean } | null {
  const array = text.startsWith('[[', i)
  const key = parseKey(text, i + (array ? 2 : 1))
  const close = array ? ']]' : ']'
  if (!key || !text.startsWith(close, key.next)) return null
  return restIsEmpty(text, key.next + close.length) ? { path: key.path, array } : null
}

/** Scan value text from `i`, carrying multi-line strings and bracket depth in `st`.
 *  Returns an error message, or null. */
function scanValue(text: string, i: number, st: ScanState): string | null {
  while (i < text.length) {
    if (st.ml) {
      const q = st.ml[0]
      if (q === '"' && text[i] === '\\') {
        i += 2
        continue
      }
      if (!text.startsWith(st.ml, i)) {
        i++
        continue
      }
      // Up to two quotes right before the closing three belong to the string.
      let run = 0
      while (text[i + run] === q) run++
      if (run > 5) return 'too many quotes closing a multi-line string'
      i += run
      st.ml = null
      continue
    }
    const c = text[i]
    if (c === '#') return null
    if (c === '"' || c === "'") {
      if (text.startsWith(c.repeat(3), i)) {
        st.ml = c === '"' ? '"""' : "'''"
        i += 3
        continue
      }
      let j = i + 1
      while (j < text.length && text[j] !== c) j += c === '"' && text[j] === '\\' ? 2 : 1
      if (j >= text.length) return 'unterminated string'
      i = j + 1
      continue
    }
    if (c === '[' || c === '{') st.depth++
    else if ((c === ']' || c === '}') && --st.depth < 0) return 'unbalanced brackets'
    i++
  }
  return null
}

function parse(text: string): Doc | { error: string } {
  const bom = text.startsWith('﻿')
  const body = bom ? text.slice(1) : text
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  const lines: Line[] = body === '' ? [] : body.split(/(?<=\n)/).map((chunk) => {
    const m = /\r?\n$/.exec(chunk)
    return m ? { text: chunk.slice(0, m.index), eol: m[0] } : { text: chunk, eol: '' }
  })
  const root: Table = { path: [], array: false, header: -1, end: lines.length, keys: [] }
  const tables: Table[] = [root]
  let table = root
  let stmt: KeyStmt | null = null
  const st: ScanState = { ml: null, depth: 0 }
  for (let n = 0; n < lines.length; n++) {
    const t = lines[n].text
    const at = `line ${n + 1}: `
    if (stmt && (st.ml || st.depth > 0)) {
      stmt.last = n
      const err = scanValue(t, 0, st)
      if (err) return { error: at + err }
      continue
    }
    const i = skipWs(t, 0)
    if (restIsEmpty(t, i)) continue
    if (t[i] === '[') {
      const h = parseHeader(t, i)
      if (!h) return { error: at + 'unreadable table header' }
      table.end = n
      table = { path: h.path, array: h.array, header: n, end: lines.length, keys: [] }
      tables.push(table)
      continue
    }
    const key = parseKey(t, i)
    if (!key || t[key.next] !== '=') return { error: at + 'unreadable key' }
    const valueAt = skipWs(t, key.next + 1)
    if (restIsEmpty(t, valueAt)) return { error: at + 'key without a value' }
    stmt = { key: key.path, line: n, last: n, valueAt }
    table.keys.push(stmt)
    const err = scanValue(t, valueAt, st)
    if (err) return { error: at + err }
  }
  if (st.ml || st.depth > 0) return { error: 'unterminated multi-line string or array' }
  return { bom, eol, lines, tables }
}

function render(doc: Doc): string {
  return (doc.bom ? '﻿' : '') + doc.lines.map((l) => l.text + l.eol).join('')
}

function startsWith(path: string[], prefix: string[]): boolean {
  return path.length >= prefix.length && prefix.every((p, i) => path[i] === p)
}

function isServerTable(t: Table): boolean {
  return !t.array && t.path.length === 2 && startsWith(t.path, SERVER)
}

function findKey(t: Table, name: string): KeyStmt | undefined {
  return t.keys.find((k) => k.key.length === 1 && k.key[0] === name)
}

/** One past the last line of the table's last key statement: where keys can be added. */
function contentEnd(t: Table): number {
  return t.keys.length ? t.keys[t.keys.length - 1].last + 1 : t.header + 1
}

function statementText(doc: Doc, k: KeyStmt): string {
  return doc.lines.slice(k.line, k.last + 1).map((l) => l.text).join('\n')
}

/** The value when it is one single-line string. */
function stringValue(doc: Doc, k: KeyStmt): string | undefined {
  if (k.last !== k.line) return undefined
  const t = doc.lines[k.line].text
  const s = parseStringAt(t, k.valueAt)
  return s && restIsEmpty(t, s.next) ? s.value : undefined
}

/** The value when it is a single-line array of single-line strings. */
function stringArrayValue(doc: Doc, k: KeyStmt): string[] | undefined {
  const t = doc.lines[k.line].text
  if (k.last !== k.line || t[k.valueAt] !== '[') return undefined
  const out: string[] = []
  let i = skipWs(t, k.valueAt + 1)
  while (t[i] !== ']') {
    const s = parseStringAt(t, i)
    if (!s) return undefined
    out.push(s.value)
    i = skipWs(t, s.next)
    if (t[i] === ',') i = skipWs(t, i + 1)
    else if (t[i] !== ']') return undefined
  }
  return restIsEmpty(t, i + 1) ? out : undefined
}

/** The value when it is a single-line inline table of strings, as [key, value] pairs. */
function stringTableValue(doc: Doc, k: KeyStmt): Array<[string, string]> | undefined {
  const t = doc.lines[k.line].text
  if (k.last !== k.line || t[k.valueAt] !== '{') return undefined
  const out: Array<[string, string]> = []
  let i = skipWs(t, k.valueAt + 1)
  while (t[i] !== '}') {
    const key = parseKey(t, i)
    if (!key || key.path.length !== 1 || t[key.next] !== '=') return undefined
    const s = parseStringAt(t, skipWs(t, key.next + 1))
    if (!s) return undefined
    out.push([key.path[0], s.value])
    i = skipWs(t, s.next)
    if (t[i] === ',') i = skipWs(t, i + 1)
    else if (t[i] !== '}') return undefined
  }
  return restIsEmpty(t, i + 1) ? out : undefined
}

/** A TOML basic string. */
export function tomlString(v: string): string {
  let out = '"'
  for (const ch of v) {
    const code = ch.codePointAt(0)!
    if (ch === '\\' || ch === '"') out += '\\' + ch
    else if (code < 0x20 || code === 0x7f) out += '\\u' + code.toString(16).padStart(4, '0')
    else out += ch
  }
  return out + '"'
}

function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`
}

function tomlStringTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values).map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`).join(', ')} }`
}

function sameStrings(a: string[] | undefined, b: string[]): boolean {
  return !!a && a.length === b.length && a.every((v, i) => v === b[i])
}

function sameTable(pairs: Array<[string, string]> | undefined, want: Record<string, string>): boolean {
  const keys = Object.keys(want)
  return !!pairs && pairs.length === keys.length && pairs.every(([k, v]) => want[k] === v)
}

/** Insert lines at `at`, in the file's line ending. */
function insertLines(doc: Doc, at: number, texts: string[]): void {
  const before = doc.lines[at - 1]
  if (before && !before.eol) before.eol = doc.eol
  doc.lines.splice(at, 0, ...texts.map((text) => ({ text, eol: doc.eol })))
}

/** Append a block at the end of the file, one blank line after the last content. */
function appendBlock(doc: Doc, texts: string[]): void {
  const last = doc.lines[doc.lines.length - 1]
  insertLines(doc, doc.lines.length, last && last.text.trim() ? ['', ...texts] : texts)
}

function replaceStatement(doc: Doc, k: KeyStmt, text: string): void {
  const indent = /^[ \t]*/.exec(doc.lines[k.line].text)![0]
  doc.lines.splice(k.line, k.last - k.line + 1, { text: indent + text, eol: doc.lines[k.last].eol })
}

function removeStatement(doc: Doc, k: KeyStmt): void {
  doc.lines.splice(k.line, k.last - k.line + 1)
}

/**
 * Remove a table: its header, its key statements and the lines between them, then the blank
 * lines after it. Comments after its last key stay: they may belong to what follows. At the end
 * of the file, the blank lines before the header go too, so no trailing gap is left behind.
 */
function removeTable(doc: Doc, t: Table): void {
  const { lines } = doc
  const tailEol = lines[lines.length - 1].eol
  let from = t.header
  let to = contentEnd(t)
  while (to < lines.length && !lines[to].text.trim()) to++
  const atEnd = to === lines.length
  if (atEnd) while (from > 0 && !lines[from - 1].text.trim()) from--
  lines.splice(from, to - from)
  // The new last line ends the file the way the old one did, with or without a newline.
  if (atEnd && lines.length) lines[lines.length - 1].eol = tailEol
}

/** Parse, apply one edit at a time until `step` has nothing left to do, and render. */
function editLoop(text: string, step: (doc: Doc) => boolean, guard: (doc: Doc) => string | null): TomlEdit {
  let parsed = parse(text)
  let changed = false
  for (;;) {
    if ('error' in parsed) return parsed
    const bad = guard(parsed)
    if (bad) return { error: bad }
    if (!step(parsed)) return { text: changed ? render(parsed) : text, changed }
    changed = true
    parsed = parse(render(parsed))
  }
}

/**
 * Shapes of `mcp_servers.termpolis` this editor won't touch, because an edit to one is either
 * impossible without re-serializing or would produce a file Codex rejects: set with dotted keys
 * or inside an inline table instead of under a `[mcp_servers.termpolis]` header, written as an
 * array of tables, or given two headers. `forAdd` also refuses a top-level `mcp_servers` key of
 * any kind, since adding a `[mcp_servers.termpolis]` header next to one would clash with it.
 */
function unsupportedShape(doc: Doc, forAdd: boolean): string | null {
  if (doc.tables.filter(isServerTable).length > 1) return 'config.toml has two [mcp_servers.termpolis] tables'
  for (const t of doc.tables) {
    if (t.array && ((t.path.length === 1 && t.path[0] === 'mcp_servers') || startsWith(t.path, SERVER))) {
      return 'mcp_servers is written as an array of tables ([[…]])'
    }
    if (t.path.length >= 2) continue
    for (const k of t.keys) {
      const full = [...t.path, ...k.key]
      if (full[0] !== 'mcp_servers') continue
      if (full[1] === 'termpolis') return 'mcp_servers.termpolis is set with dotted keys or an inline table'
      if (full.length === 1 && (forAdd || statementText(doc, k).includes('termpolis'))) {
        return 'mcp_servers is set as an inline table'
      }
      if (forAdd && t.path.length === 0) return 'mcp_servers is set with dotted keys at the top level'
    }
  }
  return null
}

/** Is Termpolis's MCP server in this config, and what does it run? */
export function codexServerState(text: string): CodexServerState {
  const doc = parse(text)
  if ('error' in doc) return { state: 'error', error: doc.error }
  const bad = unsupportedShape(doc, false)
  if (bad) return { state: 'error', error: bad }
  const server = doc.tables.find(isServerTable)
  if (!server) return { state: 'absent' }
  const command = findKey(server, 'command')
  const args = findKey(server, 'args')
  return {
    state: 'present',
    command: command && stringValue(doc, command),
    args: args && stringArrayValue(doc, args),
  }
}

/**
 * Add `[mcp_servers.termpolis]`, or bring an existing one's `command` and `args` up to date,
 * leaving every other key in it (`enabled`, timeouts, the user's own env) alone. `env` is only
 * ever added when there is none, and the old Electron-fallback env is dropped once a real node
 * has been found.
 */
export function upsertCodexServer(text: string, spec: CodexServerSpec): TomlEdit {
  const command = `command = ${tomlString(spec.command)}`
  const args = `args = ${tomlStringArray(spec.args)}`
  const env = spec.env ? `env = ${tomlStringTable(spec.env)}` : null
  return editLoop(text, (doc) => {
    const server = doc.tables.find(isServerTable)
    if (!server) {
      appendBlock(doc, ['[mcp_servers.termpolis]', command, args, ...(env ? [env] : [])])
      return true
    }
    const cmdKey = findKey(server, 'command')
    if (!cmdKey) {
      insertLines(doc, server.header + 1, [command])
      return true
    }
    if (stringValue(doc, cmdKey) !== spec.command) {
      replaceStatement(doc, cmdKey, command)
      return true
    }
    const argsKey = findKey(server, 'args')
    if (!argsKey) {
      insertLines(doc, cmdKey.last + 1, [args])
      return true
    }
    if (!sameStrings(stringArrayValue(doc, argsKey), spec.args)) {
      replaceStatement(doc, argsKey, args)
      return true
    }
    const envKey = findKey(server, 'env')
    if (env) {
      const hasEnv = server.keys.some((k) => k.key[0] === 'env')
        || doc.tables.some((t) => startsWith(t.path, [...SERVER, 'env']))
      if (hasEnv) return false
      insertLines(doc, argsKey.last + 1, [env])
      return true
    }
    if (envKey && sameTable(stringTableValue(doc, envKey), ELECTRON_NODE_ENV)) {
      removeStatement(doc, envKey)
      return true
    }
    return false
  }, (doc) => unsupportedShape(doc, true))
}

/**
 * Remove `[mcp_servers.termpolis]` and every table under it (tool approvals, env). The
 * sub-tables can't stay behind on their own: they would leave Codex a server with no command,
 * which it refuses to load.
 */
export function stripCodexServer(text: string): TomlEdit {
  return editLoop(text, (doc) => {
    const t = doc.tables.find((x) => startsWith(x.path, SERVER))
    if (!t) return false
    removeTable(doc, t)
    return true
  }, (doc) => unsupportedShape(doc, false))
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Pre-approve Termpolis tools in Codex: a `[mcp_servers.termpolis.tools.<tool>]` table with
 * `approval_mode = "auto"` for each tool not mentioned anywhere under the server yet. A tool
 * already there keeps whatever the user (or Codex) set, even "approve".
 */
export function addCodexToolApprovals(text: string, tools: readonly string[]): { text: string; added: string[] } | { error: string } {
  const doc = parse(text)
  if ('error' in doc) return doc
  const bad = unsupportedShape(doc, true)
  if (bad) return { error: bad }
  const server = doc.tables.find(isServerTable)
  if (!server) return { error: 'no [mcp_servers.termpolis] table' }
  if (server.keys.some((k) => k.key[0] === 'tools')) {
    return { error: 'tool approvals are set with a tools key inside [mcp_servers.termpolis]' }
  }
  const regions = doc.tables.filter((t) => startsWith(t.path, SERVER))
  const mentioned = (tool: string): boolean => {
    const word = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(tool)}([^A-Za-z0-9_]|$)`)
    return regions.some((t) => doc.lines.slice(t.header, t.end).some((l) => word.test(l.text)))
  }
  const added = tools.filter((tool) => !mentioned(tool))
  if (!added.length) return { text, added }
  const at = contentEnd(regions[regions.length - 1])
  const block = added.flatMap((tool) => ['', `[mcp_servers.termpolis.tools.${tomlKey(tool)}]`, 'approval_mode = "auto"'])
  if (doc.lines[at]?.text.trim()) block.push('')
  insertLines(doc, at, block)
  return { text: render(doc), added }
}

/** Does the config set `key` itself, at the top level or in a `[profiles.<name>]` table? */
export function codexConfigSets(text: string, key: string): boolean | { error: string } {
  const doc = parse(text)
  if ('error' in doc) return doc
  return doc.tables.some((t) => t.keys.some((k) => {
    const full = [...t.path, ...k.key]
    if (full.length === 1) return full[0] === key
    // A profile set with dotted keys or an inline table counts when it mentions the key at all.
    return full[0] === 'profiles' && (full.length === 3 ? full[2] === key : statementText(doc, k).includes(key))
  }))
}

/** `trust_level = "trusted"` in a `[projects.<folder>]` table. */
function trustStatement(doc: Doc, t: Table): KeyStmt | undefined {
  if (t.array || t.path.length !== 2 || t.path[0] !== 'projects') return undefined
  const k = findKey(t, 'trust_level')
  return k && stringValue(doc, k) === 'trusted' ? k : undefined
}

/** Folders Codex's config marks trusted, as the config spells them. */
export function codexTrustedProjects(text: string): string[] | { error: string } {
  const doc = parse(text)
  if ('error' in doc) return doc
  return doc.tables.filter((t) => trustStatement(doc, t)).map((t) => t.path[1])
}

/**
 * Withdraw Codex's trust in the folders `shouldRemove` picks: the `trust_level` line goes, and
 * the whole `[projects.<folder>]` table when that was all it held.
 */
export function stripCodexProjectTrust(text: string, shouldRemove: (folder: string) => boolean): { text: string; removed: string[] } | { error: string } {
  const removed: string[] = []
  const r = editLoop(text, (doc) => {
    const t = doc.tables.find((x) => trustStatement(doc, x) && shouldRemove(x.path[1]))
    if (!t) return false
    if (t.keys.length === 1) removeTable(doc, t)
    else removeStatement(doc, trustStatement(doc, t)!)
    removed.push(t.path[1])
    return true
  }, () => null)
  return 'error' in r ? r : { text: r.text, removed }
}
