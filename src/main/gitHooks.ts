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

import { join } from 'path'

export type HookName = 'pre-commit' | 'pre-push'

export interface HookDeps {
  readFile: (p: string) => string | null
  writeFile: (p: string, data: string) => void
  exists: (p: string) => boolean
  chmod: (p: string, mode: number) => void
  remove: (p: string) => void
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
    '  # nvm and node upgrades move the baked path; check PATH before giving up, or the',
    '  # shield switches itself off the day node moves and nobody ever notices.',
    '  [ -x "$_termpolis_node" ] || _termpolis_node=$(command -v node 2>/dev/null)',
    '  # FAIL OPEN: node gone, or Termpolis uninstalled → skip the scan, never block.',
    '  [ -x "$_termpolis_node" ] || return 0',
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
  if (!deps.exists(file)) return ''
  return deps.readFile(file)
}

/** Write both hooks. Returns what it actually wrote — a non-shell foreign hook is
 *  skipped and left byte-identical, so the caller can tell the user why it is still
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
 *  leave a foreign hook that is still valid and still executable. Never ours → never
 *  touched. Returns what it removed or cleaned. */
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
