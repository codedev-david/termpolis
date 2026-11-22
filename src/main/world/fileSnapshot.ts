// Lumopolis file snapshot (world host, Node only, no Electron): the structure of a folder main has not
// indexed yet, made in the world utility process so a first world never reads and parses a whole
// repository on the main thread. It is the shape graphSnapshot(..., { structureOnly: true }) answers:
// the source files (repository-relative, `/` separated, sorted) and each file's import specifiers as
// written. Inside a repository git lists them (tracked and untracked files the ignore files allow, and the
// submodules' files); a plain folder, or one git refuses, is walked (folderWalk.ts, capped). The files are chosen by the code index's own rules (isIndexableCodeFile:
// no secrets, binaries, bundles or lock files; a language the extractor knows; the same size cap) and
// parsed by the same pure extractor the code graph falls back to.
//
// This module must stay out of the code ingest and git command modules: they reach the proc host,
// which starts itself on any process with a parent port, so importing them here would hijack the
// world host's port (worldHostImports.test.ts guards the whole graph).
import type { GraphSnapshot } from '../codeGraph'
import { isIndexableCodeFile } from '../codeFileFilter'
import { extractFile, languageForFile } from '../codeGraphExtract'
import { binInsideFolder, resolveGitBin } from '../binPath'
import { lsFilesArgs, lsSubmoduleArgs, mergeListings, parseLsFiles } from '../repoFileList'
import { access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { walkFolder, type WalkResult } from './folderWalk'
import { configEnv, inheritedEnv, loginConfig, loginEnv, safetyFlags } from './gitLogin'
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

/**
 * The files git lists under `root`, relative to it: tracked ones, untracked ones the ignore files allow, and, when
 * the repository has submodules, theirs (recursed into: Lumopolis maps them with the rest). Git runs with the same
 * safety flags as a clone (no hooks, no symlinks, no fsmonitor), with no login (captureExec), and by its full path
 * (binPath.ts resolveGitBin, never the bare name); a git inside the folder itself is never run, and lists nothing.
 * No git at all throws NO_GIT_MESSAGE. Git that ran and refused (not a repository after all, an owner it does not
 * trust) is null, so the caller can walk the folder instead.
 */
export async function gitListFiles(
  root: string,
  exec: CaptureFn = captureExec,
  isWindows: boolean = process.platform === 'win32',
  gitBin: () => Promise<string | null> = resolveGitBin,
  hasSubmodules: (root: string) => Promise<boolean> = (r) => exists(join(r, '.gitmodules'))
): Promise<string[] | null> {
  const bin = await gitBin()
  if (bin === null) throw new Error(NO_GIT_MESSAGE)
  if (await binInsideFolder(bin, root)) return []
  const run = (args: string[]): Promise<CaptureResult> =>
    exec(bin, [...safetyFlags(isWindows), ...args], { timeout: LIST_TIMEOUT_MS, maxBytes: MAX_LIST_BYTES })
  const r = await run(lsFilesArgs(root))
  if (r.missing) throw new Error(NO_GIT_MESSAGE)
  if (r.code !== 0) return null
  const own = parseLsFiles(r.stdout)
  if (!(await hasSubmodules(root))) return own
  const sub = await run(lsSubmoduleArgs(root))
  return mergeListings(own, sub.code === 0 ? parseLsFiles(sub.stdout) : [])
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
  git?: (root: string) => Promise<string[] | null>
  walk?: (root: string) => Promise<WalkResult>
}

/** The files of `root`: git's listing inside a repository, else (a plain folder, or git refused) a capped walk. */
export async function listSourceFiles(root: string, deps: ListSourceDeps = {}): Promise<WalkResult> {
  if (await (deps.inRepo ?? insideGitRepo)(root)) {
    const listed = await (deps.git ?? gitListFiles)(root)
    if (listed !== null) return { files: listed, capped: false }
  }
  const base = slashBase(root)
  return (deps.walk ?? ((r: string) => walkFolder(r, { keep: (rel) => isSourceFile(`${base}/${rel}`) })))(root)
}

/** A listing: plain names, or a walk's result (which says whether it stopped at its cap). */
export type FileListing = string[] | WalkResult

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
 * pane says so rather than showing an empty world. A capped walk records how many files it listed (filesCapped).
 */
export async function snapshotFromFiles(root: string, deps: FileSnapshotDeps): Promise<GraphSnapshot> {
  const base = slashBase(root)
  let listing: WalkResult
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
    if (rel === null || Object.hasOwn(fileImports, rel)) continue
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
  return { root: base, files, symbols: [], callEdges: [], fileImports, ...(listing.capped ? { filesCapped: listing.files.length } : {}) }
}
