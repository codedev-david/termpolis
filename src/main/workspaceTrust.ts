// Workspace trust gate.
//
// Termpolis runs repo-controlled scripts on the user's behalf — swarm
// review runs `npm test`, git commits trigger `.git/hooks/pre-commit`,
// etc. If a user opens a folder from the internet, those scripts are
// effectively arbitrary code. Trust gates that: a folder is untrusted
// until the user explicitly confirms, at which point it's persisted to
// disk so they're not re-prompted.
//
// Folders the user picks through the native dialog:pick-directory flow
// are auto-trusted — picking is already a deliberate action. The prompt
// is reserved for folders opened via command-line args, drag-drop, or
// session restoration where the user may not realize what's being run.

import { existsSync, readFileSync, mkdirSync } from 'fs'
import { dirname, resolve, sep } from 'path'
import { app, dialog, BrowserWindow } from 'electron'
import { writeSecureFile } from './secureFile'

let storePath: string | null = null
const trusted = new Set<string>()
let loaded = false

function normalize(p: string): string {
  return resolve(p)
}

function ensureDir(filePath: string) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function initWorkspaceTrust(overrideUserDataDir?: string) {
  try {
    const base = overrideUserDataDir ?? app.getPath('userData')
    storePath = `${base}${sep}trusted-workspaces.json`
    trusted.clear()
    if (existsSync(storePath)) {
      try {
        const parsed = JSON.parse(readFileSync(storePath, 'utf-8'))
        const paths = Array.isArray(parsed?.paths) ? parsed.paths : []
        for (const p of paths) {
          if (typeof p === 'string' && p.length > 0) trusted.add(normalize(p))
        }
      } catch {
        // Corrupt file — treat as empty. We don't throw because a broken
        // store would lock the user out of every workspace.
      }
    }
  } finally {
    loaded = true
  }
}

function save() {
  if (!storePath) return
  try {
    ensureDir(storePath)
    writeSecureFile(storePath, JSON.stringify({ paths: [...trusted] }, null, 2))
  } catch {
    // Non-fatal: trust becomes in-memory only for this session.
  }
}

export function isWorkspaceTrusted(cwd: string): boolean {
  if (!loaded) initWorkspaceTrust()
  if (!cwd || typeof cwd !== 'string') return false
  const normalized = normalize(cwd)
  if (trusted.has(normalized)) return true
  // A trusted parent implies trust for subdirectories — matches the
  // mental model of "I trust this project" rather than "this exact path".
  for (const p of trusted) {
    if (normalized.startsWith(p + sep)) return true
  }
  return false
}

export function trustWorkspace(cwd: string): void {
  if (!loaded) initWorkspaceTrust()
  if (!cwd || typeof cwd !== 'string') return
  trusted.add(normalize(cwd))
  save()
}

export function revokeWorkspaceTrust(cwd: string): void {
  if (!loaded) initWorkspaceTrust()
  if (!cwd || typeof cwd !== 'string') return
  trusted.delete(normalize(cwd))
  save()
}

export function listTrustedWorkspaces(): string[] {
  if (!loaded) initWorkspaceTrust()
  return [...trusted]
}

export function _resetForTest() {
  trusted.clear()
  loaded = false
  storePath = null
}

export interface TrustPromptOptions {
  cwd: string
  reason: string
  parentWindow?: BrowserWindow | null
}

// Show a native dialog asking the user to trust the workspace. Returns
// true if the folder is (now) trusted, false if the user declined.
export async function ensureWorkspaceTrust(opts: TrustPromptOptions): Promise<boolean> {
  if (isWorkspaceTrusted(opts.cwd)) return true
  // In automated tests there's no UI to click; auto-deny so tests that
  // assert on the gate behavior don't hang waiting for a dialog.
  if (process.env.TERMPOLIS_TEST_TRUST === 'deny') return false
  if (process.env.TERMPOLIS_TEST_TRUST === 'allow') {
    trustWorkspace(opts.cwd)
    return true
  }
  const parent = opts.parentWindow ?? null
  const result = parent
    ? await dialog.showMessageBox(parent, buildPrompt(opts))
    : await dialog.showMessageBox(buildPrompt(opts))
  if (result.response === 1) {
    trustWorkspace(opts.cwd)
    return true
  }
  return false
}

function buildPrompt(opts: TrustPromptOptions) {
  return {
    type: 'warning' as const,
    title: 'Trust this workspace?',
    message: 'Do you trust the authors of files in this folder?',
    detail:
      `${opts.cwd}\n\n` +
      `Reason: ${opts.reason}\n\n` +
      `Termpolis will run project scripts (test runners, git hooks, build commands) ` +
      `from this folder on your behalf. Only trust folders you know are safe — ` +
      `malicious repositories can execute arbitrary code during these operations.`,
    buttons: ['Cancel', 'Trust and continue'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
}
