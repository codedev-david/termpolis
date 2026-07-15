// mnemeCompetence.ts
//
// Mneme — the persistent self-competence store (Phase 1c). Holds one competence
// record per domain (project | entity | task-type) and folds task outcomes into
// it via the pure mnemeMeta math. Persistence follows the store's append-and-
// replay discipline: every update appends the fresh record as a JSONL line, and
// reload replays them last-write-wins. Best-effort throughout — a persistence
// failure never breaks a task's completion path.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { updateCompetence, assessDomain, summarizeCompetence, type CompetenceRecord } from './mnemeMeta'

let records = new Map<string, CompetenceRecord>()
let filePath: string | null = null

/** The basename of the user's home directory, lowercased — i.e. their ACCOUNT NAME. Before v1.26.2
 *  a terminal opened in ~ was normalized to this as a "project", and a project IS a competence
 *  domain (mnemeReflex), so the brain recorded competence in a domain named after the user.
 *  normalizeProjectSlug now rejects home (see swarmMemory), but the record already written can never
 *  be legitimately reproduced — yet it replays on every load. '' when it can't be resolved. */
function homeDomain(): string {
  try {
    return (os.homedir() || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.trim().toLowerCase() || ''
  } catch {
    return ''
  }
}

/** Rewrite the sidecar to exactly the current in-memory records (one line each). Best-effort: a
 *  failed rewrite just means the dropped/collapsed lines are re-processed on the next load. */
function rewriteRecords(): void {
  if (!filePath) return
  try {
    const body = Array.from(records.values()).map((r) => JSON.stringify(r)).join('\n')
    fs.writeFileSync(filePath, body ? body + '\n' : '')
  } catch {
    /* best effort — the in-memory map is already correct for this session */
  }
}

/** Load the competence sidecar from `dir` (idempotent; safe to call on startup). */
export function initCompetence(dir: string): void {
  records = new Map()
  filePath = path.join(dir, 'mneme-competence.jsonl')
  try {
    if (fs.existsSync(filePath)) {
      for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const r = JSON.parse(t) as CompetenceRecord
          if (r && r.domain) records.set(r.domain, r) // later line wins
        } catch {
          /* skip a corrupt line */
        }
      }
    }
  } catch {
    /* best effort — start empty if the sidecar can't be read */
  }
  // One-time migration: drop the account-name domain (see homeDomain). Its only remaining effect is
  // a dashboard bar labelled with the user's own name and a "low competence in <name>" line atop
  // every agent primer. Rewrite the sidecar so the dead record doesn't resurrect next launch. (A
  // real repo named exactly like the account is not producible via home anymore, so this is safe.)
  const home = homeDomain()
  if (home && records.delete(home)) rewriteRecords()
}

/** Fold one task outcome into the domain's competence and persist it. */
export function recordOutcome(domain: string, success: boolean, now: number): CompetenceRecord {
  const next = updateCompetence(records.get(domain), domain, success, now)
  records.set(domain, next)
  if (filePath) {
    try {
      fs.appendFileSync(filePath, JSON.stringify(next) + '\n')
    } catch {
      /* best effort — the in-memory record is still updated */
    }
  }
  return next
}

/** How reliable are we in this domain? (calibrated confidence + verdict) */
export function assessCompetence(domain: string) {
  return assessDomain(Array.from(records.values()), domain)
}

/** A short digest of the weakest domains, for injection into the memory primer. */
export function competenceSummary(limit?: number): string {
  return summarizeCompetence(Array.from(records.values()), limit)
}

/** All competence records — for the curiosity layer (knowledge-gap finding). */
export function competenceRecords(): CompetenceRecord[] {
  return Array.from(records.values())
}

// --- test seam ---
export function _resetCompetenceForTests(): void {
  records = new Map()
  filePath = null
}
