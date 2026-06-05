// Pre-context primer — the token-saver. Pulls the most relevant memories for a
// query (typically the user's first ask or the active project) and formats them
// as a shell-paste-safe block that can be injected as an agent's first input,
// so the agent starts already knowing the relevant past context instead of the
// user re-explaining it every session.
//
// Decoupled from the store (search is injected) so it unit-tests cleanly. The
// formatting mirrors the cross-AI handoff prompt: no backticks (AI shells often
// treat them as command substitution), simple dividers, single-line snippets.

export interface PrimerHit {
  content: string
  source?: string
  kind: string
  score: number
}

export type PrimerSearch = (opts: { query: string; limit?: number }) => Promise<PrimerHit[]>

export interface PrimerOptions {
  query: string
  limit?: number
  maxSnippetChars?: number
}

export async function buildContextPrimer(search: PrimerSearch, opts: PrimerOptions): Promise<string | null> {
  if (!opts.query || !opts.query.trim()) return null
  const limit = Math.min(Math.max(opts.limit ?? 6, 1), 20)
  const maxSnip = opts.maxSnippetChars ?? 400

  let hits: PrimerHit[]
  try {
    hits = await search({ query: opts.query, limit })
  } catch {
    return null
  }
  if (!hits || hits.length === 0) return null

  const body: string[] = []
  for (const h of hits) {
    const label = h.source || h.kind || 'note'
    let snip = (h.content || '').replace(/\s+/g, ' ').trim()
    if (!snip) continue
    if (snip.length > maxSnip) snip = snip.slice(0, maxSnip - 3) + '...'
    body.push(`- [${label}] ${snip}`)
  }
  if (body.length === 0) return null

  return [
    'Relevant context from your memory (most relevant first) — background only:',
    '',
    ...body,
    '',
    'Continue the task; use the above as background and do not re-ask the user for it.',
  ].join('\n')
}
