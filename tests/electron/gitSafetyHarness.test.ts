/**
 * The git-safety attack harness: real git, real repositories, real programs planted in them.
 *
 * Each vector plants a program the way a hostile repository would (its own .git/config, a file that config includes,
 * a worktree config, .git/info/attributes, .gitattributes, a hook, a submodule's own config, a signed commit). Every
 * planted program does one thing: it creates a marker file inside this test's temp folder (and a filter passes its
 * input through). Nothing else, no network.
 *
 * For each vector the automatic and display paths run first, through Termpolis's own functions (safeGitAsync and
 * cachedGit with the argument lists src/main writes, the commit scan, the label context, the CI lookup, the code-map
 * listing), and no marker may appear. Then plain git runs the same kind of command, as the positive control: the
 * marker must appear, so the vector is real on this OS and this git, and the first half proved something.
 *
 * Positive cases for the person's own setup: a global filter (git-lfs's shape) keeps status exactly as plain git
 * reports it, and a mutating `add` through safeGitAsync still runs the global clean filter.
 *
 * Runs on Windows, macOS and Linux CI. Planted programs are `#!/bin/sh` scripts on every OS (git for Windows runs them
 * through its own sh); on Windows a `.cmd` program is planted as well.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { safeGitAsync, _resetGitBinForTests } from '../../src/main/gitCommand'
import { cachedGit } from '../../src/main/gitCache'
import { filterScanArgs } from '../../src/main/gitSafety'
import { scanPushRange, scanStagedDiff } from '../../src/main/commitScan'
import { createLabelContext } from '../../src/main/world/labelContext'
import { createWorldRuns } from '../../src/main/world/worldRuns'
import { gitListFiles } from '../../src/main/world/fileSnapshot'
import { runExec } from '../../src/main/procHost'
import { resolveGitBin } from '../../src/main/binPath'

const isWindows = process.platform === 'win32'
/** Generous: a Windows runner starts each git in ~100-300 ms, and the unit job runs other files beside this one. */
const TIMEOUT = 300_000

let base = ''
let markers = ''
let progs = ''
let globalConfig = ''
let gitBin = ''
const savedEnv: Record<string, string | undefined> = {}

/** Forward slashes: git's sh reads `C:/…` on Windows, and every other OS already writes paths this way. */
const slash = (p: string): string => p.replace(/\\/g, '/')

/** Plain git, for setting up and for the positive controls. Never through Termpolis's code. */
function git(cwd: string, args: string[], allowFail = false): string {
  const r = spawnSync(gitBin, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  if (!allowFail && r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`)
  return r.stdout ?? ''
}

/** A program that creates `markers/<name>`. `body` is what it does after that (a filter passes its input on). */
function plantProgram(name: string, body = ''): string {
  const file = join(progs, `${name}.sh`)
  writeFileSync(file, `#!/bin/sh\n: > '${slash(join(markers, name))}'\n${body}`, { mode: 0o755 })
  chmodSync(file, 0o755)
  return file
}
/** The same as a Windows batch file. */
function plantCmd(name: string): string {
  const file = join(progs, `${name}.cmd`)
  writeFileSync(file, `@echo off\r\ntype nul > "${join(markers, name)}"\r\n`)
  return file
}
/** A config value that runs `file` (quoted: the temp folder may hold spaces). */
const runs = (file: string): string => `'${slash(file)}'`

const fired = (): string[] => readdirSync(markers).sort()
const clearMarkers = (): void => { for (const f of readdirSync(markers)) rmSync(join(markers, f), { force: true }) }

/** Copies the folder `from` to `to` (made, parents too) one entry at a time. A git folder holds only folders and files. */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyTree(join(from, e.name), join(to, e.name))
    else if (e.isFile()) copyFileSync(join(from, e.name), join(to, e.name))
    else throw new Error(`copyTree: ${join(from, e.name)} is neither a folder nor a file`)
  }
}

/** A repository with one commit holding a.txt (and whatever `files` adds), on branch main. */
/** Whether `dir`'s file system keeps a folder name that ends in a space, with a file inside it, exactly as given. */
function holdsTrailingSpace(dir: string): boolean {
  const probe = join(dir, 'probe ')
  try {
    mkdirSync(probe)
    writeFileSync(join(probe, 'f'), '')
    return readdirSync(dir).includes('probe ') && readdirSync(probe).includes('f')
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
    rmSync(join(dir, 'probe'), { recursive: true, force: true })
  }
}

function newRepo(name: string, files: Record<string, string> = {}): string {
  const dir = join(base, name)
  // A retried case starts from an empty folder, or its commit finds nothing to commit and hides the first error.
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'a.txt'), 'alpha\nbeta\n')
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'first'])
  return dir
}

let tick = 0
/** Rewrites `file` with different bytes of the same size and a new mtime, so git has to read it (through any filter)
 *  to know whether it changed. */
function dirty(dir: string, file: string, text: string): void {
  const p = join(dir, file)
  writeFileSync(p, text)
  const t = new Date(Date.now() - 3_600_000 + ++tick * 1000)
  utimesSync(p, t, t)
}

const opts = (cwd: string) => ({ cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
const quiet = async (p: Promise<unknown>): Promise<void> => { try { await p } catch { /* a refused read is fine; a marker is not */ } }

/** How one display path ended: what it handed back, or what it was refused with (the message and git's own stderr). */
type Outcome = { ok: true; out: unknown } | { ok: false; error: string }
const settle = async (p: Promise<unknown>): Promise<Outcome> => {
  try {
    return { ok: true, out: await p }
  } catch (e) {
    const err = e as { message?: unknown; stderr?: unknown } | null
    return { ok: false, error: `${String(err?.message ?? e)} ${String(err?.stderr ?? '')}` }
  }
}

/** Every automatic and display path, with the argument lists src/main writes, run against `dir`, and how each ended,
 *  by its argument list (HEAD's id written `<sha>`) or its name. */
async function driveDisplayPaths(dir: string, file: string): Promise<Record<string, Outcome>> {
  _resetGitBinForTests()
  const got: Record<string, Outcome> = {}
  const o = opts(dir)
  const sha = git(dir, ['rev-parse', 'HEAD']).trim()
  // One of each kind of read src/main writes (gitSafetyGuard.test.ts checks every literal one goes through the same
  // builder). rev-parse reads no index and runs no diff, so one stands for all of them.
  const reads: string[][] = [
    // The git dot and the change rail (git:status, git:change-counts), the status bar and MCP get_git_status.
    ['status', '--porcelain', '-b', '-z'], ['diff', '--numstat', '-z'], ['diff', '--cached', '--numstat', '-z'],
    // The diff panes (git:diff, git:change-diff, git:commit-diff, the swarm review).
    ['diff', '--', file], ['diff', '--cached', '--', file], ['show', '--format=', '--patch', '--no-color', sha],
    ['diff', '--no-color', '--no-ext-diff', `${sha}~0`], ['diff', '--name-status', sha],
    // The world's head, the context panel, unpushed commits, a log with patches.
    ['status', '--porcelain', '--untracked-files=no'], ['log', '--oneline', '-5'], ['rev-parse', '--git-path', 'hooks'],
    ['log', '--max-count=50', '--format=%H%x00%s', '@{upstream}..HEAD'], ['log', '-p', '-1'],
    // Reads no panel writes today, but which can run a filter or a textconv in some form: blame of the working tree
    // (textconv on by default), hash-object of a path, cat-file --filters and archive (smudge), describe --dirty and
    // diff-files (refresh), ls-files --eol, grep. Each must be scanned and stay quiet; a --textconv ask is refused.
    ['blame', '--porcelain', '--', file], ['annotate', file], ['hash-object', '--', file], ['cat-file', '--filters', `HEAD:${file}`],
    ['archive', '--format=tar', 'HEAD'], ['describe', '--dirty', '--always'], ['diff-files'], ['diff-index', 'HEAD'],
    ['ls-files', '--eol'], ['grep', '-n', 'e'], ['cat-file', '--textconv', `HEAD:${file}`], ['grep', '--textconv', 'e']
  ]
  await Promise.all(reads.map(async (args) => { got[args.join(' ').replace(sha, '<sha>')] = await settle(safeGitAsync(args, o)) }))
  got['cachedGit status --porcelain'] = await settle(cachedGit(['status', '--porcelain'], o))
  // The commit and push gates read the staged patch and the unpushed log -p.
  // The world's label context reads the log of a group's files.
  const [staged, push, label] = await Promise.all([
    settle(scanStagedDiff({ git: (a) => safeGitAsync(a, o) })),
    settle(scanPushRange({ git: (a) => safeGitAsync(a, o) })),
    settle(createLabelContext({ git: (a, cwd) => safeGitAsync(a, opts(cwd)), memory: async () => [] })(dir, [file, 'a.txt']))
  ])
  Object.assign(got, { 'commit scan': staged, 'push scan': push, 'label context': label })
  // The CI lookup: remote, branch, then diff-tree of the judged commit (gh is faked: it only names the run). A GitHub
  // remote is added first, by plain `git config`, which runs nothing; without one the lookup stops at `remote -v`.
  git(dir, ['config', 'remote.tp-ci.url', 'https://github.com/example/fixture'])
  const gh = join(progs, 'gh-not-run')
  const ciGitErrors: string[] = []
  const ci = createWorldRuns({
    listTranscripts: async () => [], transcriptsAllowed: () => false, ciAllowed: async () => true,
    ghOnPath: async () => gh, gitBin: async () => gitBin, realpath: async (p) => p, now: () => Date.now(),
    exec: async (bin, args, eo) => {
      if (bin === gh) return { stdout: JSON.stringify([{ headSha: sha, workflowName: 'Tests', conclusion: 'success', createdAt: new Date().toISOString() }]) }
      // The harness's own time limit, not the app's 5 s: every vector runs at once here, and what is under test is
      // what git runs, not how fast a loaded machine starts it. Each git the lookup runs must succeed.
      const r = await runExec(bin, args, { ...eo, timeout: 30_000 })
      if (r.error) ciGitErrors.push(`${args.slice(-4).join(' ')}: ${String((r.error as { message?: unknown }).message ?? r.error)}`)
      return { stdout: r.stdout, ...(r.error ? { error: r.error } : {}) }
    }
  })
  got['CI lookup'] = await settle(ci.ciRuns(dir))
  got['CI lookup git'] = ciGitErrors.length === 0 ? { ok: true, out: null } : { ok: false, error: ciGitErrors.join('\n') }
  // The code map's listing (repoFileList.ts builders).
  got['code map listing'] = await settle(gitListFiles(dir))
  return got
}

/** The reads every vector's repository refuses, and with what: no upstream is set, and a --textconv or --dirty ask is
 *  never run (describe --dirty refreshes the index, which can run a filter and the post-index-change hook). */
const ALWAYS_REFUSED = (file: string): Record<string, RegExp> => ({
  'log --max-count=50 --format=%H%x00%s @{upstream}..HEAD': /no upstream configured/i,
  [`cat-file --textconv HEAD:${file}`]: /a read may not ask for --textconv/,
  'grep --textconv e': /a read may not ask for --textconv/,
  'describe --dirty --always': /a read may not ask for --dirty/
})

/** Each display path did its job: a refusal only where one is expected, with that refusal's own message, and the
 *  answers the panels show carry what this repository holds. A path that broke fails here, not just one that ran
 *  something. */
function expectDisplayPaths(v: Vector, got: Record<string, Outcome>, file: string): void {
  const refused = { ...ALWAYS_REFUSED(file), ...v.refuses?.(file) }
  for (const [label, outcome] of Object.entries(got)) {
    const want = refused[label]
    if (want === undefined) expect(outcome, label).toMatchObject({ ok: true })
    else expect(outcome.ok ? `ran: ${String(outcome.out).slice(0, 200)}` : outcome.error, label).toMatch(want)
  }
  for (const label of Object.keys(refused)) expect(got, `${label} was run`).toHaveProperty([label])
  const out = (label: string): unknown => { const o = got[label]; return o.ok ? o.out : undefined }
  if (!(('status --porcelain -b -z') in refused)) expect(out('status --porcelain -b -z')).toMatch(/^## main(\u0000|$)/)
  if (!(('log --oneline -5') in refused)) expect(out('log --oneline -5')).toMatch(/^[0-9a-f]{7,} /)
  expect(String(out('rev-parse --git-path hooks')).trim()).toMatch(/hooks$/)
  // The faked run passed on HEAD, so every file HEAD changed comes back as passed, from CI.
  const ci = out('CI lookup') as Array<{ source?: unknown; passed?: unknown; file?: unknown }>
  expect(ci.length, 'CI lookup found HEAD\'s files').toBeGreaterThan(0)
  for (const run of ci) expect(run).toEqual(expect.objectContaining({ source: 'ci', passed: true, file: expect.any(String) }))
  expect((out('code map listing') as { files?: string[] } | null)?.files).toContain('a.txt')
}

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'tp-gitsafety-')))
  markers = join(base, 'markers')
  progs = join(base, 'programs')
  mkdirSync(markers)
  mkdirSync(progs)
  // The person's own config, for the whole run: a global file this test writes, and no system file (git for Windows
  // ships git-lfs's filter there), so what counts as "trusted" is exactly what the test says. It is the ~/.gitconfig
  // of a temporary home, where git looks by default: Termpolis's reads leave an inherited GIT_CONFIG_GLOBAL out
  // (gitSafety.ts INHERITED_GIT_DROP). GIT_CONFIG_GLOBAL names the same file for this test's own plain git.
  const home = join(base, 'home')
  mkdirSync(join(home, 'xdg'), { recursive: true })
  globalConfig = join(home, '.gitconfig')
  writeFileSync(globalConfig, '[user]\n\tname = Harness\n\temail = harness@example.invalid\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n')
  for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'HOME', 'XDG_CONFIG_HOME']) savedEnv[k] = process.env[k]
  process.env.GIT_CONFIG_GLOBAL = globalConfig
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = join(home, 'xdg')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[k]
})

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  _resetGitBinForTests()
  if (base) rmSync(base, { recursive: true, force: true })
})

beforeAll(async () => {
  const bin = await resolveGitBin()
  if (bin === null) throw new Error('the harness needs git installed')
  gitBin = bin
})

interface Vector {
  name: string
  /** Builds the repository with the program planted; returns it and the file the display paths look at. */
  plant: () => { dir: string; file: string; redirty: () => void }
  /** The plain git command that must run the program (positive control). */
  control: (dir: string, file: string) => void
  /** The markers the control must create. */
  expect: string[]
  only?: 'win32'
  /** Display paths this repository refuses beyond ALWAYS_REFUSED, by label, and the error each must give. */
  refuses?: (file: string) => Record<string, RegExp>
}

const VECTORS: Vector[] = [
  {
    name: 'core.fsmonitor in .git/config',
    plant: () => {
      const dir = newRepo('fsmonitor')
      git(dir, ['config', 'core.fsmonitor', runs(plantProgram('fsmonitor'))])
      return { dir, file: 'a.txt', redirty: () => dirty(dir, 'a.txt', 'alpha\nbetb\n') }
    },
    control: (dir) => git(dir, ['status', '--porcelain'], true),
    expect: ['fsmonitor']
  },
  {
    name: 'filter clean via .gitattributes',
    plant: () => {
      const dir = newRepo('clean', { '.gitattributes': '*.dat filter=evil\n', 'x.dat': 'one\n' })
      git(dir, ['config', 'filter.evil.clean', runs(plantProgram('clean', 'cat\n'))])
      git(dir, ['config', 'filter.evil.required', 'true'])
      return { dir, file: 'x.dat', redirty: () => dirty(dir, 'x.dat', 'two\n') }
    },
    control: (dir) => git(dir, ['status', '--porcelain'], true),
    expect: ['clean']
  },
  {
    name: 'filter process via .gitattributes',
    plant: () => {
      const dir = newRepo('process', { '.gitattributes': '*.dat filter=evilp\n', 'x.dat': 'one\n' })
      git(dir, ['config', 'filter.evilp.process', runs(plantProgram('process'))])
      return { dir, file: 'x.dat', redirty: () => dirty(dir, 'x.dat', 'two\n') }
    },
    control: (dir) => git(dir, ['diff', '--numstat'], true),
    expect: ['process']
  },
  {
    name: 'post-index-change hook',
    plant: () => {
      const dir = newRepo('hook')
      const hook = join(dir, '.git', 'hooks', 'post-index-change')
      writeFileSync(hook, `#!/bin/sh\n: > '${slash(join(markers, 'hook'))}'\n`, { mode: 0o755 })
      chmodSync(hook, 0o755)
      // Same bytes, new mtime: the refresh can update the entry, so status writes the index, and that runs the hook.
      return { dir, file: 'a.txt', redirty: () => dirty(dir, 'a.txt', 'alpha\nbeta\n') }
    },
    control: (dir) => git(dir, ['status', '--porcelain'], true),
    expect: ['hook']
  },
  {
    name: 'diff.external',
    plant: () => {
      const dir = newRepo('external')
      git(dir, ['config', 'diff.external', runs(plantProgram('external'))])
      return { dir, file: 'a.txt', redirty: () => dirty(dir, 'a.txt', 'alpha\nbetb\n') }
    },
    control: (dir) => git(dir, ['diff', '--', 'a.txt'], true),
    expect: ['external']
  },
  {
    name: 'diff.external as a .cmd program',
    only: 'win32',
    plant: () => {
      const dir = newRepo('external-cmd')
      git(dir, ['config', 'diff.external', runs(plantCmd('external-cmd'))])
      return { dir, file: 'a.txt', redirty: () => dirty(dir, 'a.txt', 'alpha\nbetb\n') }
    },
    control: (dir) => git(dir, ['diff', '--', 'a.txt'], true),
    expect: ['external-cmd']
  },
  {
    name: 'diff.<driver>.command via .gitattributes',
    plant: () => {
      const dir = newRepo('diffcmd', { '.gitattributes': '*.txt diff=evild\n' })
      git(dir, ['config', 'diff.evild.command', runs(plantProgram('diffcmd'))])
      return { dir, file: 'a.txt', redirty: () => dirty(dir, 'a.txt', 'alpha\nbetb\n') }
    },
    control: (dir) => git(dir, ['diff', '--', 'a.txt'], true),
    expect: ['diffcmd']
  },
  {
    name: 'textconv via .gitattributes, in log -p and show as well',
    plant: () => {
      const dir = newRepo('textconv', { '.gitattributes': '*.tc diff=evilt\n', 'x.tc': 'one\n' })
      git(dir, ['config', 'diff.evilt.textconv', runs(plantProgram('textconv', 'cat "$1"\n'))])
      writeFileSync(join(dir, 'x.tc'), 'one\ntwo\n')
      git(dir, ['commit', '-q', '-am', 'second'])
      return { dir, file: 'x.tc', redirty: () => dirty(dir, 'x.tc', 'one\ntwp\n') }
    },
    control: (dir) => git(dir, ['show', 'HEAD'], true),
    expect: ['textconv']
  },
  {
    name: 'blame of the working tree through textconv (on by default in blame)',
    plant: () => {
      const dir = newRepo('blametc', { '.gitattributes': '*.tc diff=evilb\n', 'x.tc': 'one\n' })
      git(dir, ['config', 'diff.evilb.textconv', runs(plantProgram('blametc', 'cat "$1"\n'))])
      return { dir, file: 'x.tc', redirty: () => dirty(dir, 'x.tc', 'one\ntwo\n') }
    },
    control: (dir) => git(dir, ['blame', '--', 'x.tc'], true),
    expect: ['blametc']
  },
  {
    name: 'filter smudge: cat-file --filters and archive put a blob through it',
    plant: () => {
      const dir = newRepo('smudge', { 'x.sm': 'one\n' })
      writeFileSync(join(dir, '.gitattributes'), '*.sm filter=evils\n')
      git(dir, ['add', '.gitattributes'])
      git(dir, ['commit', '-q', '-m', 'attributes'])
      git(dir, ['config', 'filter.evils.smudge', runs(plantProgram('smudge', 'cat\n'))])
      return { dir, file: 'x.sm', redirty: () => dirty(dir, 'x.sm', 'two\n') }
    },
    control: (dir) => git(dir, ['cat-file', '--filters', 'HEAD:x.sm'], true),
    expect: ['smudge']
  },
  {
    name: 'log.showSignature with gpg.program, on a signed commit',
    plant: () => {
      const dir = newRepo('signature')
      git(dir, ['config', 'log.showSignature', 'true'])
      // gpg.program is started directly, not through sh: the path as it is, no quotes.
      git(dir, ['config', 'gpg.program', slash(plantProgram('gpg'))])
      signHead(dir)
      return { dir, file: 'a.txt', redirty: () => dirty(dir, 'a.txt', 'alpha\nbetb\n') }
    },
    control: (dir) => git(dir, ['log', '-1'], true),
    expect: ['gpg']
  },
  {
    name: 'format.pretty with %G? and gpg.program (missed by the sweep)',
    plant: () => {
      const dir = newRepo('pretty')
      git(dir, ['config', 'format.pretty', 'format:%h %G?'])
      git(dir, ['config', 'gpg.program', slash(plantProgram('pretty-gpg'))])
      signHead(dir)
      return { dir, file: 'a.txt', redirty: () => dirty(dir, 'a.txt', 'alpha\nbetb\n') }
    },
    control: (dir) => git(dir, ['show', '--patch', 'HEAD'], true),
    expect: ['pretty-gpg']
  },
  {
    name: 'include.path: a file the repository config pulls in',
    plant: () => {
      const dir = newRepo('include', { '.gitattributes': '*.dat filter=inc\n', 'x.dat': 'one\n' })
      const inc = join(dir, '.git', 'evil.inc')
      writeFileSync(inc, `[core]\n\tfsmonitor = ${runs(plantProgram('include-fsmonitor'))}\n[filter "inc"]\n\tclean = ${runs(plantProgram('include-clean', 'cat\n'))}\n\trequired = true\n`)
      git(dir, ['config', 'include.path', 'evil.inc'])
      return { dir, file: 'x.dat', redirty: () => dirty(dir, 'x.dat', 'two\n') }
    },
    control: (dir) => git(dir, ['status', '--porcelain'], true),
    expect: ['include-clean', 'include-fsmonitor']
  },
  {
    name: '.git/info/attributes naming a repository filter',
    plant: () => {
      const dir = newRepo('infoattr', { 'x.dat': 'one\n' })
      mkdirSync(join(dir, '.git', 'info'), { recursive: true })
      writeFileSync(join(dir, '.git', 'info', 'attributes'), '*.dat filter=infof\n')
      git(dir, ['config', 'filter.infof.clean', runs(plantProgram('info-clean', 'cat\n'))])
      return { dir, file: 'x.dat', redirty: () => dirty(dir, 'x.dat', 'two\n') }
    },
    control: (dir) => git(dir, ['status', '--porcelain'], true),
    expect: ['info-clean']
  },
  {
    name: 'config.worktree (extensions.worktreeConfig)',
    plant: () => {
      const dir = newRepo('wtconfig', { '.gitattributes': '*.dat filter=wt\n', 'x.dat': 'one\n' })
      git(dir, ['config', 'extensions.worktreeConfig', 'true'])
      git(dir, ['config', '--worktree', 'filter.wt.clean', runs(plantProgram('worktree-clean', 'cat\n'))])
      return { dir, file: 'x.dat', redirty: () => dirty(dir, 'x.dat', 'two\n') }
    },
    control: (dir) => git(dir, ['status', '--porcelain'], true),
    expect: ['worktree-clean']
  },
  {
    name: "a submodule's own config filter, from the superproject (missed by the sweep)",
    plant: () => {
      const dir = newRepo('super')
      const sub = join(dir, 'sub')
      mkdirSync(sub)
      git(sub, ['init', '-q', '-b', 'main'])
      writeFileSync(join(sub, '.gitattributes'), '*.dat filter=subf\n')
      writeFileSync(join(sub, 'x.dat'), 'one\n')
      git(sub, ['add', '-A'])
      git(sub, ['commit', '-q', '-m', 'sub'])
      git(sub, ['config', 'filter.subf.clean', runs(plantProgram('submodule-clean', 'cat\n'))])
      git(sub, ['config', 'filter.subf.required', 'true'])
      // Listed in .gitmodules, as a cloned submodule is: the status of a superproject now looks into each one itself,
      // through the guarded runner, which scans the submodule's own filters first (gitSubmodules.ts).
      writeFileSync(join(dir, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n')
      git(dir, ['add', 'sub', '.gitmodules'])
      git(dir, ['commit', '-q', '-m', 'gitlink'])
      return { dir, file: 'a.txt', redirty: () => dirty(sub, 'x.dat', 'two\n') }
    },
    control: (dir) => git(dir, ['status', '--porcelain'], true),
    expect: ['submodule-clean']
  },
  {
    name: "diff.submodule=diff reaching a submodule's own diff.external (missed by the sweep)",
    plant: () => {
      const dir = newRepo('subdiff')
      const sub = join(dir, 'sub')
      mkdirSync(sub)
      git(sub, ['init', '-q', '-b', 'main'])
      writeFileSync(join(sub, 's.txt'), 'one\n')
      git(sub, ['add', '-A'])
      git(sub, ['commit', '-q', '-m', 's1'])
      git(dir, ['add', 'sub'])
      git(dir, ['commit', '-q', '-m', 'gitlink'])
      // The submodule moves on, so the superproject's diff has a submodule change to show inline.
      writeFileSync(join(sub, 's.txt'), 'two\n')
      git(sub, ['commit', '-q', '-am', 's2'])
      git(sub, ['config', 'diff.external', runs(plantProgram('subdiff-external'))])
      git(dir, ['config', 'diff.submodule', 'diff'])
      // `--no-ext-diff` on the superproject does not reach the inner diff git starts in the submodule (measured).
      return { dir, file: 'sub', redirty: () => undefined }
    },
    control: (dir) => git(dir, ['diff', '--no-ext-diff', '--no-textconv'], true),
    expect: ['subdiff-external'],
    // The file looked at is a gitlink, not a file: git itself has no blob to blame, hash or put through a filter.
    refuses: () => ({
      'annotate sub': /fatal: unsupported file type sub/,
      'blame --porcelain -- sub': /fatal: unsupported file type sub/,
      'hash-object -- sub': /fatal: Unable to hash sub/,
      'cat-file --filters HEAD:sub': /cannot read object [0-9a-f]{40} 'sub'/
    })
  },
  {
    name: 'partial clone: a missing object fetched through core.sshCommand, the repository allowing ssh back on',
    plant: () => partialClone('lazy-ssh', (dir) => {
      git(dir, ['config', 'remote.origin.url', 'ssh://planted.invalid/x'])
      git(dir, ['config', 'core.sshCommand', runs(plantProgram('lazy-ssh'))])
      git(dir, ['config', 'protocol.ssh.allow', 'always'])
    }),
    // status alone: its rename detection reads the blob of the staged rename's source, which is missing.
    control: (dir) => git(dir, ['status', '--porcelain'], true),
    expect: ['lazy-ssh'],
    refuses: partialCloneRefuses
  },
  {
    name: 'partial clone: a missing object fetched through remote.<name>.uploadpack, the repository allowing file back on',
    plant: () => partialClone('lazy-uploadpack', (dir) => {
      git(dir, ['config', 'remote.origin.url', `file://${slash(join(base, 'nowhere'))}`])
      git(dir, ['config', 'remote.origin.uploadpack', runs(plantProgram('lazy-uploadpack'))])
      git(dir, ['config', 'protocol.file.allow', 'always'])
    }),
    // status alone: its rename detection reads the blob of the staged rename's source, which is missing.
    control: (dir) => git(dir, ['status', '--porcelain'], true),
    expect: ['lazy-uploadpack'],
    refuses: partialCloneRefuses
  },
  {
    name: 'partial clone: a missing object fetched through core.gitProxy, the repository allowing every protocol back on',
    plant: () => partialClone('lazy-gitproxy', (dir) => {
      git(dir, ['config', 'remote.origin.url', 'git://planted.invalid/x'])
      // core.gitProxy is started directly, not through sh: the path as it is, no quotes.
      git(dir, ['config', 'core.gitProxy', slash(plantProgram('lazy-gitproxy'))])
      git(dir, ['config', 'protocol.allow', 'always'])
      git(dir, ['config', 'protocol.git.allow', 'always'])
    }),
    // status alone: its rename detection reads the blob of the staged rename's source, which is missing.
    control: (dir) => git(dir, ['status', '--porcelain'], true),
    expect: ['lazy-gitproxy'],
    refuses: partialCloneRefuses
  }
]

/** What a partial clone's missing blobs refuse, by display path: the guarded run turns lazy fetching off, so a read
 *  that needs a missing blob fails on it (git says so) instead of fetching it through the planted program. Reads that
 *  need no missing blob (log --oneline, ls-files, diff-files, grep of the worktree, the scans' log) still answer. */
function partialCloneRefuses(): Record<string, RegExp> {
  const lazyOff = /lazy fetching disabled; some objects may not be available[\s\S]*fatal: unable to read [0-9a-f]{40}/
  return {
    'status --porcelain -b -z': lazyOff,
    'status --porcelain --untracked-files=no': lazyOff,
    'cachedGit status --porcelain': lazyOff,
    'diff --cached --numstat -z': lazyOff,
    'diff --cached -- a.txt': lazyOff,
    'diff --name-status <sha>': lazyOff,
    'diff --no-color --no-ext-diff <sha>~0': lazyOff,
    'show --format= --patch --no-color <sha>': lazyOff,
    'log -p -1': lazyOff,
    'commit scan': lazyOff,
    'annotate a.txt': /fatal: Cannot read blob [0-9a-f]{40} for path a\.txt/,
    'blame --porcelain -- a.txt': /fatal: Cannot read blob [0-9a-f]{40} for path a\.txt/,
    'cat-file --filters HEAD:a.txt': /cannot read object [0-9a-f]{40} 'a\.txt'/,
    'archive --format=tar HEAD': /invalid object 100644 [0-9a-f]{40} for 'a\.txt'/
  }
}

/**
 * A partial clone (as `git clone --filter=blob:none` leaves one) whose promisor remote is reached through a program
 * the repository's own config names, with the blobs of HEAD's and HEAD~1's a.txt missing: a read that needs either
 * starts `git fetch` from that remote, and the fetch runs the program. a.txt is staged and changed again on top. b.txt
 * is staged as renamed, with edits, to c.txt, and its blob is missing too: a plain status reads it to find the rename.
 */
function partialClone(name: string, configure: (dir: string) => void): { dir: string; file: string; redirty: () => void } {
  const dir = newRepo(name, { 'b.txt': 'one\ntwo\nthree\nfour\nfive\nsix\n' })
  writeFileSync(join(dir, 'a.txt'), 'alpha\nbeta\ngamma\n')
  git(dir, ['commit', '-q', '-am', 'second'])
  writeFileSync(join(dir, 'a.txt'), 'alpha\nBETA\ngamma\ndelta\n')
  git(dir, ['add', 'a.txt'])
  writeFileSync(join(dir, 'a.txt'), 'alpha\nBETA\ngamma\ndelta\nepsilon\n')
  git(dir, ['rm', '-q', 'b.txt'])
  writeFileSync(join(dir, 'c.txt'), 'one\ntwo\nthree\nfour\nfive\nSIX\n')
  git(dir, ['add', 'c.txt'])
  for (const rev of ['HEAD~1:a.txt', 'HEAD:a.txt', 'HEAD:b.txt']) {
    const oid = git(dir, ['rev-parse', rev]).trim()
    const file = join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2))
    // git writes loose objects read-only, and Windows will not unlink a read-only file.
    chmodSync(file, 0o644)
    rmSync(file)
  }
  git(dir, ['config', 'core.repositoryformatversion', '1'])
  git(dir, ['config', 'extensions.partialClone', 'origin'])
  git(dir, ['config', 'remote.origin.promisor', 'true'])
  git(dir, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
  configure(dir)
  return { dir, file: 'a.txt', redirty: () => undefined }
}

/** Rewrites HEAD as a commit carrying a (fake) PGP signature, so log/show ask gpg.program to verify it. */
function signHead(dir: string): void {
  const raw = git(dir, ['cat-file', 'commit', 'HEAD'])
  const at = raw.indexOf('\n\n')
  const sig = 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n =AAAA\n -----END PGP SIGNATURE-----'
  const signed = `${raw.slice(0, at)}\n${sig}${raw.slice(at)}`
  const sha = execFileSync(gitBin, ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: dir, input: signed, encoding: 'utf8', windowsHide: true }).trim()
  git(dir, ['update-ref', 'HEAD', sha])
}

// Concurrent: each vector has its own repository and its own marker names (every program a vector plants is in its
// `expect`), so one vector's reads cannot fire, or clear, another's markers.
describe.concurrent('git safety harness: a planted program never runs on an automatic or display read', () => {
  for (const v of VECTORS) {
    const run = v.only === undefined || v.only === process.platform ? it : it.skip
    run(v.name, async () => {
      const mine = (): string[] => fired().filter((f) => v.expect.includes(f))
      const { dir, file, redirty } = v.plant()
      redirty()
      expect(mine(), 'planting ran nothing').toEqual([])
      expectDisplayPaths(v, await driveDisplayPaths(dir, file), file)
      // The filter-driver read itself runs nothing either, and answers: the drivers it found, or none (git's exit 1).
      const scan = await runExec(gitBin, filterScanArgs(['status'], isWindows), { cwd: dir, timeout: 30_000 })
      if (scan.error !== undefined) expect([(scan.error as { code?: unknown }).code, scan.stdout]).toEqual([1, ''])
      else expect(scan.stdout).toMatch(/^(local|worktree)\u0000filter\.[^\n]+\n/)
      expect(mine()).toEqual([])
      // Positive control: plain git does run it, so the read above really had something to refuse.
      redirty()
      v.control(dir, file)
      expect(mine()).toEqual([...v.expect].sort())
    }, TIMEOUT)
  }

  it('the vectors are each seen on this OS: no vector is skipped but the Windows-only one, and marker names are unique', () => {
    expect(VECTORS.filter((v) => v.only !== undefined).map((v) => v.name)).toEqual(['diff.external as a .cmd program'])
    const names = VECTORS.flatMap((v) => v.expect)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('git safety harness: the person’s own setup keeps working', () => {
  it('a global filter shaped like git-lfs keeps status exactly as plain git reports it, and a mutating add runs it', async () => {
    clearMarkers()
    // Global, as `git lfs install` writes it: clean turns content into what is stored, smudge turns it back.
    const clean = plantProgram('global-clean', 'tr a-z A-Z\n')
    const smudge = plantProgram('global-smudge', 'tr A-Z a-z\n')
    const saved = `[filter "lfsx"]\n\tclean = ${runs(clean)}\n\tsmudge = ${runs(smudge)}\n\trequired = true\n`
    writeFileSync(globalConfig, `[user]\n\tname = Harness\n\temail = harness@example.invalid\n[core]\n\tautocrlf = false\n${saved}`)
    try {
      const dir = newRepo('lfs', { '.gitattributes': '*.big filter=lfsx\n', 'one.big': 'hello\n', 'two.big': 'world\n' })
      // What is stored is the cleaned form: the filter really ran on the commit.
      expect(git(dir, ['cat-file', '-p', 'HEAD:one.big'])).toBe('HELLO\n')
      // Same bytes, new mtimes: git must clean both files again to know they did not change.
      dirty(dir, 'one.big', 'hello\n')
      dirty(dir, 'two.big', 'world\n')
      clearMarkers()
      _resetGitBinForTests()
      const ours = await safeGitAsync(['status', '--porcelain', '-z'], opts(dir))
      expect(fired()).toContain('global-clean')
      dirty(dir, 'one.big', 'hello\n')
      const plain = git(dir, ['status', '--porcelain', '-z'])
      expect(ours).toBe(plain)
      expect(ours).toBe('')
      const numstat = await safeGitAsync(['diff', '--numstat'], opts(dir))
      expect(numstat).toBe(git(dir, ['diff', '--numstat']))
      // A real change is still one change, as plain git counts it.
      dirty(dir, 'two.big', 'wordl\n')
      expect(await safeGitAsync(['status', '--porcelain'], opts(dir))).toBe(git(dir, ['status', '--porcelain']))
      // A mutating add goes through safeGitAsync untouched: the global clean filter stores the cleaned form.
      clearMarkers()
      writeFileSync(join(dir, 'three.big'), 'third\n')
      await safeGitAsync(['add', '--', 'three.big'], opts(dir))
      expect(fired()).toContain('global-clean')
      expect(git(dir, ['cat-file', '-p', ':three.big'])).toBe('THIRD\n')
    } finally {
      writeFileSync(globalConfig, '[user]\n\tname = Harness\n\temail = harness@example.invalid\n[core]\n\tautocrlf = false\n')
    }
  }, TIMEOUT)

  it('edits inside a submodule show on the status every panel reads, as plain git reports them, with nothing run', async () => {
    clearMarkers()
    const dir = newRepo('subedits', { 'z.txt': 'z\n' })
    const subs: string[] = []
    for (const name of ['my sub', 'other']) {
      const sub = join(dir, name)
      mkdirSync(sub)
      git(sub, ['init', '-q', '-b', 'main'])
      writeFileSync(join(sub, 's.txt'), 'one\n')
      git(sub, ['add', '-A'])
      git(sub, ['commit', '-q', '-m', 's1'])
      subs.push(sub)
    }
    writeFileSync(join(dir, '.gitmodules'), '[submodule "my sub"]\n\tpath = my sub\n\turl = ./x\n[submodule "other"]\n\tpath = other\n\turl = ./y\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'gitlinks'])
    mkdirSync(join(dir, 'src'))
    // A tracked edit in one submodule, only an untracked file in the other, and a change of the superproject's own.
    writeFileSync(join(subs[0], 's.txt'), 'two\n')
    writeFileSync(join(subs[1], 'new.txt'), 'new\n')
    writeFileSync(join(dir, 'z.txt'), 'zz\n')
    _resetGitBinForTests()
    for (const args of [['status', '--porcelain', '-b', '-z'], ['status', '--porcelain'], ['status', '--short'], ['status', '--porcelain', '--untracked-files=no']]) {
      expect(await safeGitAsync(args, opts(dir)), args.join(' ')).toBe(git(dir, args))
    }
    // --short outside -z writes paths relative to the folder it ran in, as plain git does.
    expect(await safeGitAsync(['status', '--short'], opts(join(dir, 'src')))).toBe(git(join(dir, 'src'), ['status', '--short']))
    expect(await safeGitAsync(['status', '--porcelain', '-b', '-z'], opts(dir))).toContain(' M my sub\0')
    // The dot and the rail read the same cached argv.
    expect(await cachedGit(['status', '--porcelain', '-b', '-z'], opts(dir))).toBe(git(dir, ['status', '--porcelain', '-b', '-z']))
    // Clean again: the rows go.
    git(subs[0], ['checkout', '--', 's.txt'])
    rmSync(join(subs[1], 'new.txt'))
    _resetGitBinForTests()
    expect(await safeGitAsync(['status', '--porcelain'], opts(dir))).toBe(' M z.txt\n')
    expect(fired()).toEqual([])
  }, TIMEOUT)

  it('a filter the repository adds after a scan is seen on the next read, and a --git-dir read scans that repository', async () => {
    clearMarkers()
    const dir = newRepo('rescan', { '.gitattributes': '*.dat filter=late\n', 'x.dat': 'one\n' })
    _resetGitBinForTests()
    await safeGitAsync(['status', '--porcelain'], opts(dir))
    // Within the scan's 30 s, the repository's config gains a driver: its text changed, so the next read scans again.
    git(dir, ['config', 'filter.late.clean', runs(plantProgram('late-clean', 'cat\n'))])
    git(dir, ['config', 'filter.late.required', 'true'])
    dirty(dir, 'x.dat', 'two\n')
    await quiet(safeGitAsync(['status', '--porcelain'], opts(join(dir, '.git', '..'))))
    await quiet(safeGitAsync(['diff', '--numstat'], opts(dir)))
    // A read from another folder that names the repository with --git-dir and --work-tree reads that config.
    await quiet(safeGitAsync(['--git-dir', join(dir, '.git'), '--work-tree', dir, 'status', '--porcelain'], opts(base)))
    await quiet(safeGitAsync([`--git-dir=${join(dir, '.git')}`, `--work-tree=${dir}`, 'diff', '--numstat'], opts(base)))
    expect(fired()).toEqual([])
    git(dir, ['status', '--porcelain'], true)
    expect(fired()).toEqual(['late-clean'])
  }, TIMEOUT)

  it('a committed folder that is itself a git folder is its own repository: the scan kept for the clone around it is not used there', async () => {
    clearMarkers()
    // The reviewer's case: a clone holding a committed folder `evil` that is a whole git folder (HEAD, objects, refs,
    // config) whose config names a required filter and a work tree, with a warm scan for the clone itself.
    const src = newRepo('nested-src', { '.gitattributes': '*.dat filter=nested\n', 'x.dat': 'one\n' })
    const outer = newRepo('nested-clone')
    const evil = join(outer, 'evil')
    copyTree(join(src, '.git'), evil)
    git(outer, ['add', '-A'])
    git(outer, ['commit', '-q', '-m', 'a folder that is a git folder'])
    git(evil, ['config', 'core.bare', 'false'])
    git(evil, ['config', 'core.worktree', slash(src)])
    git(evil, ['config', 'filter.nested.clean', runs(plantProgram('nested-clean', 'cat\n'))])
    git(evil, ['config', 'filter.nested.required', 'true'])
    dirty(src, 'x.dat', 'two\n')
    _resetGitBinForTests()
    await safeGitAsync(['status', '--porcelain'], opts(outer))
    await quiet(safeGitAsync(['status', '--porcelain'], opts(evil)))
    await quiet(safeGitAsync(['status', '--porcelain', '-b', '-z'], opts(join(evil, 'refs'))))
    await quiet(safeGitAsync(['diff', '--numstat'], opts(evil)))
    expect(fired()).toEqual([])
    git(evil, ['status', '--porcelain'], true)
    expect(fired()).toEqual(['nested-clean'])
  }, TIMEOUT)

  /** An attacker's git folder at `gitDir`: a copy of a repository whose x.dat runs a required filter planted as `name`,
   *  with its work tree that repository, and x.dat there edited. */
  function attackerGitDir(gitDir: string, name: string): void {
    const src = newRepo(`${name}-src`, { '.gitattributes': `*.dat filter=${name}\n`, 'x.dat': 'one\n' })
    // Not fs.cpSync: its native recursive copy on the macOS runner fails now and then with ENOENT on the first
    // folder inside a fresh destination (`a/.git/objects`, `.git /objects`), whatever the case.
    copyTree(join(src, '.git'), gitDir)
    git(gitDir, ['config', 'core.bare', 'false'])
    git(gitDir, ['config', 'core.worktree', slash(src)])
    git(gitDir, ['config', `filter.${name}.clean`, runs(plantProgram(`${name}-clean`, 'cat\n'))])
    git(gitDir, ['config', `filter.${name}.required`, 'true'])
    dirty(src, 'x.dat', 'two\n')
  }

  it('a .git file naming `../.git ` (a trailing space) is the folder `.git ` git opens, never the clone’s kept scan', async (ctx) => {
    clearMarkers()
    const proj = newRepo('ws-proj')
    // The fixture is a folder named `.git ` with files in it, copied in place (never through git's index, which
    // refuses any path that folds to .git). The case is about the folder git opens, so it runs wherever the file
    // system holds that name and git opens it: Linux and macOS. On Windows NTFS can hold it (Node writes through
    // \\?\ paths) but git drops the trailing space and opens `.git`, so there is no such folder for git to open.
    if (!holdsTrailingSpace(proj)) {
      ctx.skip('this file system cannot hold a folder name ending in a space')
      return
    }
    attackerGitDir(join(proj, '.git '), 'ws')
    const sub = join(proj, 'sub')
    mkdirSync(sub)
    writeFileSync(join(sub, '.git'), 'gitdir: ../.git \n')
    // rev-parse runs no filter, so asking it which folder it opened fires nothing.
    if (!git(sub, ['rev-parse', '--absolute-git-dir'], true).replace(/\r?\n$/, '').endsWith('/.git ')) {
      expect(fired()).toEqual([])
      ctx.skip('git here does not open a folder whose name ends in a space')
      return
    }
    _resetGitBinForTests()
    await safeGitAsync(['status', '--porcelain'], opts(proj))
    await quiet(safeGitAsync(['status', '--porcelain'], opts(sub)))
    await quiet(safeGitAsync(['diff', '--numstat'], opts(sub)))
    expect(fired()).toEqual([])
    git(sub, ['status', '--porcelain'], true)
    expect(fired()).toEqual(['ws-clean'])
  }, TIMEOUT)

  it('a .git file whose path climbs out of a link (`lnk/../../.git`) is the folder git opens through the link, never the clone’s kept scan', async () => {
    // Windows resolves `..` by the name before any link, so there the folder git opens is the one the name says.
    if (isWindows) return
    clearMarkers()
    const proj = newRepo('ln-proj')
    attackerGitDir(join(proj, 'a', '.git'), 'ln')
    mkdirSync(join(proj, 'a', 'b', 'c'), { recursive: true })
    const sub = join(proj, 'sub')
    mkdirSync(sub)
    symlinkSync(join(proj, 'a', 'b', 'c'), join(sub, 'lnk'))
    // By the name, sub/lnk/../../.git is proj/.git; through the link it is proj/a/.git.
    writeFileSync(join(sub, '.git'), 'gitdir: lnk/../../.git\n')
    _resetGitBinForTests()
    await safeGitAsync(['status', '--porcelain'], opts(proj))
    await quiet(safeGitAsync(['status', '--porcelain'], opts(sub)))
    await quiet(safeGitAsync(['diff', '--numstat'], opts(sub)))
    expect(fired()).toEqual([])
    git(sub, ['status', '--porcelain'], true)
    expect(fired()).toEqual(['ln-clean'])
  }, TIMEOUT)

  it('an empty .git folder git skips does not stand in for the repository it skips to: an edit to that config is seen', async () => {
    clearMarkers()
    const outer = newRepo('empty-dotgit', { '.gitattributes': '*.dat filter=skip\n', 'x.dat': 'one\n' })
    const sub = join(outer, 'sub')
    mkdirSync(join(sub, '.git'), { recursive: true })
    _resetGitBinForTests()
    await safeGitAsync(['status', '--porcelain'], opts(sub))
    git(outer, ['config', 'filter.skip.clean', runs(plantProgram('skip-clean', 'cat\n'))])
    git(outer, ['config', 'filter.skip.required', 'true'])
    dirty(outer, 'x.dat', 'two\n')
    await quiet(safeGitAsync(['status', '--porcelain'], opts(sub)))
    await quiet(safeGitAsync(['diff', '--numstat'], opts(sub)))
    expect(fired()).toEqual([])
    git(sub, ['status', '--porcelain'], true)
    expect(fired()).toEqual(['skip-clean'])
  }, TIMEOUT)

  it('a config that includes another file on one line ([core][include]) is read again every time: a filter added to that file is seen', async () => {
    clearMarkers()
    const dir = newRepo('one-line-include', { '.gitattributes': '*.dat filter=inc\n', 'x.dat': 'one\n' })
    const included = join(base, 'one-line-include.cfg')
    writeFileSync(included, '')
    appendFileSync(join(dir, '.git', 'config'), `[core][include]path = "${slash(included)}"\n`)
    _resetGitBinForTests()
    await safeGitAsync(['status', '--porcelain'], opts(dir))
    writeFileSync(included, `[filter "inc"]\n\tclean = ${runs(plantProgram('inc-clean', 'cat\n'))}\n\trequired = true\n`)
    dirty(dir, 'x.dat', 'two\n')
    await quiet(safeGitAsync(['status', '--porcelain'], opts(dir)))
    await quiet(safeGitAsync(['diff', '--numstat'], opts(dir)))
    expect(fired()).toEqual([])
    git(dir, ['status', '--porcelain'], true)
    expect(fired()).toEqual(['inc-clean'])
  }, TIMEOUT)

  it('a mutating add in a repository with its own filter runs that filter (writes are the person’s git, unchanged)', async () => {
    clearMarkers()
    const dir = newRepo('local-add', { '.gitattributes': '*.dat filter=own\n' })
    git(dir, ['config', 'filter.own.clean', runs(plantProgram('own-clean', 'tr a-z A-Z\n'))])
    writeFileSync(join(dir, 'y.dat'), 'quiet\n')
    _resetGitBinForTests()
    await safeGitAsync(['add', '--', 'y.dat'], opts(dir))
    expect(fired()).toEqual(['own-clean'])
    expect(git(dir, ['cat-file', '-p', ':y.dat'])).toBe('QUIET\n')
    expect(existsSync(join(dir, 'y.dat'))).toBe(true)
  }, TIMEOUT)
})

describe('git safety harness: an inherited git environment', () => {
  /** Sets `vars` in Termpolis's own environment for `body`, then puts back what was there. */
  async function withEnv(vars: Record<string, string>, body: () => Promise<void>): Promise<void> {
    const before: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; process.env[k] = v }
    try {
      await body()
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }

  it('an inherited GIT_CONFIG_GLOBAL naming a filter program, or a GIT_TRACE file, reaches no read: status runs nothing and writes no trace', async () => {
    clearMarkers()
    const dir = newRepo('envglobal', { '.gitattributes': '*.dat filter=envg\n', 'x.dat': 'one\n' })
    const plantedGlobal = join(base, 'planted-global.gitconfig')
    writeFileSync(plantedGlobal, `[filter "envg"]\n\tclean = ${runs(plantProgram('env-global-clean', 'cat\n'))}\n\trequired = true\n`)
    const trace = join(base, 'planted-read-trace.log')
    _resetGitBinForTests()
    await withEnv({ GIT_CONFIG_GLOBAL: plantedGlobal, GIT_TRACE: trace }, async () => {
      dirty(dir, 'x.dat', 'two\n')
      expect(await safeGitAsync(['status', '--porcelain'], opts(dir))).toBe(' M x.dat\n')
      expect(await cachedGit(['status', '--porcelain', '-b', '-z'], opts(dir))).toBe('## main\u0000 M x.dat\u0000')
      expect(fired()).toEqual([])
      expect(existsSync(trace)).toBe(false)
      // Positive control: plain git with the same environment runs the planted filter and writes the trace.
      dirty(dir, 'x.dat', 'two\n')
      git(dir, ['status', '--porcelain'], true)
      expect(fired()).toEqual(['env-global-clean'])
      expect(existsSync(trace)).toBe(true)
    })
  }, TIMEOUT)

  it('an inherited GIT_CONFIG naming another file does not hide the repository’s own filter from the scan: status runs nothing', async () => {
    clearMarkers()
    const dir = newRepo('envconfig', { '.gitattributes': '*.dat filter=envc\n', 'x.dat': 'one\n' })
    git(dir, ['config', 'filter.envc.clean', runs(plantProgram('env-config-clean', 'cat\n'))])
    git(dir, ['config', 'filter.envc.required', 'true'])
    const elsewhere = join(base, 'elsewhere.gitconfig')
    writeFileSync(elsewhere, '[core]\n\tautocrlf = false\n')
    _resetGitBinForTests()
    await withEnv({ GIT_CONFIG: elsewhere }, async () => {
      dirty(dir, 'x.dat', 'two\n')
      // `git config` reads only the GIT_CONFIG file, and status still reads the repository's config.
      expect(await safeGitAsync(['status', '--porcelain'], opts(dir))).toBe(' M x.dat\n')
      expect(await safeGitAsync(['diff', '--numstat'], opts(dir))).toBe('1\t1\tx.dat\n')
      expect(await cachedGit(['status', '--porcelain', '-b', '-z'], opts(dir))).toBe('## main\u0000 M x.dat\u0000')
      expect(fired()).toEqual([])
      // Positive control: plain git with the same environment runs it.
      dirty(dir, 'x.dat', 'two\n')
      git(dir, ['status', '--porcelain'], true)
      expect(fired()).toEqual(['env-config-clean'])
    })
  }, TIMEOUT)

  it('inherited GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR and GIT_CONFIG_* do not move a display read, and a write keeps them', async () => {
    clearMarkers()
    const dir = newRepo('envshown', { 'z.txt': 'z\n' })
    const decoy = newRepo('envdecoy', { 'only-in-decoy.txt': 'd\n' })
    dirty(dir, 'z.txt', 'Z\n')
    dirty(decoy, 'only-in-decoy.txt', 'D\n')
    const plain = git(dir, ['status', '--porcelain'])
    expect(plain).toBe(' M z.txt\n')
    const index = join(base, 'envshown.index')
    _resetGitBinForTests()
    await withEnv({
      GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy, GIT_INDEX_FILE: index, GIT_COMMON_DIR: join(decoy, '.git'),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'status.showUntrackedFiles', GIT_CONFIG_VALUE_0: 'no'
    }, async () => {
      writeFileSync(join(dir, 'new.txt'), 'new\n')
      expect(await safeGitAsync(['status', '--porcelain'], opts(dir))).toBe(' M z.txt\n?? new.txt\n')
      expect(await safeGitAsync(['diff', '--numstat'], opts(dir))).toBe('1\t1\tz.txt\n')
      // A write is the person's git, environment and all: this add writes the index GIT_INDEX_FILE names, in the decoy.
      await safeGitAsync(['add', '--', 'only-in-decoy.txt'], opts(dir))
    })
    expect(existsSync(index)).toBe(true)
    expect(git(dir, ['status', '--porcelain'])).toBe(' M z.txt\n?? new.txt\n')
    expect(fired()).toEqual([])
  }, TIMEOUT)
})
