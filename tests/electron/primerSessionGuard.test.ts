// v1.55.0 Task 4: one memory primer per session. The SessionStart hook loads the digest; a later
// memory_primer call in the same folder gets only the notes the session was not shown yet.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { executeTool } from '../../src/main/mcpServer'
import { buildContextPrimer } from '../../src/main/contextPrimer'
import {
  PRIMER_GUARD_TTL_MS, alreadyLoadedLine, markServed, primerGuardKey, resetPrimerGuard, servedIds,
} from '../../src/main/primerSessionGuard'
import { buildInjectedInstruction } from '../../src/main/headroom/injectedInstruction'
import { foreignPrimerHooks, removeForeignPrimerHooks, hasPrimerHook } from '../../src/main/agentMcpRegistry'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

const topics = ['tokenizer vocab lookups', 'release signing certificates', 'proxy compression ratios', 'swarm conductor retries',
  'memory sync encryption keys', 'git dot cwd tracking', 'installer defender scans', 'pairing wire versions',
  'headroom alarm clocks', 'typing lag on main', 'taskbar shortcut repair', 'notes import manifest']
const rows = topics.map((t, i) => ({ id: `m${i}`, content: `distinct fact number ${i} : ${t}`, score: 0.9 - i * 0.01 }))

// The real primer builder behind the tool, so the ids the guard records are the ones it showed.
const handlers = {
  memoryPrimer: async (opts: { cwd?: string; limit?: number; excludeIds?: ReadonlySet<string> }) => ({
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
