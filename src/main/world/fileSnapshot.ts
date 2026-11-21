// Lumopolis file snapshot (world host, Node only, no Electron): the structure of a folder main has not
// indexed yet, made in the world utility process so a first world never reads and parses a whole
// repository on the main thread. It is the shape graphSnapshot(..., { structureOnly: true }) answers:
// the git-listed source files (repository-relative, `/` separated, sorted) and each file's import
// specifiers as written. The files are chosen by the code index's own rules (isIndexableCodeFile:
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
import { configEnv, inheritedEnv, loginConfig, loginEnv, safetyFlags } from './gitLogin'
import { nodeExecFile } from './gitSource'

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

/**
 * The files git tracks under `root`, relative to it, as `git ls-files` lists them (what the code ingest
 * indexes). A folder outside git, a git failure, or no git at all lists nothing. Git runs with the same
 * safety flags as a clone (no hooks, no symlinks, no fsmonitor), with no login (captureExec), and by its full
 * path (binPath.ts resolveGitBin, never the bare name); a git inside the folder itself is never run.
 */
export async function gitListFiles(
  root: string,
  exec: CaptureFn = captureExec,
  isWindows: boolean = process.platform === 'win32',
  gitBin: () => Promise<string | null> = resolveGitBin
): Promise<string[]> {
  const bin = await gitBin()
  if (bin === null || (await binInsideFolder(bin, root))) return []
  const args = [...safetyFlags(isWindows), '-C', root, 'ls-files', '-z']
  const r = await exec(bin, args, { timeout: LIST_TIMEOUT_MS, maxBytes: MAX_LIST_BYTES })
  return r.code === 0 ? r.stdout.split('\0').filter((f) => f !== '') : []
}

export interface FileSnapshotDeps {
  /** Repository-relative files under `root` (default: gitListFiles). */
  listFiles?: (root: string) => Promise<string[]>
  /** Reads one file by its absolute path; null or a rejection reads as absent. */
  read: (p: string) => Promise<string | null>
}

/** A relative path that stays inside the folder: no absolute path, drive, `..` or empty segment. */
function safeRelative(file: string): string | null {
  const rel = file.replace(/\\/g, '/')
  if (rel === '' || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null
  return rel.split('/').some((part) => part === '' || part === '.' || part === '..') ? null : rel
}

/** The structure-only snapshot of `root`. Never rejects for a missing or unreadable file; such a file is simply absent. */
export async function snapshotFromFiles(root: string, deps: FileSnapshotDeps): Promise<GraphSnapshot> {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  let listed: string[]
  try {
    listed = await (deps.listFiles ?? gitListFiles)(root)
  } catch {
    listed = []
  }
  const files: string[] = []
  const fileImports: Record<string, string[]> = {}
  for (const raw of new Set(listed)) {
    const rel = safeRelative(raw)
    if (rel === null || Object.hasOwn(fileImports, rel)) continue
    const abs = `${base}/${rel}`
    if (!isIndexableCodeFile(abs) || !languageForFile(abs)) continue
    const content = await deps.read(abs).catch(() => null)
    if (content === null || content.length > MAX_SNAPSHOT_FILE_CHARS) continue
    const ex = extractFile(rel, content)
    if (!ex) continue
    files.push(rel)
    fileImports[rel] = ex.imports
  }
  files.sort()
  return { root: base, files, symbols: [], callEdges: [], fileImports }
}
