// Pre-context primer — the token-saver. Pulls the most relevant memories for a
// query (typically the user's first ask or the active project) and formats them
// as a shell-paste-safe block that can be injected as an agent's first input,
// so the agent starts already knowing the relevant past context instead of the
// user re-explaining it every session.
//
// When a `project` slug is given, context for THAT project takes precedence: a
// project-scoped search fills the slots first (past conversations ahead of
// code/notes), and remaining global hits are appended under a "may NOT apply"
// label so the agent weighs them correctly. Without `project` the legacy flat
// behavior is unchanged.
//
// Decoupled from the store (search is injected) so it unit-tests cleanly. The
// formatting mirrors the cross-AI handoff prompt: no backticks (AI shells often
// treat them as command substitution), simple dividers, single-line snippets.

export interface PrimerHit {
  content: string
  source?: string
  kind: string
  score: number
  id?: string
  project?: string
}

export type PrimerSearch = (opts: { query: string; limit?: number; project?: string }) => Promise<PrimerHit[]>

export interface PrimerOptions {
  query: string
  limit?: number
  maxSnippetChars?: number
  /** Normalized project slug (e.g. derived from the terminal cwd). Enables current-project precedence. */
  project?: string
}

// Ingested transcript chunks — the "past conversations" the project bucket leads with.
const CONVERSATION_SOURCES = new Set(['claude', 'codex', 'gemini'])

const isConversation = (h: PrimerHit): boolean =>
  h.kind === 'message' && CONVERSATION_SOURCES.has(h.source || '')

const hitKey = (h: PrimerHit): string => h.id || h.content

function renderLine(h: PrimerHit, maxSnip: number): string | null {
  const label = h.source || h.kind || 'note'
  let snip = (h.content || '').replace(/\s+/g, ' ').trim()
  if (!snip) return null
  if (snip.length > maxSnip) snip = snip.slice(0, maxSnip - 3) + '...'
  return `- [${label}] ${snip}`
}

export async function buildContextPrimer(search: PrimerSearch, opts: PrimerOptions): Promise<string | null> {
  if (!opts.query || !opts.query.trim()) return null
  const limit = Math.min(Math.max(opts.limit ?? 6, 1), 20)
  const maxSnip = opts.maxSnippetChars ?? 400
  const project = (opts.project || '').trim().toLowerCase()

  let projectHits: PrimerHit[] = []
  if (project) {
    try { projectHits = (await search({ query: opts.query, limit, project })) || [] } catch { projectHits = [] }
  }
  let globalHits: PrimerHit[] = []
  try {
    globalHits = (await search({ query: opts.query, limit })) || []
  } catch {
    if (projectHits.length === 0) return null
  }

  const body: string[] = []
  if (!project) {
    for (const h of globalHits) {
      const line = renderLine(h, maxSnip)
      if (line) body.push(line)
    }
  } else {
    const seen = new Set(projectHits.map(hitKey))
    // Legacy entries carry no project metadata — promote global hits that are
    // tagged for, or literally mention, this project into the project bucket.
    const promoted: PrimerHit[] = []
    const others: PrimerHit[] = []
    for (const h of globalHits) {
      if (seen.has(hitKey(h))) continue
      seen.add(hitKey(h))
      if (h.project === project || (h.content || '').toLowerCase().includes(project)) promoted.push(h)
      else others.push(h)
    }
    // Past conversations lead the project bucket; the stable sort preserves the
    // score order the search already returned within each class.
    const bucket = [...projectHits, ...promoted]
      .map((h, i) => ({ h, i }))
      .sort((a, b) => (isConversation(b.h) ? 1 : 0) - (isConversation(a.h) ? 1 : 0) || a.i - b.i)
      .map((x) => x.h)

    const projLines: string[] = []
    for (const h of bucket) {
      if (projLines.length >= limit) break
      const line = renderLine(h, maxSnip)
      if (line) projLines.push(line)
    }
    const otherLines: string[] = []
    for (const h of others) {
      if (projLines.length + otherLines.length >= limit) break
      const line = renderLine(h, maxSnip)
      if (line) otherLines.push(line)
    }
    if (projLines.length > 0) body.push(`This project (${project}) — past conversations first:`, ...projLines)
    if (otherLines.length > 0) {
      if (body.length > 0) body.push('')
      body.push('Other saved context (may NOT apply to this project):', ...otherLines)
    }
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
