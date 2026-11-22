// The .gitignore at the top of a walked folder (world host, Node only): a folder outside git (a repository downloaded
// as a ZIP, say) still names its build output and caches there, so the walk leaves them out as git would.
//
// Supported, as git reads them: blank lines and # comments; a name or glob (* and ?) with no slash, matching at any
// depth; a trailing / for folders only; a leading or inner / anchoring the pattern to the folder; a leading **/
// (matches at any depth) and a trailing /** (the folder itself); a leading ! re-including what an earlier line left
// out, the last line that matches deciding. As in git, a file re-included inside a folder that is left out stays out:
// the walk never enters that folder.
// Not supported, and left out (the line is skipped): ** anywhere else, [] character classes, backslash escapes (so
// \! and \# lines too); nor are .gitignore files further down, .git/info/exclude or the user's global excludes read.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Whether a folder-relative path (`/` separated) is ignored; `isDir` tells a folder from a file. */
export type IgnoreMatcher = (rel: string, isDir: boolean) => boolean

interface Rule {
  segs: RegExp[]
  anchored: boolean
  dirOnly: boolean
  /** A ! line: a match re-includes. */
  negated: boolean
}

const segment = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`)

function rule(line: string): Rule | null {
  let p = line.replace(/\s+$/, '')
  if (p === '' || p.startsWith('#') || /[[\\]/.test(p)) return null
  const negated = p.startsWith('!')
  if (negated) p = p.slice(1)
  let floating = false
  if (p.startsWith('**/')) {
    floating = true
    p = p.slice(3)
  }
  let dirOnly = false
  // foo/** holds a slash, so it is anchored like any pattern with one.
  let anchored = false
  if (p.endsWith('/**')) {
    dirOnly = true
    anchored = true
    p = p.slice(0, -3)
  }
  if (p.endsWith('/')) {
    dirOnly = true
    p = p.slice(0, -1)
  }
  if (p.includes('**') || p === '') return null
  const lead = p.startsWith('/')
  if (lead) p = p.slice(1)
  anchored = !floating && (anchored || lead || p.includes('/'))
  return { segs: p.split('/').map(segment), anchored, dirOnly, negated }
}

function matches(r: Rule, rel: string, isDir: boolean): boolean {
  if (r.dirOnly && !isDir) return false
  const parts = rel.split('/')
  if (r.anchored ? parts.length !== r.segs.length : parts.length < r.segs.length) return false
  const from = parts.length - r.segs.length
  return r.segs.every((re, i) => re.test(parts[from + i]))
}

/** The matcher for a .gitignore's text. */
export function parseRootIgnore(text: string): IgnoreMatcher {
  const rules = text.split(/\r?\n/).map(rule).filter((r): r is Rule => r !== null)
  return (rel, isDir) => {
    let ignored = false
    for (const r of rules) if (matches(r, rel, isDir)) ignored = !r.negated
    return ignored
  }
}

/** The matcher for `root`'s own .gitignore; undefined when it has none, or it cannot be read. */
export async function readRootIgnore(root: string): Promise<IgnoreMatcher | undefined> {
  const text = await readFile(join(root, '.gitignore'), 'utf8').catch(() => null)
  return text === null ? undefined : parseRootIgnore(text)
}
