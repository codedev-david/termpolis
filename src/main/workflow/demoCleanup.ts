// demoCleanup.ts — removes demo workflows that automation left in a real store.
//
// The screenshot/demo tooling drives the real app, and the app writes workflows
// to whichever project the sidebar is showing. When nothing is open that is the
// home directory, so a demo run can leave its sample workflows in a user's own
// `~/.termpolis/workflows` — where they then show up on every launch.
//
// The tooling no longer does that (it runs against an isolated HOME), but an
// install that was already polluted needs cleaning. This module does exactly
// that, and nothing more: it removes a file ONLY when the file's content is an
// exact match for a workflow the demo tooling is known to generate.
//
// "Exact" means byte-identical after the random ids are stripped — the ids are
// the only part that differs between demo runs. A hand-authored workflow that
// matched would have to be identical step for step, command for command, so
// nothing a user actually wrote can be caught by this.

import { createHash } from 'crypto'
import { join } from 'path'
import type { Workflow } from '../../renderer/src/types'
import { workflowsDir, runsDir, listWorkflowsFull, deleteWorkflow, type FsLike } from './workflowStore'

/** JSON with every object key sorted, so the digest does not depend on YAML key order. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const keys = Object.keys(v as Record<string, unknown>).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`
}

/**
 * Content identity of a workflow, ignoring the ids (which are freshly minted
 * uuids on every save and therefore differ between otherwise-identical files).
 */
export function fingerprint(wf: Workflow): string {
  const steps = (wf.steps ?? []).map(s => {
    const { id: _id, ...rest } = s as unknown as Record<string, unknown>
    return rest
  })
  return createHash('sha256')
    .update(stableStringify({ name: wf.name, version: wf.version, trigger: wf.trigger, steps }))
    .digest('hex')
    .slice(0, 32)
}

/**
 * Fingerprints of the sample workflows the demo tooling generates. Regenerate
 * with `node scripts/demoFingerprints.cjs <dir-of-yml-files>` if the samples
 * ever change; an entry that no longer matches anything is simply inert.
 */
export const DEMO_FINGERPRINTS: ReadonlySet<string> = new Set([
  '845e0f82fca58e02bbc1de7d57519021', // Nightly build & notify
  '075e23755fc11650e6bd8b83c6d7acd8', // Nightly build & notify
  '424742696ffe502f900c2ac1fa9bac37', // Nightly build & notify
  'd048c4f00461206ddf1ac0d99ea77498', // Full-stack feature ship
  '86b6deeab49b26cc175bc6cac0572691', // Full-stack feature ship
])

export type CleanupResult = { removed: string[]; kept: number }

/**
 * Delete every demo workflow (and its run history) from one project's store.
 * Never throws: a store that cannot be read is simply left alone.
 */
export function cleanupDemoWorkflows(
  cwd: string,
  fs: FsLike,
  fingerprints: ReadonlySet<string> = DEMO_FINGERPRINTS,
  log?: (msg: string) => void,
): CleanupResult {
  const removed: string[] = []
  let kept = 0
  let workflows: Workflow[] = []
  const dir = workflowsDir(cwd)
  try {
    workflows = listWorkflowsFull(dir, fs)
  } catch {
    return { removed, kept }
  }
  for (const wf of workflows) {
    if (!fingerprints.has(fingerprint(wf))) {
      kept++
      continue
    }
    try {
      deleteWorkflow(dir, wf.id, fs)
      removed.push(wf.id)
      // The run history is only meaningful for a workflow that still exists.
      const runFile = join(runsDir(cwd), `${wf.id}.jsonl`)
      if (fs.existsSync(runFile)) fs.rmSync(runFile)
    } catch (e) {
      kept++
      log?.(`[workflow] could not remove demo workflow ${wf.id}: ${(e as Error)?.message}`)
    }
  }
  if (removed.length) log?.(`[workflow] removed ${removed.length} leftover demo workflow(s) from ${cwd}`)
  return { removed, kept }
}

type MarkerFs = Pick<FsLike, 'existsSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync'>

/**
 * Run `body` at most once per app version. The marker lives in userData so a
 * reinstall or upgrade re-runs it, and normal launches do not.
 */
export function oncePerVersion(userDataDir: string, version: string, fs: MarkerFs, body: () => void): boolean {
  const marker = join(userDataDir, 'workflow-demo-cleanup.json')
  try {
    if (fs.existsSync(marker)) {
      const seen = JSON.parse(String(fs.readFileSync(marker, 'utf8')))
      if (seen && typeof seen === 'object' && seen.version === version) return false
    }
  } catch {
    // A corrupt marker means "we do not know" — fall through and run once more.
  }
  body()
  try {
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true })
    fs.writeFileSync(marker, JSON.stringify({ version, at: new Date().toISOString() }))
  } catch {
    // Not being able to record the marker only costs us a repeat next launch.
  }
  return true
}
