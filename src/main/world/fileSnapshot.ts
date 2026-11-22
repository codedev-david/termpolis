// Lumopolis file snapshot (world host, Node only, no Electron): the structure of a folder main has not
// indexed yet, made in the world utility process so a first world never reads and parses a whole
// repository on the main thread. It is the shape graphSnapshot(..., { structureOnly: true }) answers:
// the source files (repository-relative, `/` separated, sorted) and each file's import specifiers as
// written. Inside a repository git lists them, as the code index's own listing does (repoFileList.ts listRepo:
// tracked and untracked files the ignore files allow, submodules and nested repositories); a plain folder, or one
// git refuses or lists nothing for, is walked (folderWalk.ts, capped, honouring the folder's own .gitignore). The
// files are chosen by the code index's own rules (isIndexableCodeFile: no secrets, binaries, bundles or lock files;
// a language the extractor knows; the same size cap), minus what the world leaves out (group.ts isIgnored: never
// read at all), and parsed by the same pure extractor the code graph falls back to.
//
// This module must stay out of the code ingest and git command modules: they reach the proc host,
// which starts itself on any process with a parent port, so importing them here would hijack the
// world host's port (worldHostImports.test.ts guards the whole graph).
import type { GraphSnapshot } from '../codeGraph'
import { isIndexableCodeFile } from '../codeFileFilter'
import { extractFile, languageForFile } from '../codeGraphExtract'
import { binInsideFolder, resolveGitBin } from '../binPath'
import { isIgnoredPath, listRepo, MAP_FILE_CAP, type NestedWalk, type RepoListing } from '../repoFileList'
import { access, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { walkFolder, type WalkResult } from './folderWalk'
import { readRootIgnore } from './rootIgnore'
import { configEnv, inheritedEnv, loginConfig, loginEnv } from './gitLogin'
import { NO_GIT_MESSAGE, nodeExecFile } from './gitSource'

/** Files longer than this are left out, as the code graph's sweep leaves them out (512 KB of source). */
export const MAX_SNAPSHOT_FILE_CHARS = 512 * 1024
/** The most `git ls-files` output read (64 MiB, the code ingest's own limit). */
export const MAX_LIST_BYTES = 64 * 1024 * 1024
/** How long one `git ls-files` may run. */
export const LIST_TIMEOUT_MS = 60_000

export interface CaptureResult {
  code: number
  stdout: string
  /** The program could not be started (not installed at that path). */
  missing: boolean
}

export type CaptureFn = (cmd: string, args: string[], opts: { timeout: number; maxBytes: number }) => Promise<CaptureResult>

/**
 * Runs a program without a shell and collects its stdout; never rejects. Output past `maxBytes`, or a run
 * past `timeout`, fails. It runs through gitSource's nodeExecFile, the world host's one process launcher,
 * with the clone's environment rule (git's path variables dropped) and no login of any kind (no helper,
 * no askpass, no prompt).
 */
export const captureExec: CaptureFn = async (cmd, args, opts) => {
  const none = { mode: 'none' } as const
  const env = { ...inheritedEnv(process.env), ...configEnv(loginConfig(none)), ...loginEnv(none) }
  const r = await nodeExecFile(cmd, args, { env, timeout: opts.timeout, stdoutMax: opts.maxBytes })
  return { code: r.code, stdout: r.stdout as string, missing: r.missing as boolean }
}

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false)
const isFileOnDisk = (p: string): Promise<boolean> => stat(p).then((st) => st.isFile(), () => false)

/**
 * The files git lists under `root`, relative to it, by the code index's own listing (repoFileList.ts listRepo:
 * tracked files, untracked ones the ignore files allow minus skip folders and virtual environments, submodules
 * recursed, nested repositories listed by their own git, or walked when git refuses one, and a nested worktree of
 * the repository itself left out). Git runs with the same safety flags as a clone (no hooks, no symlinks, no
 * fsmonitor: the shared argument builders put them first), with no login (captureExec), and by its full path
 * (binPath.ts resolveGitBin, never the bare name); a git inside the folder itself is never run, and lists nothing.
 * No git at all throws NO_GIT_MESSAGE.
 * Git that ran and refused `root` (not a repository after all, an owner it does not trust) is null, so the caller
 * can walk the folder instead.
 */
export async function gitListFiles(
  root: string,
  exec: CaptureFn = captureExec,
  isWindows: boolean = process.platform === 'win32',
  gitBin: () => Promise<string | null> = resolveGitBin,
  has: (path: string) => Promise<boolean> = exists,
  isFile: (path: string) => Promise<boolean> = isFileOnDisk,
  walk: (absDir: string, cap: number) => Promise<NestedWalk> = walkSources
): Promise<RepoListing | null> {
  const bin = await gitBin()
  if (bin === null) throw new Error(NO_GIT_MESSAGE)
  if (await binInsideFolder(bin, root)) return { files: [], unreadable: [], nestedCapped: false, nested: [] }
  const git = async (args: string[]): Promise<string | null> => {
    const r = await exec(bin, args, { timeout: LIST_TIMEOUT_MS, maxBytes: MAX_LIST_BYTES })
    if (r.missing) throw new Error(NO_GIT_MESSAGE)
    return r.code === 0 ? r.stdout : null
  }
  // isWindows names git's safety flags (the Windows hooks path); folders compare case folded where this platform folds.
  return listRepo(root, { git, exists: has, isFile, walk, isWindows })
}

/** Whether `root` sits in a git repository: a `.git` (folder, or the file a worktree or submodule has) in it or above it. */
export async function insideGitRepo(root: string, has: (p: string) => Promise<boolean> = exists): Promise<boolean> {
  let at = resolve(root)
  for (;;) {
    if (await has(join(at, '.git'))) return true
    const up = dirname(at)
    if (up === at) return false
    at = up
  }
}

const slashBase = (root: string): string => root.replace(/\\/g, '/').replace(/\/+$/, '')

/** A file the snapshot can map: what the code index indexes, in a language the extractor knows. */
const isSourceFile = (abs: string): boolean => isIndexableCodeFile(abs) && languageForFile(abs) !== null

export interface ListSourceDeps {
  inRepo?: (root: string) => Promise<boolean>
  git?: (root: string) => Promise<RepoListing | null>
  walk?: (root: string) => Promise<WalkResult>
}

/** The files of a folder: a walk's, or git's, which also says when the nested repositories were cut. */
export interface SourceListing extends WalkResult {
  /** The nested repositories held more than MAP_FILE_CAP files: some of theirs are left out. */
  nestedCapped?: boolean
}

/**
 * The capped walk of `root` (a plain folder, or a nested repository git refuses): source files the world shows,
 * minus what the folder's own .gitignore names.
 */
async function walkSources(root: string, cap?: number): Promise<WalkResult> {
  const base = slashBase(root)
  const ignored = await readRootIgnore(root)
  return walkFolder(root, {
    keep: (rel) => !isIgnoredPath(rel) && isSourceFile(`${base}/${rel}`),
    ...(ignored ? { ignored } : {}),
    ...(cap === undefined ? {} : { cap })
  })
}

/** git's listing as the world's: the repository itself is never cut, and a nested cut is said apart. */
function fromGit(listed: RepoListing): SourceListing {
  return { files: listed.files, capped: false, unreadable: listed.unreadable, ...(listed.nestedCapped ? { nestedCapped: true } : {}) }
}

/**
 * The files of `root`: git's listing inside a repository, else (a plain folder, or git refused) a capped walk. A
 * listing git answered with nothing (a folder its ignore files cover whole) is walked as well, and the walk is the
 * world when it found files on disk; otherwise the empty listing stands.
 */
export async function listSourceFiles(root: string, deps: ListSourceDeps = {}): Promise<SourceListing> {
  const walk = deps.walk ?? ((r: string) => walkSources(r))
  if (await (deps.inRepo ?? insideGitRepo)(root)) {
    const listed = await (deps.git ?? gitListFiles)(root)
    if (listed !== null && listed.files.length > 0) return fromGit(listed)
    if (listed !== null) {
      const walked = await walk(root)
      return walked.files.length > 0 || walked.unreadable.length > 0 ? walked : fromGit(listed)
    }
  }
  return walk(root)
}

/**
 * A listing: plain names, or a listing that says whether it stopped at its cap (or only the nested repositories
 * did) and which names it could not read.
 */
export type FileListing = string[] | { files: string[]; capped: boolean; unreadable?: string[]; nestedCapped?: boolean }

export interface FileSnapshotDeps {
  /** Folder-relative files under `root` (default: listSourceFiles). */
  listFiles?: (root: string) => Promise<FileListing>
  /** Reads one file by its absolute path; null or a rejection reads as absent. */
  read: (p: string) => Promise<string | null>
}

/** A relative path that stays inside the folder: no absolute path, drive, `..` or empty segment. */
function safeRelative(file: string): string | null {
  const rel = file.replace(/\\/g, '/')
  if (rel === '' || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null
  return rel.split('/').some((part) => part === '' || part === '.' || part === '..') ? null : rel
}

/**
 * The structure-only snapshot of `root`. Never rejects for a missing or unreadable file; such a file is simply absent.
 * A listing that fails lists nothing, except git missing from a repository, which rejects with NO_GIT_MESSAGE so the
 * pane says so rather than showing an empty world. A file the world leaves out (group.ts isIgnored) is never read. A
 * capped listing records how many files are mapped (filesCapped), one whose nested repositories alone were cut the
 * cap they shared (nestedCapped); names the listing could not read pass through
 * (unreadable), for the world's count.
 */
export async function snapshotFromFiles(root: string, deps: FileSnapshotDeps): Promise<GraphSnapshot> {
  const base = slashBase(root)
  let listing: Exclude<FileListing, string[]>
  try {
    const got = await (deps.listFiles ?? listSourceFiles)(root)
    listing = Array.isArray(got) ? { files: got, capped: false } : got
  } catch (e) {
    if ((e as Error).message === NO_GIT_MESSAGE) throw e
    listing = { files: [], capped: false }
  }
  const listed = listing.files
  const files: string[] = []
  const fileImports: Record<string, string[]> = {}
  for (const raw of new Set(listed)) {
    const rel = safeRelative(raw)
    if (rel === null || Object.hasOwn(fileImports, rel) || isIgnoredPath(rel)) continue
    const abs = `${base}/${rel}`
    if (!isSourceFile(abs)) continue
    const content = await deps.read(abs).catch(() => null)
    if (content === null || content.length > MAX_SNAPSHOT_FILE_CHARS) continue
    const ex = extractFile(rel, content)
    if (!ex) continue
    files.push(rel)
    fileImports[rel] = ex.imports
  }
  files.sort()
  const unreadable = listing.unreadable ?? []
  return {
    root: base,
    files,
    symbols: [],
    callEdges: [],
    fileImports,
    ...(listing.capped ? { filesCapped: files.length } : {}),
    ...(listing.nestedCapped ? { nestedCapped: MAP_FILE_CAP } : {}),
    ...(unreadable.length > 0 ? { unreadable: [...unreadable] } : {})
  }
}
