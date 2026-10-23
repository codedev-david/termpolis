// agy's switch-all, its logic (src/renderer/src/lib/agySwitchAll.ts, the in-app account UI §2.4):
// the terminals that move with agy's one sign-in, the work account's second confirmation (D14),
// and what main said went wrong.
import { describe, it, expect } from 'vitest'
import { agyTerminals, agyWorkQuestion, whyOf } from '../../src/renderer/src/lib/agySwitchAll'
import type { AccountRowView } from '../../src/shared/agentAccounts'
import type { TerminalSession } from '../../src/renderer/src/types'

function row(over: Partial<AccountRowView>): AccountRowView {
  return {
    id: 'g1', agent: 'agy', label: 'me', email: 'me@example.test', profile: null, folder: null, isDefault: true, autoOffer: true,
    order: 0, connect: false, origin: 'manual', folderExists: false, shares: [], lastEmail: null, connection: null, bypassReady: false,
    terminals: 0, recopyAvailable: false, ...over,
  }
}
const G1 = row({ id: 'g1', label: 'me' })
const G2 = row({ id: 'g2', label: 'other', email: 'other@example.test', isDefault: false, order: 1 })
const GW = row({ id: 'gw', label: 'work', email: 'w@corp.test', isDefault: false, autoOffer: false, order: 2 })
const term = (id: string, over: Partial<TerminalSession> = {}): TerminalSession => ({
  id, name: id, color: '#4285F4', shellType: 'powershell', cwd: '/repo', fontSize: 13, theme: 'dark', fontFamily: 'mono', agentCommand: 'agy', ...over,
})

describe('agySwitchAll', () => {
  it('moves every agy terminal Termpolis launched, never a swarm\'s or the conductor\'s, nor another agent\'s', () => {
    const ts = [term('t1'), term('s', { isSwarm: true }), term('c', { isConductor: true }), term('x', { agentCommand: 'claude' }), term('t2')]
    expect(agyTerminals(ts).map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('asks the work account\'s second confirmation onto it, or carrying conversations off it (D14)', () => {
    expect(agyWorkQuestion(GW, [G1], 2)).toEqual({ question: 'work isn\'t offered automatically. Switch Gemini CLI to work?', yes: 'Switch to work' })
    expect(agyWorkQuestion(G2, [G1, GW], 2)).toEqual({ question: '2 Gemini conversations are on work, which isn\'t offered automatically. Carry them to other?', yes: 'Carry them to other' })
    expect(agyWorkQuestion(G2, [GW], 1)).toEqual({ question: 'A Gemini conversation is on work, which isn\'t offered automatically. Carry it to other?', yes: 'Carry it to other' })
    expect(agyWorkQuestion(G2, [G1], 1)).toBeNull()
    expect(agyWorkQuestion(G2, [], 0)).toBeNull()
  })

  it('reads why a step went wrong, or nothing', () => {
    expect(whyOf({ kind: 'not-exited', why: 'w' })).toBe('w')
    expect(whyOf({ kind: 'busy' })).toBe('')
  })
})
