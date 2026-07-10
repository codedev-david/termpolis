// projectKey.ts — one shared, stable, unique key for a repo/project, derived from its FULL path.
// Shared by the memory store (project scoping) and the code graph (per-repo state) so the SAME
// repo resolves to the SAME key on both sides — the join the memory<->code bridge relies on.
//
// `~/work/acme/api` and `~/work/globex/api` (same basename `api`) never collide. A bare name
// (no path separator) returns undefined: there's nothing to disambiguate on.

import * as crypto from 'crypto'

export function projectKeyOf(pathOrName: string): string | undefined {
  if (typeof pathOrName !== 'string') return undefined
  const t = pathOrName.trim().replace(/[\\/]+$/, '')
  if (!t || !/[\\/]/.test(t)) return undefined // bare name — no full path to key on
  const norm = t.replace(/\\/g, '/').toLowerCase()
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16)
}
