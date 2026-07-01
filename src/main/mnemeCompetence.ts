// mnemeCompetence.ts
//
// Mneme — the persistent self-competence store (Phase 1c). Holds one competence
// record per domain (project | entity | task-type) and folds task outcomes into
// it via the pure mnemeMeta math. Persistence follows the store's append-and-
// replay discipline: every update appends the fresh record as a JSONL line, and
// reload replays them last-write-wins. Best-effort throughout — a persistence
// failure never breaks a task's completion path.

import fs from 'node:fs'
import path from 'node:path'
import { updateCompetence, assessDomain, summarizeCompetence, type CompetenceRecord } from './mnemeMeta'

let records = new Map<string, CompetenceRecord>()
let filePath: string | null = null

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
