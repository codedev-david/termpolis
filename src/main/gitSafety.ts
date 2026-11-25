// Git safety: what keeps a repository's own configuration from running a program when Termpolis only reads it.
//
// A folder can arrive WITH its `.git` folder (an extracted archive, a shared or network folder, a USB copy), and
// everything in that `.git` is the folder author's: its config (and every file that config includes), its hooks, its
// `info/attributes`, and the committed `.gitattributes`. Several of those settings name a program git runs on its
// own, and plain read commands reach them:
//
//   core.fsmonitor              status, diff, diff-tree, ls-files
//   filter.<x>.clean / process  status, diff, blame, hash-object, describe --dirty (a working-tree file is hashed
//     / smudge                  through its clean filter); cat-file --filters and archive (blobs go through smudge)
//   post-index-change hook      status, diff (status refreshes and rewrites the index)
//   diff.external, diff.<x>.command, diff.<x>.textconv   diff, show, log -p; textconv also blame (on by default),
//     grep --textconv, cat-file --textconv
//   log.showSignature, format.pretty with %G, + gpg.program   log, show
//   a submodule's own config    status and diff ask each submodule for its dirty state with a child git
//   diff.submodule=diff         diff, show, log -p run a child diff in each changed submodule, under ITS diff.external
//   a partial clone's promisor  any read that needs a missing object (diff, show, log -p, blame, cat-file, …) starts
//     remote: core.sshCommand,  `git fetch` from the promisor remote, and the fetch runs the program the repository
//     remote.<x>.uploadpack,    names for its transport (and allows that transport back on with protocol.*.allow)
//     core.gitProxy
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
//   config, whose filter names nobody here has scanned; gitSubmodules.ts asks each submodule itself instead). blame,
//   annotate and grep carry --no-textconv, and diff-files and diff-index --ignore-submodules=dirty. A read that asks
//   for --textconv or --ext-diff itself is refused, and so is describe --dirty or --broken (no way to keep it out of
//   the submodules).
// - A read in FILTER_SUBCOMMANDS can run a filter, and `-c filter.<x>.clean=` needs the driver's name. So the
//   repository's filter drivers are read first (filterScanArgs: `git config`, which reads config and runs nothing), and every
//   driver the repository's own config defines (scope local or worktree, includes counted as the file that includes
//   them) is set back to the person's own value for it, or to none (filterOverrides). A global driver such as
//   git-lfs's keeps working: only the repository's definitions are replaced.
// - Every read also carries noTransportFlags (protocol.allow=never, and never for each transport by name, so a
//   repository's own protocol.<x>.allow=always loses) and guardGitEnv's GIT_NO_LAZY_FETCH=1: the variable stops the
//   lazy fetch on git 2.44 and later, and the flags stop it on any git, since the fetch cannot open a transport.
//   A read of a missing object then fails, as it would offline, and runs nothing.
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

/** Read subcommands that can run a filter driver, or that may in some form (blame of the working tree, hash-object
 *  of a path, cat-file --filters, archive's smudge, describe --dirty, ls-files --eol, grep, show and log): they need
 *  the repository's filter drivers read first, and guardGitArgs refuses one handed no overrides. The scan is cached
 *  per repository (gitCommand.ts), so scanning a form that turns out not to run a filter costs next to nothing. */
export const FILTER_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status', 'diff', 'diff-files', 'diff-index', 'blame', 'annotate', 'hash-object', 'cat-file', 'archive', 'describe',
  'ls-files', 'grep', 'show', 'log', 'whatchanged'
])

/** Options a read may never ask for: each runs a program the repository's config names (diff.<x>.textconv,
 *  diff.external). */
const REFUSED_READ_OPTIONS = ['--textconv', '--ext-diff']

/** The refused option among `options` (those before `--`) for subcommand `sub`, or undefined. describe --dirty and
 *  --broken ask each submodule for its dirty state with a child git, which reads the submodule's own config (and its
 *  filter), and describe has no --ignore-submodules to stop it. */
function refusedOption(sub: string, options: readonly string[]): string | undefined {
  const asked = REFUSED_READ_OPTIONS.find((o) => options.includes(o))
  if (asked !== undefined || sub !== 'describe') return asked
  return options.find((o) => /^--(dirty|broken)(=|$)/.test(o))
}

/** Thrown when a read asks for an option that would run a program the repository names. The read is not run. */
export class UnsafeReadError extends Error {
  constructor(option: string) {
    super(`git: a read may not ask for ${option}, which runs a program the repository names; not run`)
    this.name = 'UnsafeReadError'
  }
}

/** Every transport git knows by name. A read sets each to never, so the repository's own protocol.<x>.allow cannot
 *  turn one back on (the per-transport key wins over protocol.allow, and the command line wins over the repository). */
const TRANSPORTS = ['ext', 'file', 'ssh', 'git', 'http', 'https', 'ftp', 'ftps']

/** No transport at all for a read: a partial clone's lazy fetch, on a git too old for GIT_NO_LAZY_FETCH, fails before
 *  it starts core.sshCommand, remote.<x>.uploadpack or core.gitProxy. */
export function noTransportFlags(): string[] {
  return ['-c', 'protocol.allow=never', ...TRANSPORTS.flatMap((p) => ['-c', `protocol.${p}.allow=never`])]
}

/** The read-only prefix for `sub`: no fsmonitor program, no hooks (except for rev-parse, see the header), no
 *  signature check, git's own default log format (a repository's format.pretty can ask for %G, which runs gpg), and
 *  no transport (noTransportFlags). */
export function readOnlyPrefix(sub: string, isWindows: boolean): string[] {
  return [
    '-c', 'core.fsmonitor=false',
    ...(sub === 'rev-parse' ? [] : ['-c', `core.hooksPath=${nullDevice(isWindows)}`]),
    '-c', 'log.showSignature=false',
    '-c', 'format.pretty=medium',
    ...noTransportFlags()
  ]
}

/** The environment variables a run of `args` adds to git's: for a read, GIT_NO_LAZY_FETCH=1 (git 2.44 and later
 *  never fetch a missing object from a partial clone's promisor remote); for a write, none. */
export function guardGitEnv(args: readonly string[]): Record<string, string> {
  const sub = gitSubcommand(args)
  return sub !== null && MUTATING_SUBCOMMANDS.has(sub.name) ? {} : { GIT_NO_LAZY_FETCH: '1' }
}

/** The inherited variables every automatic git leaves out of its environment, by upper-case name (one ending in `*` is
 *  a prefix): the guarded reads here (guardGitDropEnv) and Lumopolis's clone, update and helper check (world/gitLogin.ts
 *  inheritedEnv). A git the person starts keeps them all.
 *  - Another config: GIT_CONFIG makes `git config`, the filter scan, read only the file it names while status still
 *    reads the repository's own config, so the scan would miss a filter the read then runs. GIT_CONFIG_GLOBAL and
 *    GIT_CONFIG_SYSTEM swap in a file a parent process chose for the person's own, and the numbered or packed
 *    command-line config (GIT_CONFIG_COUNT, _KEY_n, _VALUE_n, GIT_CONFIG_PARAMETERS) is a parent git's. Without them git
 *    reads ~/.gitconfig and the system file, where it looks by default. GIT_CONFIG_NOSYSTEM stays: it only takes a
 *    file away.
 *  - Another repository: GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
 *    GIT_ALTERNATE_OBJECT_DIRECTORIES and GIT_NAMESPACE move a run off the folder it was asked about.
 *  - A program or a copy: GIT_SSH_COMMAND, GIT_SSH and GIT_PROXY_COMMAND name the program a transport starts,
 *    GIT_TEMPLATE_DIR copies files (hooks among them) into a new clone, and GIT_TRACE* and GIT_CURL_VERBOSE write what
 *    git does, request headers included, to a file or the error output. */
export const INHERITED_GIT_DROP: readonly string[] = Object.freeze([
  'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_*', 'GIT_CONFIG_VALUE_*',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
  'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_PROXY_COMMAND', 'GIT_TEMPLATE_DIR', 'GIT_TRACE*', 'GIT_CURL_VERBOSE'
])

/** `env` without the variables `drop` names (compared in upper case, since Windows names are; a name ending in `*` is
 *  a prefix) and without unset values, as a new object. */
export function withoutEnv(env: NodeJS.ProcessEnv, drop: readonly string[]): Record<string, string> {
  const exact = new Set<string>()
  const prefixes: string[] = []
  for (const d of drop) {
    const name = d.toUpperCase()
    if (name.endsWith('*')) prefixes.push(name.slice(0, -1))
    else exact.add(name)
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    const name = k.toUpperCase()
    if (exact.has(name) || prefixes.some((p) => name.startsWith(p))) continue
    out[k] = v
  }
  return out
}

/** The dropped variables a read may keep by name: the person's own global and system config files, which are where
 *  their core.hooksPath lives (HOLD-A M7). Nothing else is ever kept: the rest name a repository or run a program. */
export const KEEPABLE_GIT_ENV: ReadonlySet<string> = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'])

/** The inherited variables a run of `args` leaves out (procHost.ts ProcOptions.dropEnv): INHERITED_GIT_DROP for a
 *  read, none for a write, which runs in the environment the person's own git would. A read keeps the names in `keep`
 *  that KEEPABLE_GIT_ENV allows; any other name in it is still dropped. */
export function guardGitDropEnv(args: readonly string[], keep?: readonly string[]): readonly string[] {
  const sub = gitSubcommand(args)
  if (sub !== null && MUTATING_SUBCOMMANDS.has(sub.name)) return []
  const kept = (keep ?? []).filter((k) => KEEPABLE_GIT_ENV.has(k))
  return kept.length === 0 ? INHERITED_GIT_DROP : INHERITED_GIT_DROP.filter((d) => !kept.includes(d))
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
    case 'diff-files':
    case 'diff-index':
      return ['--ignore-submodules=dirty']
    case 'blame':
    case 'annotate':
    case 'grep':
      return ['--no-textconv']
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
 *
 * A read that can run a filter (FILTER_SUBCOMMANDS) must be handed the result of its scan, as runFilterScan made
 * it, even when that is empty: without one (or with any other list) it throws, so a new caller cannot run one
 * unscanned. A read asking for --textconv or --ext-diff throws UnsafeReadError.
 */
export function guardGitArgs(args: readonly string[], isWindows: boolean, filterOverrides?: FilterScan): string[] {
  const sub = gitSubcommand(args)
  if (sub === null) return [...readOnlyPrefix('', isWindows), ...args]
  if (MUTATING_SUBCOMMANDS.has(sub.name)) return [...args]
  if ((filterOverrides === undefined || !builtScans.has(filterOverrides)) && FILTER_SUBCOMMANDS.has(sub.name)) {
    throw new Error(`git: a ${sub.name} can run a filter driver, and was not handed the repository's filter scan (gitCommand.ts safeGitAsync)`)
  }
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
  const refused = refusedOption(sub.name, options)
  if (refused !== undefined) throw new UnsafeReadError(refused)
  const flags = displayFlags(sub.name).filter((f) => !options.includes(f))
  return [...leading, ...added, ...(filterOverrides ?? []), sub.name, ...flags, ...rest]
}

/** Global options that choose which repository git opens, and so whose config it reads. */
const REPO_GLOBALS = new Set(['-C', '--git-dir', '--work-tree'])

/** The command that lists every filter driver setting with the scope it comes from. Reading config runs nothing;
 *  it carries the read-only prefix all the same, and the options of the command it serves that choose the repository
 *  (`-C`, `--git-dir`, `--work-tree`, `--bare`), so it reads the config that command will run under. The caller's own
 *  `-c` settings are not repeated: they are the app's own, and the scan would only report them as trusted. */
export function filterScanArgs(args: readonly string[], isWindows: boolean): string[] {
  const sub = gitSubcommand(args)
  const leading = sub === null ? [] : args.slice(0, sub.index)
  const at: string[] = []
  for (let i = 0; i < leading.length; i++) {
    const a = leading[i]
    if (VALUED_GLOBALS.has(a)) {
      if (REPO_GLOBALS.has(a)) at.push(a, leading[i + 1])
      i++
    } else if (a === '--bare' || a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) at.push(a)
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

declare const filterScanBrand: unique symbol
/** What runFilterScan returns: the overrides from one real scan. guardGitArgs takes nothing else for a read that can
 *  run a filter, checked by type here and by identity at run time (builtScans), so a hand-made list, a copy, or
 *  filterOverrides' reading of any text never passes. */
export type FilterScan = readonly string[] & { readonly [filterScanBrand]: true }
const builtScans = new WeakSet<readonly string[]>()

/** Runs the scan filterScanArgs writes for one read and prints its output (gitCommand.ts repoFilterOverrides hands
 *  the guarded git). */
export type ScanRunner = (scanArgs: string[]) => Promise<string>

/**
 * The filter scan for `args`: runs filterScanArgs through `run`, and reads its output with filterOverrides. The only
 * maker of a FilterScan; in src/main it is called only by gitCommand.ts repoFilterOverrides (gitSafetyGuard.test.ts),
 * so the scan a read is handed is the scan git printed.
 */
export async function runFilterScan(args: readonly string[], isWindows: boolean, run: ScanRunner): Promise<FilterScan> {
  const out = filterOverrides(await run(filterScanArgs(args, isWindows)))
  builtScans.add(out)
  return out as FilterScan
}

/**
 * The `-c` options that switch off every filter driver the repository's own config defines, from the output of
 * filterScanArgs (`scope NUL key LF value NUL`, repeated). Each such driver gets its four settings back from the
 * person's own config (system, global, command line) or, where they have none, no program and `required=false`.
 * A driver name holding `=` cannot be written as a `-c` key (git splits at the first `=`), so it throws rather than
 * leave that driver running. Only a reading of the text it is handed: its result is no FilterScan (runFilterScan).
 */
export function filterOverrides(scan: string): readonly string[] {
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
  return Object.freeze(out)
}
