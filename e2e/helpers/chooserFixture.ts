/**
 * The scratch world e2e/account-chooser.spec.ts runs in, and the one
 * tests/electron/accountsChooserE2eMock.test.ts proves the mock agents against: a test home with a
 * default profile and a second one for each agent, the registry that lists them, and the knobs and
 * log of e2e/mocks/mock-agents.cjs. No sign-in file exists anywhere in it: a profile "is signed in"
 * by the email its `.claude.json` names (Claude Code) or its `.mock-login` holds (Codex).
 *
 * Plain Node only (fs, os, path), so a vitest can import it too.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

/** The ids the seeded registry gives its accounts ('acc_' and 12 hex). */
export const ACCOUNT_IDS = {
  claudeMain: 'acc_a1a1a1a1a1a1',
  claudeSide: 'acc_b2b2b2b2b2b2',
  codexMain: 'acc_c3c3c3c3c3c3',
  codexSide: 'acc_d4d4d4d4d4d4',
  agyOne: 'acc_e5e5e5e5e5e5',
  agyTwo: 'acc_f6f6f6f6f6f6',
} as const

export const EMAILS = {
  claudeMain: 'a@example.test',
  claudeSide: 'b@example.test',
  codexMain: 'x@example.test',
  codexSide: 'y@example.test',
  agyOne: 'g1@example.test',
  agyTwo: 'g2@example.test',
} as const

export const LABELS = {
  claudeMain: 'main',
  claudeSide: 'side',
  codexMain: 'codex-main',
  codexSide: 'codex-side',
  agyOne: 'google-one',
  agyTwo: 'google-two',
} as const

/** The knobs of e2e/mocks/mock-agents.cjs (see its header). */
export interface MockControl {
  turnMs?: number
  limitOn?: string
  menu?: boolean
  ignoreExit?: boolean
  exitDelayMs?: number
  redrawLimit?: boolean
}

export interface MockEvent {
  t: number
  agent: 'claude' | 'codex' | 'agy'
  event: string
  [key: string]: unknown
}

export interface ChooserHome {
  /** TERMPOLIS_TEST_AGENT_HOME. */
  home: string
  /** Where the agents are launched (TERMPOLIS_TEST_PROJECT_CWD). */
  project: string
  claudeSide: string
  codexSide: string
  /** The links made in the home: removed first on teardown, never recursed into. */
  links: string[]
}

const SHIM_DIR = path.resolve('e2e', 'test-shims-chooser')

/** The shim folder that puts the mock agents first on PATH, with the PATH to launch the app with. */
export function chooserShimEnv(): { TERMPOLIS_TEST_SHIM_DIR: string; PATH: string } {
  for (const f of ['claude', 'codex', 'agy']) {
    // The Unix shims lose their +x bit through some npm/git paths.
    try { fs.chmodSync(path.join(SHIM_DIR, f), 0o755) } catch { /* windows / already set */ }
  }
  const sep = process.platform === 'win32' ? ';' : ':'
  return { TERMPOLIS_TEST_SHIM_DIR: SHIM_DIR, PATH: `${SHIM_DIR}${sep}${process.env.PATH ?? ''}` }
}

/** A folder link Node can remove without touching what it points at: a junction on Windows. */
export function linkDir(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

/** Removes a link and nothing behind it. A real folder is never removed by this. */
export function unlinkDir(link: string): void {
  let st: fs.Stats
  try { st = fs.lstatSync(link) } catch { return }
  if (!st.isSymbolicLink()) return
  try { fs.rmdirSync(link) } catch { fs.unlinkSync(link) }
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/** Claude Code's `.claude.json` of a profile signed in as `email` (or signed out: `null`). */
export function setClaudeSignIn(file: string, email: string | null): void {
  write(file, JSON.stringify(email ? { hasCompletedOnboarding: true, oauthAccount: { emailAddress: email } } : { hasCompletedOnboarding: true }))
}

/** A Codex profile signed in as `email` (`codex login status` says so), or signed out. */
export function setCodexSignIn(profile: string, email: string | null): void {
  const file = path.join(profile, '.mock-login')
  if (email) write(file, email)
  else fs.rmSync(file, { force: true })
}

export function makeChooserHome(): ChooserHome {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-chooser-home-'))
  write(path.join(home, '.mock-agent-home'), 'the mock agents act only in a folder holding this file\n')
  const project = path.join(home, 'project')
  fs.mkdirSync(project)
  // Claude Code: the default profile (its .claude.json sits beside the folder) and a second one.
  fs.mkdirSync(path.join(home, '.claude'))
  setClaudeSignIn(path.join(home, '.claude.json'), EMAILS.claudeMain)
  const claudeSide = path.join(home, '.claude-b')
  fs.mkdirSync(claudeSide)
  setClaudeSignIn(path.join(claudeSide, '.claude.json'), EMAILS.claudeSide)
  // Codex: the default profile and a second one that shares its sessions folder through a link,
  // as Termpolis makes one (so `codex resume <id>` on the second finds the first one's rollout).
  const codexMain = path.join(home, '.codex')
  fs.mkdirSync(path.join(codexMain, 'sessions'), { recursive: true })
  setCodexSignIn(codexMain, EMAILS.codexMain)
  const codexSide = path.join(home, '.codex-b')
  fs.mkdirSync(codexSide)
  setCodexSignIn(codexSide, EMAILS.codexSide)
  const sessionsLink = path.join(codexSide, 'sessions')
  linkDir(path.join(codexMain, 'sessions'), sessionsLink)
  // agy: one Google sign-in for the computer user.
  write(path.join(home, '.mock-agy.json'), JSON.stringify({ signedIn: true, email: EMAILS.agyOne }))
  return { home, project, claudeSide, codexSide, links: [sessionsLink] }
}

/** Removes the home. Every link in it goes first, so nothing is ever removed through one. */
export function removeChooserHome(h: ChooserHome): void {
  for (const l of h.links) unlinkDir(l)
  try { fs.rmSync(h.home, { recursive: true, force: true }) } catch { /* a handle still open on Windows */ }
}

/** The registry Termpolis starts with: two accounts for each agent, the first of each the default. */
export function seedRegistry(userData: string, h: ChooserHome): void {
  const base = { autoOffer: true, connect: false, links: [] as unknown[] }
  const accounts = [
    { ...base, id: ACCOUNT_IDS.claudeMain, agent: 'claude', label: LABELS.claudeMain, email: EMAILS.claudeMain, profile: null, order: 0, origin: 'label' },
    { ...base, id: ACCOUNT_IDS.claudeSide, agent: 'claude', label: LABELS.claudeSide, email: EMAILS.claudeSide, profile: h.claudeSide, order: 1, origin: 'adopted' },
    { ...base, id: ACCOUNT_IDS.codexMain, agent: 'codex', label: LABELS.codexMain, email: EMAILS.codexMain, profile: null, order: 0, origin: 'label' },
    { ...base, id: ACCOUNT_IDS.codexSide, agent: 'codex', label: LABELS.codexSide, email: EMAILS.codexSide, profile: h.codexSide, order: 1, origin: 'adopted' },
    { ...base, id: ACCOUNT_IDS.agyOne, agent: 'agy', label: LABELS.agyOne, email: EMAILS.agyOne, profile: null, order: 0, origin: 'label' },
    { ...base, id: ACCOUNT_IDS.agyTwo, agent: 'agy', label: LABELS.agyTwo, email: EMAILS.agyTwo, profile: null, order: 1, origin: 'label' },
  ]
  const doc = {
    version: 1,
    accounts,
    preferred: { claude: ACCOUNT_IDS.claudeMain, codex: ACCOUNT_IDS.codexMain, agy: ACCOUNT_IDS.agyOne },
    chooser: true,
    cooldownSec: {},
    limits: {},
    identity: {},
  }
  write(path.join(userData, 'agent-accounts.json'), JSON.stringify(doc, null, 2) + '\n')
}

/** The registry as Termpolis last saved it. */
export function readRegistry(userData: string): { limits: Record<string, { text?: string; resetsAt?: number | null }>; identity: Record<string, unknown> } {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(userData, 'agent-accounts.json'), 'utf8'))
    return { limits: doc.limits ?? {}, identity: doc.identity ?? {} }
  } catch {
    return { limits: {}, identity: {} }
  }
}

export function setMockControl(h: ChooserHome, control: MockControl): void {
  write(path.join(h.home, '.mock-control.json'), JSON.stringify(control))
}

export function readMockLog(h: ChooserHome): MockEvent[] {
  try {
    return fs.readFileSync(path.join(h.home, '.mock-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as MockEvent)
  } catch {
    return []
  }
}
