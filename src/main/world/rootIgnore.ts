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
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

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

function rule(line: string): Rule | null {
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
  return { re: new RegExp(`^${re}$`), dirOnly, negated }
}

/** The matcher for a .gitignore's text. */
export function parseRootIgnore(text: string): IgnoreMatcher {
  const rules = text.split(/\r?\n/).map(rule).filter((r): r is Rule => r !== null)
  return (rel, isDir) => {
    let ignored = false
    for (const r of rules) if ((isDir || !r.dirOnly) && r.re.test(rel)) ignored = !r.negated
    return ignored
  }
}

/** The matcher for `root`'s own .gitignore; undefined when it has none, or it cannot be read. */
export async function readRootIgnore(root: string): Promise<IgnoreMatcher | undefined> {
  const text = await readFile(join(root, '.gitignore'), 'utf8').catch(() => null)
  return text === null ? undefined : parseRootIgnore(text)
}
