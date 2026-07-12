// Import trust gate — approve-once for third-party skills/plugins/MCP servers.
//
// Safe Import lets a user pull an artifact someone else wrote — a skill, a
// slash command, a subagent, an MCP server, a plugin — and wire it into their
// agents. That artifact is not inert data: a skill body is instructions an AI
// agent will follow, and an MCP server is a process Termpolis will *execute*.
// So it gets the same deal as an untrusted workspace: nothing is wired in
// until the user says yes, and the yes is remembered so we stop nagging.
//
// The one thing this does that workspaceTrust doesn't: identity is the SHA-256
// of the CONTENT, never the name. A name-keyed allow-list is trust-on-first-use
// — approve "pretty-linter" once, and the author (or whoever controls that repo
// *now*) can swap the body for a credential exfiltrator on the next pull and it
// stays approved forever. Hashing the content means one changed byte
// invalidates the approval and the user is re-prompted. That is the entire
// point of this file; everything else here is bookkeeping around it.
//
// RED-risk artifacts are never approvable — not by the user, not by a hand-edit
// of the store. approveArtifact throws. A gate you can click through is a speed
// bump, and "user clicks through the scary dialog" is exactly the attack a
// feature like Safe Import invites.

import { existsSync, mkdirSync, readFileSync } from 'fs'
import { createHash } from 'crypto'
import { dirname, join } from 'path'
import { writeSecureFile } from './secureFile'

const STORE_FILE = 'imported-artifacts.json'

const KINDS = new Set(['skill', 'command', 'subagent', 'mcp', 'plugin'])

export interface ImportedArtifact {
  /** Stable id, e.g. the artifact name. One id == one current approval. */
  id: string
  name: string
  kind: 'skill' | 'command' | 'subagent' | 'mcp' | 'plugin'
  /** sha256 of the artifact content — the thing trust is actually keyed on. */
  hash: string
  approvedAt: number
  riskLevel: 'green' | 'yellow' | 'red'
  /** Which agents it was wired into, e.g. ['claude','codex']. */
  targets: string[]
}

export interface ImportTrustDeps {
  readFile: (p: string) => string | null
  writeFile: (p: string, data: string) => void
  now: () => number
}

// Real fs, injected by default. Tests swap this out so they never touch disk.
const realDeps: ImportTrustDeps = {
  readFile: (p) => {
    try {
      return existsSync(p) ? readFileSync(p, 'utf-8') : null
    } catch {
      // Unreadable (EISDIR, EACCES, a locked file mid-sync) reads as "no
      // approvals". Fail closed — worst case the user re-approves.
      return null
    }
  },
  writeFile: (p, data) => {
    const dir = dirname(p)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // Same lockdown as trusted-workspaces.json: this file isn't a secret, but
    // it IS a control — anyone who can write it can pre-approve a hash.
    writeSecureFile(p, data)
  },
  now: () => Date.now(),
}

let deps: ImportTrustDeps = realDeps
let storePath: string | null = null
// id -> current approval. Keying by id (not hash) is what makes an update
// *supersede* its predecessor instead of piling up a second trusted hash —
// otherwise reverting to old approved content would be a free downgrade.
const approved = new Map<string, ImportedArtifact>()

export function initImportTrust(dir: string, overrides?: Partial<ImportTrustDeps>): void {
  deps = { ...realDeps, ...(overrides ?? {}) }
  storePath = join(dir, STORE_FILE)
  approved.clear()

  let raw: string | null = null
  try {
    raw = deps.readFile(storePath)
  } catch {
    // A reader that throws must not brick startup.
    raw = null
  }
  if (!raw) return

  try {
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed?.artifacts) ? parsed.artifacts : []
    for (const item of list) {
      const entry = coerce(item)
      if (entry) approved.set(entry.id, entry)
    }
  } catch {
    // Corrupt store — treat as empty. We don't throw: a broken file must not
    // wedge the app, and an empty allow-list only costs the user a re-prompt.
  }
}

// Validate anything coming off disk. The JSON is a plain file in userData —
// not a trust boundary we own — so a hand-edited red entry, a bogus kind, or
// a missing hash is dropped rather than honored.
function coerce(item: unknown): ImportedArtifact | null {
  if (!item || typeof item !== 'object') return null
  const raw = item as Record<string, unknown>
  const { id, name, kind, hash, approvedAt, riskLevel, targets } = raw
  if (typeof id !== 'string' || !id) return null
  if (typeof hash !== 'string' || !hash) return null
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null
  // Anything that isn't explicitly green/yellow is refused — that covers a
  // smuggled-in 'red' and any garbage value in one check.
  if (riskLevel !== 'green' && riskLevel !== 'yellow') return null
  return {
    id,
    name: typeof name === 'string' && name ? name : id,
    kind: kind as ImportedArtifact['kind'],
    hash,
    approvedAt: typeof approvedAt === 'number' && Number.isFinite(approvedAt) ? approvedAt : 0,
    riskLevel,
    targets: Array.isArray(targets) ? targets.filter((t): t is string => typeof t === 'string') : [],
  }
}

function save(): void {
  if (!storePath) return
  try {
    deps.writeFile(storePath, JSON.stringify({ artifacts: [...approved.values()] }, null, 2))
  } catch {
    // Best-effort: approvals stay in memory for this session. A store we can't
    // write is not a reason to fail the user's import.
  }
}

/** sha256 hex of the concatenated, path-sorted artifact contents — stable + order-independent. */
export function artifactHash(files: { path: string; content: string }[]): string {
  // Sort on raw code units, NOT localeCompare — locale-sensitive ordering would
  // make the same artifact hash differently on two machines.
  const sorted = [...files].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    // Tiebreak on content so even the pathological duplicate-path case is
    // order-independent.
    return a.content < b.content ? -1 : a.content > b.content ? 1 : 0
  })

  const h = createHash('sha256')
  for (const f of sorted) {
    // Netstring-style length framing. Plain concatenation is ambiguous —
    // (a:"1", b:"2") and (a:"12", b:"") would produce identical bytes, so an
    // attacker could shuffle content across the file boundary without moving
    // the hash. Prefixing each field with its byte length makes the split
    // unforgeable.
    const path = Buffer.from(f.path, 'utf-8')
    const content = Buffer.from(f.content, 'utf-8')
    h.update(`${path.length}:`)
    h.update(path)
    h.update(`${content.length}:`)
    h.update(content)
  }
  return h.digest('hex')
}

export function isApproved(hash: string): boolean {
  if (!hash || typeof hash !== 'string') return false
  for (const a of approved.values()) {
    if (a.hash === hash) return true
  }
  return false
}

export function approveArtifact(a: Omit<ImportedArtifact, 'approvedAt'>): ImportedArtifact {
  // The hard invariant. Red means the scanner found something that reads
  // credentials, exfiltrates, or runs arbitrary shell — there is no
  // "I know what I'm doing" path out of it.
  if (a.riskLevel === 'red') {
    throw new Error(
      `Refusing to approve red-risk artifact "${a.name || a.id}" — red-risk imports are never trusted`,
    )
  }
  // An empty hash would make isApproved('') true for everything downstream, so
  // a caller that forgot to hash gets an error, not a blanket approval.
  if (!a.id || typeof a.id !== 'string') throw new Error('Cannot approve an artifact with no id')
  if (!a.hash || typeof a.hash !== 'string') throw new Error(`Cannot approve artifact "${a.id}" with no content hash`)

  const entry: ImportedArtifact = {
    id: a.id,
    name: a.name || a.id,
    kind: a.kind,
    hash: a.hash,
    approvedAt: deps.now(),
    riskLevel: a.riskLevel,
    // Copy — the caller must not keep a handle on our stored array.
    targets: Array.isArray(a.targets) ? [...a.targets] : [],
  }
  // Replaces any prior approval of this id, retiring the old hash with it.
  approved.set(entry.id, entry)
  save()
  return entry
}

export function revokeArtifact(id: string): boolean {
  const existed = approved.delete(id)
  if (existed) save()
  return existed
}

export function listImported(): ImportedArtifact[] {
  // Copies: a caller mutating the returned records must not be able to edit a
  // stored hash into existence.
  return [...approved.values()].map((a) => ({ ...a, targets: [...a.targets] }))
}

export function _resetImportTrustForTests(): void {
  approved.clear()
  storePath = null
  deps = realDeps
}
