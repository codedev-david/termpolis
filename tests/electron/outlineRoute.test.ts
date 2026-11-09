// v1.55.0 Task 12: the outline hint on a large whole-file Read.
import { describe, it, expect, beforeEach, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))
const { executeTool } = await import('../../src/main/mcpServer')
import type { McpToolHandlers } from '../../src/main/mcpServer'
import { outlineHint, countLinesIn, OUTLINE_MIN_FILE_LINES, OUTLINE_MAX_LINES } from '../../src/main/outlineHint'
import { armOf } from '../../src/main/primerSessionGuard'
import { indexFileContent, fileSymbols, _resetCodeGraphForTests, type SymbolHit } from '../../src/main/codeGraph'
import { applyPrimerHook } from '../../src/main/agentMcpRegistry'

const sessionIn = (arm: 'focused' | 'holdout'): string => {
  for (let i = 0; ; i++) if (armOf(`s-${i}`) === arm) return `s-${i}`
}
const sym = (name: string, startLine: number): SymbolHit => ({ id: `f#${name}@${startLine}`, name, kind: 'function', file: '/repo/big.ts', startLine, endLine: startLine + 9, lang: 'typescript' })
const deps = (symbols: SymbolHit[], lines: number | null) => ({ symbols: () => symbols, countLines: async () => lines })

describe('outlineHint', () => {
  it('outline added for a large unbounded Read, symbols in line order', async () => {
    const hint = await outlineHint({ path: '/repo/big.ts', sessionId: sessionIn('focused') }, deps([sym('b', 900), sym('a', 10)], 2400))
    expect(hint).toBe('[Termpolis] This file has 2400 lines. Its outline from the code index, for reading a part with offset and limit next time:\na function (10-19)\nb function (900-909)')
  })

  it(`lists at most ${OUTLINE_MAX_LINES} symbols and says how many more`, async () => {
    const many = Array.from({ length: OUTLINE_MAX_LINES + 5 }, (_, i) => sym(`f${i}`, i * 30 + 1))
    const hint = (await outlineHint({ path: '/repo/big.ts', sessionId: sessionIn('focused') }, deps(many, 5000)))!
    expect(hint.split('\n')).toHaveLength(OUTLINE_MAX_LINES + 2)
    expect(hint.endsWith('… 5 more symbols (code_explore lists them)')).toBe(true)
  })

  it('nothing for small files, unindexed or unreadable files, holdout, or a bad ask', async () => {
    const focused = sessionIn('focused')
    expect(await outlineHint({ path: '/repo/big.ts', sessionId: focused }, deps([sym('a', 1)], OUTLINE_MIN_FILE_LINES))).toBeNull()
    expect(await outlineHint({ path: '/repo/big.ts', sessionId: focused }, deps([], 9000))).toBeNull()
    expect(await outlineHint({ path: '/repo/big.ts', sessionId: focused }, deps([sym('a', 1)], null))).toBeNull()
    expect(await outlineHint({ path: '/repo/big.ts', sessionId: sessionIn('holdout') }, deps([sym('a', 1)], 9000))).toBeNull()
    expect(await outlineHint({ path: '/repo/big.ts' }, deps([sym('a', 1)], 9000))).toBeNull()
    expect(await outlineHint({ path: 7, sessionId: focused }, deps([sym('a', 1)], 9000))).toBeNull()
  })

  it('counts lines with or without a last newline', () => {
    expect(countLinesIn(Buffer.from(''))).toBe(0)
    expect(countLinesIn(Buffer.from('a'))).toBe(1)
    expect(countLinesIn(Buffer.from('a\nb\n'))).toBe(2)
    expect(countLinesIn(Buffer.from('a\r\nb'))).toBe(2)
  })
})

describe('fileSymbols', () => {
  beforeEach(() => _resetCodeGraphForTests())

  it('finds an indexed file by path, ignoring case and slash direction', () => {
    indexFileContent('C:\\Repo\\src\\a.ts', 'export function alpha() {\n  return 1\n}\n')
    expect(fileSymbols('C:\\Repo\\src\\a.ts').map((s) => s.name)).toEqual(['alpha'])
    expect(fileSymbols('c:/repo/src/a.ts').map((s) => s.name)).toEqual(['alpha'])
    expect(fileSymbols('c:/repo/src/b.ts')).toEqual([])
  })
})

describe('the code_outline verb', () => {
  it('answers with the handler\'s hint, or none when the handler set has no outline', async () => {
    const codeOutline = vi.fn(async () => 'the hint')
    expect(await executeTool('code_outline', { path: '/r/x.ts', sessionId: 's' }, { codeOutline } as unknown as McpToolHandlers)).toEqual({ outline: 'the hint' })
    expect(codeOutline).toHaveBeenCalledWith({ path: '/r/x.ts', sessionId: 's' })
    expect(await executeTool('code_outline', { path: '/r/x.ts' }, {} as McpToolHandlers)).toEqual({ outline: null })
  })
})

describe('the Read hook entry', () => {
  it('is limited to Read, and an entry missing the matcher is repaired', () => {
    const command = 'node "/x/memory-primer-hook.cjs"'
    const root: Record<string, any> = {}
    expect(applyPrimerHook(root, command, 'PreToolUse')).toBe('add')
    expect(root.hooks.PreToolUse).toEqual([{ matcher: 'Read', hooks: [{ type: 'command', command }] }])
    expect(applyPrimerHook(root, command, 'PreToolUse')).toBe('unchanged')
    delete root.hooks.PreToolUse[0].matcher
    expect(applyPrimerHook(root, command, 'PreToolUse')).toBe('update')
    expect(root.hooks.PreToolUse[0].matcher).toBe('Read')
    // Other events carry no matcher.
    expect(applyPrimerHook(root, command, 'SessionStart')).toBe('add')
    expect(root.hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command }] }])
  })
})
