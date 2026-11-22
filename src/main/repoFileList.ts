// The git file listing every map of a repository reads: the code graph and memory ingest (codeIngest.ts) and
// Lumopolis's own snapshot in the world utility process (world/fileSnapshot.ts). Pure: no process runs here, so the
// world host can import it without reaching the main process's command runners.

/** Tracked files plus untracked ones the ignore files do not exclude, unquoted (core.quotepath=false) and NUL separated. */
export function lsFilesArgs(root: string): string[] {
  return ['-c', 'core.quotepath=false', '-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard']
}

/** Tracked files inside the submodules too. git allows --recurse-submodules only with --cached, so it is a second listing. */
export function lsSubmoduleArgs(root: string): string[] {
  return ['-c', 'core.quotepath=false', '-C', root, 'ls-files', '-z', '--cached', '--recurse-submodules']
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 }

/** Undoes git's C quoting of a path ("caf\303\251.ts" → café.ts). A name not in double quotes comes back as it is. */
export function unquoteGitPath(name: string): string {
  if (name.length < 2 || name[0] !== '"' || name[name.length - 1] !== '"') return name
  const inner = name.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch !== '\\' || i === inner.length - 1) {
      // A whole code point, so a letter outside the BMP is encoded from both halves.
      const cp = inner.codePointAt(i) as number
      const s = String.fromCodePoint(cp)
      bytes.push(...Buffer.from(s, 'utf8'))
      i += s.length - 1
      continue
    }
    const next = inner[i + 1]
    const octal = /^[0-7]{3}$/.test(inner.slice(i + 1, i + 4)) ? inner.slice(i + 1, i + 4) : null
    if (octal) {
      bytes.push(parseInt(octal, 8))
      i += 3
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0))
      i += 1
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/**
 * The paths of a git ls-files listing, relative to the folder it ran in. -z output is split on NUL and kept as
 * written; plain output (a test's or an older caller's) is one name a line with git's quoting undone. Duplicates go,
 * and so do names that are not valid UTF-8: they decode with a replacement character, so no read would find them.
 */
export function parseLsFiles(stdout: string): string[] {
  const raw = stdout.includes('\0') ? stdout.split('\0') : stdout.split(/\r?\n/).map(unquoteGitPath)
  const seen = new Set<string>()
  for (const name of raw) if (name !== '' && !name.includes('�')) seen.add(name)
  return [...seen]
}

/**
 * The repository's own listing joined with the submodule listing, sorted. A submodule shows in the own listing as one
 * entry for its folder (the gitlink); once its files are listed, that entry goes, since it is a folder, not a file.
 */
export function mergeListings(own: readonly string[], recursed: readonly string[]): string[] {
  const all = new Set<string>([...own, ...recursed])
  const folders = new Set<string>()
  for (const p of all) {
    let at = p.indexOf('/')
    while (at !== -1) {
      folders.add(p.slice(0, at))
      at = p.indexOf('/', at + 1)
    }
  }
  return [...all].filter((p) => !folders.has(p)).sort()
}
