// The .gitignore at the top of a walked folder (world host, Node only): a folder outside git (a repository downloaded
// as a ZIP, say) still names its build output and caches there, so the walk leaves them out as git would.
//
// Supported, as git reads them: blank lines and # comments; a name or glob (* and ?) with no slash, matching at any
// depth; a trailing / for folders only; a leading or inner / anchoring the pattern to the folder; ** as a whole part
// of the path: a leading **/ (any depth), an inner /**/ (zero or more folders), a trailing /** (everything inside the
// folder, not the folder itself) and a lone ** (everything); a leading ! re-including what an earlier line left out,
// the last line that matches deciding. As in git, a file re-included inside a folder that is left out stays out: the
// walk never enters that folder.
// Not supported, and left out (the line is skipped): [] character classes and backslash escapes (so \! and \# lines
// too); nor are .gitignore files further down, .git/info/exclude or the user's global excludes read.
// Case (WP5, WP1 F1): git matches patterns ignoring case when core.ignorecase is on, and sets it when it makes a repository
// on a file system that ignores case (Windows and macOS, as a rule). A folder outside git has no config to read, so the
// walk asks its file system the same question git asks: whether the .gitignore answers to another case (foldsCaseAt).
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { foldsCase } from '../../shared/caseFolding'

/** Whether a folder-relative path (`/` separated) is ignored; `isDir` tells a folder from a file. */
export type IgnoreMatcher = (rel: string, isDir: boolean) => boolean

interface Rule {
  /** The whole folder-relative path must match. */
  re: RegExp
  dirOnly: boolean
  /** A ! line: a match re-includes. */
  negated: boolean
}

const glob = (part: string): string =>
  part.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*+/g, '[^/]*').replace(/\?/g, '[^/]')

function rule(line: string, foldCase: boolean): Rule | null {
  let p = line.replace(/\s+$/, '')
  if (p === '' || p.startsWith('#') || /[[\\]/.test(p)) return null
  const negated = p.startsWith('!')
  if (negated) p = p.slice(1)
  let dirOnly = false
  if (p.endsWith('/')) {
    dirOnly = true
    p = p.slice(0, -1)
  }
  // A slash anywhere but the end anchors the pattern to the folder; without one it matches at any depth.
  if (p.startsWith('/')) p = p.slice(1)
  else if (!p.includes('/')) p = `**/${p}`
  const parts = p.split('/').filter((part, i, all) => !(part === '**' && all[i - 1] === '**'))
  if (parts.some((part) => part === '')) return null
  let re = ''
  parts.forEach((part, i) => {
    const last = i === parts.length - 1
    if (part === '**') re += i === 0 ? (last ? '.*' : '(?:.*/)?') : last ? '/.+' : '(?:/.+)?'
    else re += (i > 0 && !(i === 1 && parts[0] === '**') ? '/' : '') + glob(part)
  })
  // `s`: a name may hold a line break (Linux and macOS allow one), and git's ** still matches it (HOLD-B #87, WP1 F3).
  return { re: new RegExp(`^${re}$`, foldCase ? 'is' : 's'), dirOnly, negated }
}

/** The matcher for a .gitignore's text; `foldCase` matches its patterns ignoring case, as git does with core.ignorecase. */
export function parseRootIgnore(text: string, opts: { foldCase?: boolean } = {}): IgnoreMatcher {
  const foldCase = opts.foldCase === true
  const rules = text
    .split(/\r?\n/)
    .map((line) => rule(line, foldCase))
    .filter((r): r is Rule => r !== null)
  return (rel, isDir) => {
    let ignored = false
    for (const r of rules) if ((isDir || !r.dirOnly) && r.re.test(rel)) ignored = !r.negated
    return ignored
  }
}

/** One path's device and file id (lstat: a link is never followed). */
export type FileIdOf = (path: string) => Promise<{ dev: bigint | number; ino: bigint | number }>
const realFileId: FileIdOf = (p) => lstat(p, { bigint: true })

/**
 * Whether the file system under `root` ignores case, found as git finds it for core.ignorecase: the .gitignore asked for
 * under another case is the same file (same device and file id). A file system with no file ids (0), or a .gitignore gone
 * since it was read, is judged by the platform (Windows and macOS fold case).
 */
export async function foldsCaseAt(root: string, fileId: FileIdOf = realFileId): Promise<boolean> {
  const own = await fileId(join(root, '.gitignore')).catch(() => null)
  if (!own || !own.ino) return foldsCase()
  const other = await fileId(join(root, '.GITIGNORE')).catch(() => null)
  return other !== null && other.dev === own.dev && other.ino === own.ino
}

/** The matcher for `root`'s own .gitignore; undefined when it has none, or it cannot be read. */
export async function readRootIgnore(root: string, fileId?: FileIdOf): Promise<IgnoreMatcher | undefined> {
  const text = await readFile(join(root, '.gitignore'), 'utf8').catch(() => null)
  return text === null ? undefined : parseRootIgnore(text, { foldCase: await foldsCaseAt(root, fileId) })
}
