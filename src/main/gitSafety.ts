// Git safety: what keeps a repository's own configuration from running a program when Termpolis only reads it.
//
// A folder can arrive WITH its `.git` folder (an extracted archive, a shared or network folder, a USB copy), and
// everything in that `.git` is the folder author's: its config (and every file that config includes), its hooks, its
// `info/attributes`, and the committed `.gitattributes`. Several of those settings name a program git runs on its
// own, and plain read commands reach them:
//
//   core.fsmonitor              status, diff, diff-tree, ls-files
//   filter.<x>.clean / process  status, diff (a stat-dirty file is hashed through its clean filter)
//   post-index-change hook      status, diff (status refreshes and rewrites the index)
//   diff.external, diff.<x>.command, diff.<x>.textconv   diff, show, log -p
//   log.showSignature, format.pretty with %G, + gpg.program   log, show
//   a submodule's own config    status and diff ask each submodule for its dirty state with a child git
//   diff.submodule=diff         diff, show, log -p run a child diff in each changed submodule, under ITS diff.external
//
// git clone never carries `.git/config` or hooks, and safe.directory does not help on Windows (an extracted folder
// is owned by the person who extracted it), so the read commands themselves have to switch those programs off.
//
// The rules, keyed on the git subcommand (guardGitArgs):
//
// - A command that only reads (status, diff, log, show, ls-files, rev-parse, …, and anything not named as a write)
//   carries readOnlyPrefix: no fsmonitor, no hooks, no signature check, git's default log format. `rev-parse` keeps
//   the hooks folder, because `rev-parse --git-path hooks` answers with core.hooksPath (the Commit-Shield installer
//   asks it where the hooks live) and rev-parse never runs a hook.
// - diff, show and log also carry displayFlags: no external diff, no textconv, submodules shown by commit only, and
//   for status and diff, a submodule's dirty state is not asked for (that child git would read the submodule's own
//   config, whose filter names nobody here has scanned).
// - status and diff can run a clean filter, and `-c filter.<x>.clean=` needs the driver's name. So the repository's
//   filter drivers are read first (filterScanArgs: `git config`, which reads config and runs nothing), and every
//   driver the repository's own config defines (scope local or worktree, includes counted as the file that includes
//   them) is set back to the person's own value for it, or to none (filterOverrides). A global driver such as
//   git-lfs's keeps working: only the repository's definitions are replaced.
// - A command that writes (add, commit, checkout, reset, apply, pull, push, …) is left exactly as the person's git
//   would run it, filters, hooks and the login helper included. Blanking a clean filter on `add` would commit raw
//   content into a git-lfs repository.
//
// No Electron imports: the Lumopolis world host (a utilityProcess) loads this through gitLogin.ts, and
// tests/electron/gitSafetyGuard.test.ts fails on a git spawn in src/main that does not go through these builders.

/** The device git is pointed at for "no hooks folder". */
export function nullDevice(isWindows: boolean): string {
  return isWindows ? 'NUL' : '/dev/null'
}

/**
 * The flags every Lumopolis world git run carries (clone, fetch, the repository listings): no local-file transport, no
 * hooks, symlinks checked out as plain files, and no fsmonitor program. Re-exported by world/gitLogin.ts.
 */
export function safetyFlags(isWindows: boolean): string[] {
  return [
    '-c', 'protocol.file.allow=never',
    '-c', `core.hooksPath=${nullDevice(isWindows)}`,
    '-c', 'core.symlinks=false',
    '-c', 'core.fsmonitor=false'
  ]
}

/**
 * Subcommands that change the repository, the index or a remote, run only when the person asked. They keep the
 * person's filters, hooks, fsmonitor and login helper: nothing is added to them.
 */
export const MUTATING_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit', 'fetch', 'init', 'merge', 'mv', 'pull',
  'push', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'submodule', 'switch', 'tag', 'worktree'
])

/** Read subcommands that can run a clean filter: they need the repository's filter drivers read first. */
export const FILTER_SUBCOMMANDS: ReadonlySet<string> = new Set(['status', 'diff'])

/** The read-only prefix for `sub`: no fsmonitor program, no hooks (except for rev-parse, see the header), no
 *  signature check, and git's own default log format (a repository's format.pretty can ask for %G, which runs gpg). */
export function readOnlyPrefix(sub: string, isWindows: boolean): string[] {
  return [
    '-c', 'core.fsmonitor=false',
    ...(sub === 'rev-parse' ? [] : ['-c', `core.hooksPath=${nullDevice(isWindows)}`]),
    '-c', 'log.showSignature=false',
    '-c', 'format.pretty=medium'
  ]
}

/** The flags a read of `sub` adds after the subcommand. */
export function displayFlags(sub: string): string[] {
  switch (sub) {
    case 'diff':
      return ['--no-ext-diff', '--no-textconv', '--submodule=short', '--ignore-submodules=dirty']
    case 'show':
    case 'log':
      return ['--no-ext-diff', '--no-textconv', '--submodule=short']
    case 'status':
      return ['--ignore-submodules=dirty']
    default:
      return []
  }
}

/** Global options that take their value as the next argument. */
const VALUED_GLOBALS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path', '--attr-source'])

/** Where the subcommand sits in `args`, after git's global options, or null when there is none. */
export function gitSubcommand(args: readonly string[]): { index: number; name: string } | null {
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (!a.startsWith('-')) return { index: i, name: a }
    i += VALUED_GLOBALS.has(a) ? 2 : 1
  }
  return null
}

/** The value the leading `-c` options give `key` (the last one wins, as in git), or undefined. */
function leadingValue(leading: readonly string[], key: string): string | undefined {
  let value: string | undefined
  for (let i = 0; i < leading.length; i++) {
    if (leading[i] === '-c' && i + 1 < leading.length) {
      const pair = leading[i + 1]
      const eq = pair.indexOf('=')
      if (eq > 0 && pair.slice(0, eq).toLowerCase() === key.toLowerCase()) value = pair.slice(eq + 1)
      i++
    }
  }
  return value
}

/** Whether a run of `args` needs the repository's filter drivers read first (see filterScanArgs). */
export function needsFilterScan(args: readonly string[]): boolean {
  const sub = gitSubcommand(args)
  return sub !== null && FILTER_SUBCOMMANDS.has(sub.name)
}

/**
 * The argument list git is started with for `args`: a write unchanged; a read with readOnlyPrefix and
 * `filterOverrides` just before the subcommand (so they come after, and win over, any `-c` the caller gave), and
 * displayFlags just after it. A flag the caller already gave is not repeated.
 */
export function guardGitArgs(args: readonly string[], isWindows: boolean, filterOverrides: readonly string[] = []): string[] {
  const sub = gitSubcommand(args)
  if (sub === null) return [...readOnlyPrefix('', isWindows), ...args]
  if (MUTATING_SUBCOMMANDS.has(sub.name)) return [...args]
  const leading = args.slice(0, sub.index)
  const rest = args.slice(sub.index + 1)
  const prefix = readOnlyPrefix(sub.name, isWindows)
  const added: string[] = []
  for (let i = 0; i < prefix.length; i += 2) {
    const pair = prefix[i + 1]
    const eq = pair.indexOf('=')
    if (leadingValue(leading, pair.slice(0, eq)) !== pair.slice(eq + 1)) added.push('-c', pair)
  }
  const end = rest.indexOf('--')
  const options = end === -1 ? rest : rest.slice(0, end)
  const flags = displayFlags(sub.name).filter((f) => !options.includes(f))
  return [...leading, ...added, ...filterOverrides, sub.name, ...flags, ...rest]
}

/** The command that lists every filter driver setting with the scope it comes from. Reading config runs nothing;
 *  it carries the read-only prefix all the same, and the `-C` of the command it serves. */
export function filterScanArgs(args: readonly string[], isWindows: boolean): string[] {
  const sub = gitSubcommand(args)
  const leading = sub === null ? [] : args.slice(0, sub.index)
  const at: string[] = []
  for (let i = 0; i < leading.length; i++) {
    if (VALUED_GLOBALS.has(leading[i])) {
      if (leading[i] === '-C') at.push('-C', leading[i + 1])
      i++
    }
  }
  return [...at, ...readOnlyPrefix('config', isWindows), 'config', '--show-scope', '-z', '--get-regexp', '^filter\\.']
}

/** Scopes whose settings are the person's own. Everything else (local, worktree, and any scope a later git adds)
 *  comes from the repository. */
const TRUSTED_SCOPES = new Set(['system', 'global', 'command'])

/** The driver settings that run a program, and `required`, which would make a removed driver a fatal error. */
const DRIVER_KEYS = ['clean', 'smudge', 'process', 'required'] as const

/** Thrown when a repository's filter driver cannot be switched off from the command line. The read is not run. */
export class UnsafeFilterError extends Error {
  constructor(name: string) {
    super(`git: the repository defines a filter driver that cannot be switched off (${JSON.stringify(name)}); not run`)
    this.name = 'UnsafeFilterError'
  }
}

/**
 * The `-c` options that switch off every filter driver the repository's own config defines, from the output of
 * filterScanArgs (`scope NUL key LF value NUL`, repeated). Each such driver gets its four settings back from the
 * person's own config (system, global, command line) or, where they have none, no program and `required=false`.
 * A driver name holding `=` cannot be written as a `-c` key (git splits at the first `=`), so it throws rather than
 * leave that driver running.
 */
export function filterOverrides(scan: string): string[] {
  const trusted = new Map<string, string>()
  const repoDrivers: string[] = []
  const parts = scan.split('\0')
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i]
    const entry = parts[i + 1]
    const lf = entry.indexOf('\n')
    const key = lf === -1 ? entry : entry.slice(0, lf)
    const value = lf === -1 ? '' : entry.slice(lf + 1)
    // filter.<name>.<var>: the name is everything between the first and the last dot, and may hold dots itself.
    const first = key.indexOf('.')
    const last = key.lastIndexOf('.')
    if (first === -1 || last <= first) continue
    const name = key.slice(first + 1, last)
    const variable = key.slice(last + 1).toLowerCase()
    if (TRUSTED_SCOPES.has(scope)) trusted.set(`${name}\n${variable}`, value)
    else if (!repoDrivers.includes(name)) repoDrivers.push(name)
  }
  const out: string[] = []
  for (const name of repoDrivers) {
    if (name.includes('=')) throw new UnsafeFilterError(name)
    for (const variable of DRIVER_KEYS) {
      const own = trusted.get(`${name}\n${variable}`)
      out.push('-c', `filter.${name}.${variable}=${own ?? (variable === 'required' ? 'false' : '')}`)
    }
  }
  return out
}
