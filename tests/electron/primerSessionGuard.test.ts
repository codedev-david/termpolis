// v1.55.0 Task 4: one memory primer per session. The SessionStart hook loads the digest; a later
// memory_primer call in the same folder gets only the notes the session was not shown yet.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { executeTool } from '../../src/main/mcpServer'
import { buildContextPrimer } from '../../src/main/contextPrimer'
import {
  PRIMER_GUARD_TTL_MS, alreadyLoadedLine, markServed, primerGuardKey, resetPrimerGuard, servedIds,
  armOf, onFirstPrompt, sessionArm, PROMPT_PRIMER_LIMIT, claimFirstPrompt, claimOffer, emitFirstPrompt,
} from '../../src/main/primerSessionGuard'
import { buildInjectedInstruction } from '../../src/main/headroom/injectedInstruction'
import { foreignPrimerHooks, removeForeignPrimerHooks, hasPrimerHook, applyPrimerHook, removePrimerHooks } from '../../src/main/agentMcpRegistry'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

const topics = ['tokenizer vocab lookups', 'release signing certificates', 'proxy compression ratios', 'swarm conductor retries',
  'memory sync encryption keys', 'git dot cwd tracking', 'installer defender scans', 'pairing wire versions',
  'headroom alarm clocks', 'typing lag on main', 'taskbar shortcut repair', 'notes import manifest']
const rows = topics.map((t, i) => ({ id: `m${i}`, content: `distinct fact number ${i} : ${t}`, score: 0.9 - i * 0.01 }))

// The real primer builder behind the tool, so the ids the guard records are the ones it showed.
const calls: Array<{ query?: string; limit?: number; focused?: boolean }> = []
const handlers = {
  memoryPrimer: async (opts: { cwd?: string; query?: string; limit?: number; excludeIds?: ReadonlySet<string>; focused?: boolean }) => (calls.push(opts), {
    project: null,
    primer: await buildContextPrimer(async () => rows, {
      query: 'facts', limit: opts.limit ?? 5, fileExists: () => true,
      ...(opts.excludeIds ? { excludeIds: opts.excludeIds } : {}),
    }),
  }),
} as unknown as Parameters<typeof executeTool>[2]

const shown = (text: string | null | undefined): number[] =>
  rows.map((_, i) => i).filter((i) => (text ?? '').includes(`distinct fact number ${i} `))

describe('one memory primer per session', () => {
  beforeEach(() => resetPrimerGuard())

  it('second primer in the same session returns only unseen ids', async () => {
    const first = await executeTool('memory_primer', { cwd: '/repo', limit: 5, source: 'session-start' }, handlers) as { primer: string }
    const firstShown = shown(first.primer)
    expect(firstShown).toHaveLength(5)
    expect(first.primer).not.toContain('Memory already loaded')

    const second = await executeTool('memory_primer', { cwd: '/repo', limit: 5 }, handlers) as { primer: string }
    expect(second.primer.startsWith(alreadyLoadedLine(5))).toBe(true)
    const secondShown = shown(second.primer)
    expect(secondShown.length).toBeGreaterThan(0)
    for (const i of secondShown) expect(firstShown).not.toContain(i)
  })

  it('a new session start shows the full digest again', async () => {
    await executeTool('memory_primer', { cwd: '/repo', limit: 5, source: 'session-start' }, handlers)
    const again = await executeTool('memory_primer', { cwd: '/repo', limit: 5, source: 'session-start' }, handlers) as { primer: string }
    expect(again.primer).not.toContain('Memory already loaded')
    expect(shown(again.primer)).toEqual([0, 1, 2, 3, 4])
  })

  it('another folder is another session', async () => {
    await executeTool('memory_primer', { cwd: '/repo', limit: 5, source: 'session-start' }, handlers)
    const other = await executeTool('memory_primer', { cwd: '/other', limit: 5 }, handlers) as { primer: string }
    expect(other.primer).not.toContain('Memory already loaded')
  })

  it('what a session was shown expires after the TTL', () => {
    const key = primerGuardKey('/repo')
    markServed(key, ['a', 'b'], 1000)
    expect([...servedIds(key, 1000 + PRIMER_GUARD_TTL_MS - 1)]).toEqual(['a', 'b'])
    expect(servedIds(key, 1000 + PRIMER_GUARD_TTL_MS + 1).size).toBe(0)
    markServed(key, ['a'], 0)
    markServed(key, ['c', ''], PRIMER_GUARD_TTL_MS + 5) // the old record has expired: only 'c' counts
    expect([...servedIds(key, PRIMER_GUARD_TTL_MS + 6)]).toEqual(['c'])
    expect(primerGuardKey('  ')).toBe('|')
  })
})

describe('the launch instruction and the hook', () => {
  it('launch instruction no longer says call memory_primer when the hook is installed', () => {
    const without = buildInjectedInstruction({ cwd: '/repo', steering: false })
    const withHook = buildInjectedInstruction({ cwd: '/repo', steering: false, hookInstalled: true })
    expect(without).toContain('When you begin working, call the termpolis MCP tool memory_primer')
    expect(withHook).not.toContain('When you begin working')
    expect(withHook).not.toContain('call memory_primer once more')
    expect(withHook).toContain('only if no memory digest is in your context')
    expect(buildInjectedInstruction({ cwd: '/repo', steering: false, hookInstalled: true })).toBe(withHook)
  })

  it('foreign primer hooks are found', () => {
    const settings = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/memory-primer.sh' }] },
          { hooks: [{ type: 'command', command: 'node "C:/x/mcp-adapter/memory-primer-hook.cjs"' }] },
          { hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/permissions_guard.sh' }] },
        ],
      },
    }
    expect(foreignPrimerHooks(settings)).toEqual(['bash ~/.claude/hooks/memory-primer.sh'])
    expect(removeForeignPrimerHooks(settings)).toBe('remove')
    expect(foreignPrimerHooks(settings)).toEqual([])
    expect(hasPrimerHook(settings)).toBe(true)
    expect(settings.hooks.SessionStart).toHaveLength(2)
    expect(removeForeignPrimerHooks(settings)).toBe('unchanged')
  })
})

const sessionIn = (arm: 'focused' | 'holdout'): string => {
  for (let i = 0; ; i++) if (armOf(`session-${i}`) === arm) return `session-${i}`
}
const ask = (sessionId: string, query = 'how does the release workflow sign the windows installer today'): Promise<{ primer: string | null }> =>
  executeTool('memory_primer', { cwd: '/repo', query, limit: 6, source: 'prompt', sessionId }, handlers) as Promise<{ primer: string | null }>

describe('the first-prompt primer', () => {
  beforeEach(() => { resetPrimerGuard(); calls.length = 0 })

  it('first substantive prompt gets a focused primer without repeats', async () => {
    const start = await executeTool('memory_primer', { cwd: '/repo', limit: 5, source: 'session-start' }, handlers) as { primer: string }
    const startShown = shown(start.primer)
    const id = sessionIn('focused')
    const first = await ask(id)
    expect(calls.at(-1)).toMatchObject({ focused: true, limit: PROMPT_PRIMER_LIMIT, query: 'how does the release workflow sign the windows installer today' })
    const firstShown = shown(first.primer)
    expect(firstShown.length).toBeGreaterThan(0)
    for (const i of firstShown) expect(startShown).not.toContain(i)
    expect(first.primer).not.toContain('Memory already loaded')

    const before = calls.length
    expect((await ask(id)).primer).toBeNull() // a second prompt in the same session gets nothing
    expect(calls.length).toBe(before)
  })

  it('a prompt with no session id or no query gets nothing', async () => {
    expect((await ask('')).primer).toBeNull()
    expect((await ask(sessionIn('focused'), '   ')).primer).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('a holdout session gets no notes but is tagged, and the first prompt still reaches listeners', async () => {
    const heard: string[] = []
    const off = onFirstPrompt((sid, prompt) => heard.push(`${sid}:${prompt.split(' ')[0]}`))
    const id = sessionIn('holdout')
    expect((await ask(id)).primer).toBeNull()
    expect(calls).toHaveLength(0)
    expect(sessionArm(id)).toBe('holdout')
    await ask(sessionIn('focused'))
    expect(heard).toEqual([`${id}:how`, `${sessionIn('focused')}:how`])
    off()
  })

  it('a short first prompt reaches listeners without notes; the next long one still gets its primer, with no second offer', async () => {
    const heard: string[] = []
    const off = onFirstPrompt((_sid, prompt, _cwd, terminalId, afterCompact) => heard.push(`${prompt}|${terminalId ?? ''}|${afterCompact ?? ''}`))
    const id = sessionIn('focused')
    const short = await executeTool('memory_primer', { cwd: '/repo', query: 'fix the typo', source: 'prompt', sessionId: id, prime: false, terminalId: 'term-1' }, handlers) as { primer: string | null }
    expect(short.primer).toBeNull()
    expect(calls).toHaveLength(0)
    expect(heard).toEqual(['fix the typo|term-1|'])
    expect((await ask(id)).primer).not.toBeNull()
    expect(heard).toHaveLength(1)
    off()
  })

  it('PostCompact offers a reroute with turns=0: the last prompt reaches listeners after every compaction, with no notes', async () => {
    const heard: Array<boolean | undefined> = []
    const off = onFirstPrompt((_sid, _p, _cwd, _t, afterCompact) => heard.push(afterCompact))
    const id = sessionIn('focused')
    await ask(id)
    const compact = (): Promise<{ primer: string | null }> =>
      executeTool('memory_primer', { cwd: '/repo', query: 'design the plugin layer', source: 'post-compact', sessionId: id }, handlers) as Promise<{ primer: string | null }>
    const before = calls.length
    expect((await compact()).primer).toBeNull()
    expect((await compact()).primer).toBeNull()
    expect(calls.length).toBe(before)
    expect(heard).toEqual([undefined, true, true])
    expect((await executeTool('memory_primer', { cwd: '/repo', query: 'x', source: 'post-compact' }, handlers) as { primer: null }).primer).toBeNull()
    expect(heard).toHaveLength(3)
    off()
  })

  it('the offer is claimed once a day per session, and the oldest of too many is forgotten', () => {
    expect(claimOffer('', 0)).toBe(false)
    expect(claimOffer('o', 0)).toBe(true)
    expect(claimOffer('o', 1000)).toBe(false)
    expect(claimOffer('o', 25 * 60 * 60 * 1000)).toBe(true)
    for (let i = 0; i < 201; i++) claimOffer(`o-${i}`, 5)
    expect(claimOffer('o', 25 * 60 * 60 * 1000 + 1000)).toBe(true)
  })

  it('about one session in ten is in the holdout, and a session never changes arm', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `s${i}`)
    const held = ids.filter((id) => armOf(id) === 'holdout').length
    expect(held).toBeGreaterThan(140)
    expect(held).toBeLessThan(260)
    expect(armOf('abc')).toBe(armOf('abc'))
  })

  it('the first-prompt hook is added and removed on its own event', () => {
    const settings: Record<string, any> = {}
    expect(applyPrimerHook(settings, 'node "/x/mcp-adapter/memory-primer-hook.cjs"')).toBe('add')
    expect(applyPrimerHook(settings, 'node "/x/mcp-adapter/memory-primer-hook.cjs"', 'UserPromptSubmit')).toBe('add')
    expect(hasPrimerHook(settings, 'UserPromptSubmit')).toBe(true)
    expect(removePrimerHooks(settings, ['UserPromptSubmit'])).toBe('remove')
    expect(hasPrimerHook(settings)).toBe(true)
    expect(settings.hooks.UserPromptSubmit).toBeUndefined()
    applyPrimerHook(settings, 'node "/x/mcp-adapter/memory-primer-hook.cjs"', 'UserPromptSubmit')
    expect(removePrimerHooks(settings)).toBe('remove') // a disconnect takes both
    expect(settings.hooks).toBeUndefined()
  })

  it('a session is asked again after a day, the oldest of too many is forgotten, and a failing listener is skipped', () => {
    expect(claimFirstPrompt('day', 0)).toBe(true)
    expect(claimFirstPrompt('day', 1000)).toBe(false)
    expect(claimFirstPrompt('day', 25 * 60 * 60 * 1000)).toBe(true)
    for (let i = 0; i < 201; i++) claimFirstPrompt(`many-${i}`, 5)
    expect(sessionArm('day')).toBeNull()
    expect(sessionArm('never')).toBeNull()
    const heard: string[] = []
    onFirstPrompt(() => { throw new Error('boom') })
    onFirstPrompt((sid) => heard.push(sid))
    emitFirstPrompt('s', 'q', undefined)
    expect(heard).toEqual(['s'])
  })

  it('a hook list of the wrong shape is reported, and left as it is', () => {
    const settings: Record<string, any> = { hooks: { UserPromptSubmit: {} } }
    expect(removePrimerHooks(settings)).toEqual({ skipped: '`hooks.UserPromptSubmit` is not an array' })
    expect(settings.hooks.UserPromptSubmit).toEqual({})
  })
})
