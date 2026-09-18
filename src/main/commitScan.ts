// Commit/Push Secret Shield — scan what git is about to CAPTURE (the staged diff)
// or SEND (every unpushed commit) and block the operation when a secret is found.
//
// WHY this exists: the outbound scanner (aiSecurity.processOutboundChunk) only sees
// text the user types AT an AI. It never sees `git commit`, so a leaked key could
// still land in history and be pushed to a remote — the exact vector our outbound
// redaction was built to stop. This closes it at the git boundary by reusing the
// SAME rule engine (scanText, ~70 rules), so there is one source of truth for
// "what counts as a secret".
//
// Pure + dependency-injected: `git` is a bound safeGit, so the whole gate is unit
// tested without a real repo.

import { scanText } from './aiSecurity'

export interface CommitScanDeps {
  /** Run a git command in the target repo and return stdout.
   *
   *  Sync OR async: since v1.47.1 the real implementation spawns in the procHost utilityProcess and
   *  returns a promise, because the push scan (`git log -p --not --remotes`, unbounded, 120 s
   *  timeout, 512 MB buffer) used to run that entire diff on the thread pumping every PTY. Tests
   *  that hand in a plain string still typecheck and still work. */
  git: (args: string[]) => string | Promise<string>
}

export interface CommitScanResult {
  clean: boolean
  hitCount: number
  hits: { rule: string; label: string; sample: string }[]
  scannedBytes: number
}

function scan(text: string): CommitScanResult {
  const body = text || ''
  const res = scanText(body)
  return { clean: res.hitCount === 0, hitCount: res.hitCount, hits: res.hits, scannedBytes: body.length }
}

/** What `git commit` is about to capture: the staged diff. */
export async function scanStagedDiff(deps: CommitScanDeps): Promise<CommitScanResult> {
  return scan(await deps.git(['diff', '--cached', '--no-color', '--no-ext-diff']))
}

/** What `git push` is about to send: the full patch of every commit not yet on ANY
 *  remote. `log -p --not --remotes` is deliberate — it handles brand-new branches
 *  and root commits, where a naive `@{u}..HEAD` range errors out when there is no
 *  upstream. The push gate is the last line of defence: the commit gate can be
 *  bypassed with `--no-verify`, or the commit may have been made outside Termpolis. */
export async function scanPushRange(deps: CommitScanDeps): Promise<CommitScanResult> {
  return scan(await deps.git(['log', '-p', '--no-color', '--not', '--remotes']))
}

/** A one-line, human-readable reason to surface when a git op is blocked. */
export function blockMessage(res: CommitScanResult, op: 'commit' | 'push'): string {
  const rules = [...new Set(res.hits.map((h) => h.label))].join(', ')
  const plural = res.hitCount === 1 ? 'secret' : 'secrets'
  return `Blocked ${op}: ${res.hitCount} ${plural} detected (${rules}). Remove them, or turn off Commit Shield in Settings → AI Security.`
}
