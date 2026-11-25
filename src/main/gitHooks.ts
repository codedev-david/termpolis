// Commit Shield git hooks — install / uninstall / detect the `pre-commit` and
// `pre-push` shims that invoke the standalone scanner.
//
// WHY a hook at all: commitScan.ts only runs while Termpolis is open and the user
// commits THROUGH the app. A real repo gets committed from VS Code, from a plain
// terminal, from a script. A git hook is the only place that sees every commit,
// so the shield has to live in the repo, not in the app.
//
// THE HARD PART IS NOT WRITING A FILE — it is not destroying the one that is
// already there. Half the repos in the world have a husky / lint-staged /
// pre-commit-framework hook, and silently overwriting it would break the user's
// CI contract in a way they'd discover days later. So:
//
//   - our lines live in a SENTINEL-DELIMITED block, inserted directly below the
//     foreign hook's shebang (their interpreter still owns the file);
//   - we run FIRST, then FALL THROUGH to their script. Fall-through, not `exec`,
//     is what keeps their exit code the hook's exit code — a leaked secret is
//     unrecoverable, a failed lint is not, so the cheap fatal check goes first,
//     and a formatter can't rewrite the tree out from under our scan;
//   - uninstall strips ONLY the block, so `uninstall(install(x)) === x`, byte for
//     byte, and a hook we never owned is never touched;
//   - a non-POSIX-shell hook (pre-commit.com generates a PYTHON one) is SKIPPED,
//     never injected into — sh code in a python file is a SyntaxError, i.e. a
//     wedged repo. Not protecting a hook beats corrupting it.
//
// The emitted script FAILS OPEN by design (see renderBlock). Fully fs-injected so
// the whole thing is unit tested without a repo.

import { join, type posix } from 'path'

export type HookName = 'pre-commit' | 'pre-push'

export interface HookDeps {
  readFile: (p: string) => string | null
  writeFile: (p: string, data: string) => void
  exists: (p: string) => boolean
  chmod: (p: string, mode: number) => void
  remove: (p: string) => void
  /** What the file at `p` is, without following a link (hookFileKind). */
  fileKind: (p: string) => HookFileKind
}

/** A hook file as lstat sees it. 'link': a symbolic link (on Windows also a junction), or a hard link shared with
 *  another file; 'other': not a regular file (a folder, a pipe, a device), or lstat failed for a reason other than
 *  the file not being there. Install and uninstall read and write only 'file' and 'absent'. */
export type HookFileKind = 'absent' | 'file' | 'link' | 'other'

/** The fields of fs.Stats that hookFileKind reads. */
export interface HookStat {
  isSymbolicLink(): boolean
  isFile(): boolean
  nlink: number
}

/** The kind of the file `lstat` describes (index.ts hands it lstatSync of the hook file). A link is never followed:
 *  every write follows one, so a pre-commit that links to ~/.bashrc would put the shield block and an exec bit there
 *  (I1). A link that stays inside the repository is refused too: a link is how that attack works, and husky and
 *  lefthook move hooks with core.hooksPath, not with links. */
export function hookFileKind(lstat: () => HookStat): HookFileKind {
  let s: HookStat
  try {
    s = lstat()
  } catch (e) {
    return (e as { code?: unknown } | null)?.code === 'ENOENT' ? 'absent' : 'other'
  }
  if (s.isSymbolicLink()) return 'link'
  if (!s.isFile()) return 'other'
  return s.nlink > 1 ? 'link' : 'file'
}

export interface HookPaths {
  /** The repo's real hooks dir — caller resolves it with `git rev-parse --git-path hooks`
   *  (worktrees and `core.hooksPath` both move it). */
  hooksDir: string
  /** Absolute path to node. */
  nodePath: string
  /** Absolute path to termpolis-githook.cjs. */
  scriptPath: string
}

/** 'foreign' = a hook file is there that carries no block of ours. */
export type HookState = 'installed' | 'absent' | 'foreign'

const HOOK_NAMES: readonly HookName[] = ['pre-commit', 'pre-push']
const BEGIN = '# >>> termpolis commit shield >>>'
const END = '# <<< termpolis commit shield <<<'
const HOOK_MODE = 0o755

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Sentinel-delimited, content-agnostic: this must also match a block emitted by an
// older Termpolis (different node path, different lines), or uninstall would leave
// a dead block behind. `g` because a buggy older build could have doubled it.
const BLOCK_RE = new RegExp(`^[ \\t]*${esc(BEGIN)}[\\s\\S]*?^[ \\t]*${esc(END)}[^\\n]*\\n?`, 'gm')

// Which interpreters can safely host a block of POSIX sh. A shebang naming none of
// these (python, ruby, node, perl, fish) means "do not touch this file".
const SHELL_SHEBANG = /\b(?:sh|bash|dash|ash|zsh|ksh|mksh|busybox)\b/

const hookPath = (paths: HookPaths, name: HookName): string => join(paths.hooksDir, name)

/** POSIX single-quoting. Single quotes take EVERYTHING literally, which is what a
 *  Windows path needs — `"C:\Program Files\..."` in double quotes leaves sh free to
 *  chew on the backslashes. Backslashes are normalised to `/` first: MSYS sh (which
 *  is what Git for Windows runs hooks through) treats a backslash path as
 *  interpreter-dependent at best, while `C:/Program Files/...` is accepted by every
 *  Windows API and by every other platform. */
function shq(p: string): string {
  const posix = String(p).replace(/\\/g, '/')
  return `'${posix.split("'").join(`'\\''`)}'`
}

/** The sentinel block. Everything about it is shaped by one rule: NEVER WEDGE GIT.
 *  A user whose commits all fail because Termpolis moved is worse off than a user
 *  with no shield at all, so every one of our own failure modes exits 0 — only the
 *  scanner itself is allowed to block. And every bail-out is `return`, not `exit`:
 *  an `exit 0` here would silently skip a foreign hook chained below the block. */
function renderBlock(name: HookName, paths: HookPaths): string {
  return [
    BEGIN,
    '# Termpolis Commit Shield — scans what git is about to capture (the staged diff)',
    '# or send (every unpushed commit) and aborts when a secret is found.',
    '# Managed block: Settings → AI Security → Commit Shield. Safe to delete by hand.',
    'termpolis_commit_shield() {',
    `  _termpolis_node=${shq(paths.nodePath)}`,
    `  _termpolis_shield=${shq(paths.scriptPath)}`,
    '  # Only the full path the installer found. Never a node looked up on PATH: this runs in the',
    '  # repository, and a PATH entry can name a folder inside it, where a planted node would run.',
    '  # FAIL OPEN when it is gone (an nvm or node upgrade moves it), and say so: a shield that',
    '  # switched itself off without a word is one nobody knows to protect again.',
    '  case "$_termpolis_node" in /*|[A-Za-z]:/*) [ -x "$_termpolis_node" ] ;; *) false ;; esac || {',
    '    echo "Termpolis Commit Shield skipped: node was not found at $_termpolis_node. Protect this repository again in Termpolis." >&2',
    '    return 0',
    '  }',
    '  # FAIL OPEN: Termpolis uninstalled → skip the scan, never block.',
    '  [ -f "$_termpolis_shield" ] || return 0',
    '  # stdin is deliberately untouched: git hands a push hook its ref list there and a',
    '  # chained hook below still has to read it. The scanner takes the mode on argv.',
    `  "$_termpolis_node" "$_termpolis_shield" ${name}`,
    '  _termpolis_code=$?',
    '  # 126/127 = could not execute / not found. Our problem, not the user\'s → open.',
    '  [ "$_termpolis_code" -eq 126 ] && return 0',
    '  [ "$_termpolis_code" -eq 127 ] && return 0',
    '  # Anything else is the scanner\'s verdict: 1 = secret found = abort.',
    '  return "$_termpolis_code"',
    '}',
    // Variables are `_termpolis_`-prefixed because this block shares its shell with
    // whatever foreign hook falls through below it — a bare NODE= would clobber theirs.
    'termpolis_commit_shield || exit 1',
    END,
    '',
  ].join('\n')
}

/** The whole script text for a hook we own outright. Pure. */
export function renderHook(name: HookName, paths: HookPaths): string {
  // `#!/bin/sh`, not bash: Git for Windows runs hooks through MSYS sh, and the block
  // is POSIX so it survives dash/ash/zsh too.
  return `#!/bin/sh\n${renderBlock(name, paths)}`
}

const hasBlock = (text: string): boolean => text.includes(BEGIN)

/** Drop every block of ours, byte-preserving everything else (CRLF included). */
const stripBlock = (text: string): string => text.replace(BLOCK_RE, '')

/** Is there anything here besides our block and a shebang? A file that is only a
 *  shebang is a no-op script, so it is ours to delete — but a stray comment is the
 *  user's, and we do not delete the user's bytes. */
function hasForeignContent(text: string): boolean {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (i === 0 && line.startsWith('#!')) continue
    return true
  }
  return false
}

/** sh code is only safe to inject into a shell script. No shebang is fine — git
 *  runs a bare hook with sh. A python/ruby/node shebang is a hard NO. */
function isChainable(text: string): boolean {
  if (!text.trim()) return true
  const first = text.split('\n', 1)[0]
  if (!first.startsWith('#!')) return true
  return SHELL_SHEBANG.test(first)
}

/** Our block goes directly BELOW the foreign shebang, so husky's `#!/usr/bin/env bash`
 *  still owns the file and its bash-isms keep working. Their bytes are never rewritten
 *  — we only splice, which is what makes the uninstall round-trip exact. */
function insertAfterShebang(text: string, block: string): string {
  if (!text.startsWith('#!')) return block + text
  // Only ever called with foreign content present, so a shebang guarantees a line
  // below it. (Even if it somehow didn't, slice(0, 0) degrades to a plain prepend.)
  const nl = text.indexOf('\n')
  return text.slice(0, nl + 1) + block + text.slice(nl + 1)
}

/** The one function that decides a hook's final bytes. Idempotent by construction:
 *  any previous block of ours is stripped before the fresh one goes in, so installing
 *  twice is byte-identical and a moved node path upgrades in place instead of stacking
 *  a second block. */
function composeHook(name: HookName, paths: HookPaths, existing: string): string {
  const rest = stripBlock(existing)
  if (!hasForeignContent(rest)) return renderHook(name, paths)
  return insertAfterShebang(rest, renderBlock(name, paths))
}

/** '' = no hook there (safe to create). null = a hook IS there but we could not read it
 *  (EPERM, a binary, a race) — and a file we cannot read is a file we do not get to
 *  guess about, so callers must leave it strictly alone. Overwriting it would be the
 *  exact clobber this module exists to prevent. */
function readHook(file: string, deps: HookDeps): string | null {
  const kind = deps.fileKind(file)
  if (kind === 'absent') return ''
  if (kind !== 'file') return null // a link or not a regular file: never read through, never written (I1)
  return deps.readFile(file)
}

/** The first hook file the installer must not touch, with its kind: a link, or not a regular file. index.ts refuses
 *  the whole install over one, before anything is written, so the person hears why (installHooks also skips it). */
export function unsafeHook(paths: HookPaths, deps: HookDeps): { name: HookName; kind: 'link' | 'other' } | null {
  for (const name of HOOK_NAMES) {
    const kind = deps.fileKind(hookPath(paths, name))
    if (kind === 'link' || kind === 'other') return { name, kind }
  }
  return null
}

/** Write both hooks. Returns what it actually wrote — a non-shell foreign hook, a link and
 *  a file that is not a regular one are skipped and left byte-identical, so the caller can tell the user why it is still
 *  unprotected instead of us corrupting it. */
export function installHooks(paths: HookPaths, deps: HookDeps): HookName[] {
  const written: HookName[] = []
  for (const name of HOOK_NAMES) {
    const file = hookPath(paths, name)
    const existing = readHook(file, deps)
    if (existing === null || !isChainable(existing)) continue
    deps.writeFile(file, composeHook(name, paths, existing))
    deps.chmod(file, HOOK_MODE)
    written.push(name)
  }
  return written
}

/** Surgical. Ours alone → the file goes with us. Chained → strip only the block and
 *  leave a foreign hook that is still valid and still executable. Never ours, a link, or
 *  not a regular file → never touched. Returns what it removed or cleaned. */
export function uninstallHooks(paths: HookPaths, deps: HookDeps): HookName[] {
  const cleaned: HookName[] = []
  for (const name of HOOK_NAMES) {
    const file = hookPath(paths, name)
    const existing = readHook(file, deps)
    if (existing === null || !hasBlock(existing)) continue
    const rest = stripBlock(existing)
    if (hasForeignContent(rest)) {
      deps.writeFile(file, rest)
      deps.chmod(file, HOOK_MODE)
    } else {
      deps.remove(file)
    }
    cleaned.push(name)
  }
  return cleaned
}

// WHERE THE INSTALLER MAY WRITE (#36, WPS M7). `git rev-parse --git-path hooks` answers with core.hooksPath, and a
// repository's own config (a folder that arrived with its .git: an extracted archive, a shared folder) can point that
// anywhere: `core.hooksPath=../../elsewhere` would have "Protect a repository" write pre-commit and pre-push outside
// it. So the hooks folder must lie in the repository's git folder (its common dir, which holds a linked worktree's
// hooks) or its working tree (husky's `.husky`), compared after following links. Outside both, it is allowed only when
// core.hooksPath is the person's own setting (global or system) and the repository sets none of its own.

/** The scopes of every core.hooksPath value, from `git config --show-scope -z --get-all core.hooksPath`
 *  (`scope NUL value NUL`, repeated). */
export function hooksPathScopes(out: string): string[] {
  return out.split('\0').filter((_, i) => i % 2 === 0).filter((s) => s !== '')
}

type Realpath = (p: string) => Promise<string>
/** node's path, or its win32 or posix rules. */
export type PathApi = typeof posix

/** `p` with its nearest existing ancestor's links followed (the hooks folder may not exist yet), or as written. */
async function realOrWritten(p: string, path: PathApi, realpath: Realpath): Promise<string> {
  let at = path.resolve(p)
  let rest = ''
  for (;;) {
    try {
      return path.join(await realpath(at), rest)
    } catch {
      const up = path.dirname(at)
      if (up === at) return path.resolve(p)
      rest = path.join(path.basename(at), rest)
      at = up
    }
  }
}

export interface HooksWriteFacts {
  hooksDir: string
  /** The repository's git folder (common dir) and working tree, absolute. */
  roots: string[]
  /** Reads core.hooksPath's scopes; null when they could not be read. Asked only for a folder outside the roots. */
  scopes: () => Promise<string[] | null>
  /** The path rules hooksDir was resolved with (index.ts: node's own), and the platform, whose file names ignore case
   *  on Windows and macOS. */
  path: PathApi
  platform: NodeJS.Platform
  realpath: Realpath
}

/** True when the installer may write hooks into `hooksDir` (see above). */
export async function shieldMayWriteHooks(f: HooksWriteFacts): Promise<boolean> {
  const path = f.path
  const fold = f.platform === 'win32' || f.platform === 'darwin' ? (s: string): string => s.toLowerCase() : (s: string): string => s
  const dir = fold(await realOrWritten(f.hooksDir, path, f.realpath))
  for (const root of f.roots) {
    const rel = path.relative(fold(await realOrWritten(root, path, f.realpath)), dir)
    if (rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))) return true
  }
  const scopes = await f.scopes()
  if (scopes === null) return false
  return scopes.some((s) => s === 'global' || s === 'system') && !scopes.some((s) => s === 'local' || s === 'worktree')
}

/** Runs one read-only git command in the repository and prints its output (index.ts hands safeGitAsync). */
export type HooksGit = (args: string[]) => Promise<string>

/** shieldMayWriteHooks for the repository at `repo`, with the roots git names, each checked (M2):
 *  - the working tree (`--show-toplevel`), only when `repo` lies in it: a repository's own core.worktree can name
 *    any folder as its working tree, and then nothing it names counts;
 *  - the git folder (`--git-common-dir`), only when it belongs to this working tree. A `.git` file, or a `commondir`
 *    file in the folder one names, can point at another repository's git folder; that folder is not this one's. It
 *    belongs when it lies in the working tree, when this is a linked worktree of it (the git dir is
 *    `<common>/worktrees/<name>` and its `gitdir` file names this working tree's `.git`), or when it is a submodule's
 *    (the git dir is the common dir, and its core.worktree, relative to it, is this working tree);
 *  - a bare repository (no working tree): the git folder, when it is the git dir and `repo` lies in it.
 *  A root git cannot name, or one that fails its check, is left out. `git init --separate-git-dir` makes a `.git`
 *  file that names a git folder with no core.worktree: that repository is refused, since nothing tells it apart from
 *  a `.git` file naming another repository's git folder. */
export async function shieldHooksAllowed(o: {
  repo: string
  hooksDir: string
  git: HooksGit
  /** A file's text, or null when it cannot be read (index.ts: fs.promises.readFile). */
  readFile: (p: string) => Promise<string | null>
  path: PathApi
  platform: NodeJS.Platform
  realpath: Realpath
}): Promise<boolean> {
  const path = o.path
  const fold = o.platform === 'win32' || o.platform === 'darwin' ? (s: string): string => s.toLowerCase() : (s: string): string => s
  const real = async (p: string): Promise<string> => fold(await realOrWritten(p, path, o.realpath))
  const inside = async (child: string, parent: string): Promise<boolean> => {
    const rel = path.relative(await real(parent), await real(child))
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
  }
  const same = async (a: string, b: string): Promise<boolean> => (await real(a)) === (await real(b))
  const named = (args: string[]): Promise<string> => o.git(args).then((s) => s.trim(), () => '')
  const at = (p: string): string => path.resolve(o.repo, p)

  const roots: string[] = []
  const top = await named(['rev-parse', '--show-toplevel'])
  const commonNamed = await named(['rev-parse', '--git-common-dir'])
  const common = commonNamed === '' ? '' : at(commonNamed)
  if (top !== '') {
    const tree = at(top)
    if (await inside(o.repo, tree)) {
      roots.push(tree)
      if (common !== '' && (await commonBelongs(common, tree))) roots.push(common)
    }
  } else if (common !== '') {
    const gitDir = await named(['rev-parse', '--absolute-git-dir'])
    if (gitDir !== '' && (await same(gitDir, common)) && (await inside(o.repo, common))) roots.push(common)
  }

  async function commonBelongs(c: string, tree: string): Promise<boolean> {
    if (await inside(c, tree)) return true
    const gitDirNamed = await named(['rev-parse', '--absolute-git-dir'])
    if (gitDirNamed === '') return false
    const gitDir = at(gitDirNamed)
    if (await same(path.dirname(gitDir), path.join(c, 'worktrees'))) {
      const back = (await o.readFile(path.join(gitDir, 'gitdir')))?.trim() ?? ''
      return back !== '' && (await same(path.resolve(gitDir, back), path.join(tree, '.git')))
    }
    if (!(await same(gitDir, c))) return false
    const worktree = await named(['config', '--local', '--get', 'core.worktree'])
    return worktree !== '' && (await same(path.resolve(gitDir, worktree), tree))
  }

  const scopes = (): Promise<string[] | null> =>
    o.git(['config', '--show-scope', '-z', '--get-all', 'core.hooksPath']).then(hooksPathScopes, () => null)
  return shieldMayWriteHooks({ hooksDir: o.hooksDir, roots, scopes, path, platform: o.platform, realpath: o.realpath })
}

/** The node the hook is baked with: resolveNodeCommand's answer with only the PATH folders written as full paths, or
 *  null when that finds no node. A relative PATH folder names one inside whatever folder Termpolis was started in,
 *  and resolveNodeCommand's last resort, the bare `node`, is not a full path either (M1). */
export function shieldNodePath(
  env: NodeJS.ProcessEnv,
  resolve: (env: NodeJS.ProcessEnv) => string,
  path: PathApi,
  delimiter: string,
): string | null {
  const entries = (env.PATH ?? env.Path ?? '').split(delimiter).filter((d) => d.trim() !== '' && path.isAbsolute(d.trim()))
  const found = resolve({ ...env, PATH: entries.join(delimiter), Path: undefined })
  return path.isAbsolute(found) ? found : null
}

export function hookStatus(paths: HookPaths, deps: HookDeps): Record<HookName, HookState> {
  const out = {} as Record<HookName, HookState>
  for (const name of HOOK_NAMES) {
    const file = hookPath(paths, name)
    if (!deps.exists(file)) {
      out[name] = 'absent'
      continue
    }
    out[name] = hasBlock(deps.readFile(file) ?? '') ? 'installed' : 'foreign'
  }
  return out
}
