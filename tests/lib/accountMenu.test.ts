// The account menu's pure half (src/renderer/src/lib/accountMenu.ts, the in-app account UI §2.1):
// one row per account of the terminal's agent with its status in a few words, why a row can't be
// picked, what picking one does (switch, wait for the turn, sign in first, agy's switch-all), the
// work account's second confirmation (D14, R17), and the menu's keyboard moves.
import { describe, it, expect } from 'vitest'
import { actionWords, confirmFor, isSignedIn, menuRows, moveIndex, typeAhead } from '../../src/renderer/src/lib/accountMenu'
import type { AccountRowView, AccountsView } from '../../src/shared/agentAccounts'

function row(over: Partial<AccountRowView>): AccountRowView {
  return {
    id: 'acc_a', agent: 'claude', label: 'personal', profile: null, folder: '/h/.claude', isDefault: true, autoOffer: true,
    order: 0, connect: true, origin: 'adopted', folderExists: true, shares: [], lastEmail: null,
    connection: { server: true, hook: true, allow: true }, bypassReady: true, terminals: 0, recopyAvailable: false, ...over,
  }
}

function view(accounts: AccountRowView[], over: Partial<AccountsView> = {}): AccountsView {
  return {
    accounts, preferred: {}, chooser: true, hidden: {}, integrationConnected: true, importAvailable: false, drift: [],
    advice: { stopFailureHooks: [], authOverrides: [] }, home: '/h', ...over,
  }
}

const NOW = new Date(2026, 9, 23, 12, 0).getTime()
const A = row({ id: 'acc_a', label: 'personal', email: 'a@example.test', lastEmail: 'a@example.test' })
const B = row({ id: 'acc_b', label: 'codedev', profile: '/h/.claude-b', folder: '/h/.claude-b', isDefault: false, email: 'b@example.test', lastEmail: 'b@example.test', order: 1, color: '#7ee2a3' })
const W = row({ id: 'acc_w', label: 'work', profile: '/h/.claude-w', folder: '/h/.claude-w', isDefault: false, autoOffer: false, connect: false, lastEmail: 'w@example.test', order: 2 })
const idle = { busy: false, worker: false }

describe('isSignedIn', () => {
  it('takes the last check, else whether the profile names a sign-in', () => {
    expect(isSignedIn(row({ identity: { email: 'a@x', signedIn: true, checkedAt: 1, source: 'auth-status' } }))).toBe(true)
    expect(isSignedIn(row({ lastEmail: 'a@x', identity: { email: null, signedIn: false, checkedAt: 1, source: 'auth-status' } }))).toBe(false)
    // A check that couldn't tell falls back to the profile.
    expect(isSignedIn(row({ lastEmail: 'a@x', identity: { email: null, signedIn: null, checkedAt: 1, source: 'auth-status' } }))).toBe(true)
    expect(isSignedIn(row({ lastEmail: 'a@x' }))).toBe(true)
    expect(isSignedIn(row({}))).toBe(false)
  })
})

describe('menuRows: one row per account of the agent, in registry order', () => {
  it('shows each one\'s colour, initial, email and status, the current one checked and not picked', () => {
    const rows = menuRows(view([A, B, row({ id: 'cx', agent: 'codex', label: 'cx' })]), 'claude', 'acc_a', NOW, idle)
    expect(rows.map((r) => r.account.id)).toEqual(['acc_a', 'acc_b'])
    expect(rows[0]).toMatchObject({ current: true, initial: 'P', color: '#D97706', email: 'a@example.test', status: 'Signed in', tone: 'good', note: null, disabled: null, action: 'none' })
    expect(rows[1]).toMatchObject({ current: false, initial: 'C', color: '#7ee2a3', status: 'Signed in', action: 'switch' })
  })

  it('reads a blank label\'s initial as ?, and an account\'s email from its check before its registration', () => {
    const r = menuRows(view([row({ label: '  ', email: 'reg@x', identity: { email: 'now@x', signedIn: true, checkedAt: 1, source: 'auth-status' } })]), 'claude', undefined, NOW, idle)[0]
    expect(r.initial).toBe('?')
    expect(r.email).toBe('now@x')
    expect(menuRows(view([row({ email: 'reg@x' })]), 'claude', undefined, NOW, idle)[0].email).toBe('reg@x')
    expect(menuRows(view([row({})]), 'claude', undefined, NOW, idle)[0].email).toBeNull()
  })

  it('says each status in a few words', () => {
    const status = (over: Partial<AccountRowView>) => {
      const r = menuRows(view([row({ id: 'x', isDefault: false, profile: '/h/p', ...over })]), 'claude', 'other', NOW, idle)[0]
      return [r.status, r.tone]
    }
    expect(status({ lastEmail: 'a@x', identity: { email: null, signedIn: false, checkedAt: 1, source: 'sign-in-screen' } })).toEqual(['Sign-in expired', 'bad'])
    // A sign-in screen that showed a signed-in account is no expiry.
    expect(status({ lastEmail: 'a@x', identity: { email: 'a@x', signedIn: true, checkedAt: 1, source: 'sign-in-screen' } })).toEqual(['Signed in', 'good'])
    const at4 = new Date(2026, 9, 23, 16, 0).getTime()
    expect(status({ lastEmail: 'a@x', limit: { seenAt: 1, resetsAt: at4, text: '', scope: 'account' } })[0]).toMatch(/^Out of usage until /)
    expect(status({ lastEmail: 'a@x', limit: { seenAt: 1, resetsAt: null, text: '', scope: 'account' } })).toEqual(['Out of usage', 'warn'])
    expect(status({ lastEmail: 'a@x', limit: { seenAt: 1, resetsAt: at4, text: '', scope: 'model' } })).toEqual(['A model is out of usage', 'warn'])
    expect(status({ lastEmail: 'a@x', limitedOutside: 5 })).toEqual(['Out of usage (your failover hook)', 'warn'])
    expect(status({ email: 'a@x', lastEmail: 'other@x' })).toEqual(['Signed in as other@x', 'warn'])
    expect(status({})).toEqual(['Signed out', 'muted'])
    expect(status({ lastEmail: 'a@x', autoOffer: false })).toEqual(['Not offered automatically', 'muted'])
    expect(status({ lastEmail: 'a@x' })).toEqual(['Signed in', 'good'])
  })

  it('labels agy\'s accounts as Google accounts, the work one as not offered automatically, and moves them all together', () => {
    const g1 = row({ id: 'g1', agent: 'agy', label: 'me', email: 'me@gmail.test', folder: null, connection: null, bypassReady: false })
    const g2 = row({ id: 'g2', agent: 'agy', label: 'work', email: 'w@corp.test', autoOffer: false, folder: null, connection: null, folderExists: false, isDefault: false, connect: false })
    const rows = menuRows(view([g1, g2]), 'agy', 'g1', NOW, { busy: true, worker: false })
    expect(rows.map((r) => [r.status, r.tone, r.email, r.note, r.disabled, r.action])).toEqual([
      ['Google account', 'muted', 'me@gmail.test', null, null, 'none'],
      // agy has no profile folder: none is missing, nothing is "not connected", and busy is the sheet's.
      ['Not offered automatically', 'muted', 'w@corp.test', null, null, 'agy'],
    ])
  })

  it('disables an account whose profile folder is missing, but never the current one', () => {
    const gone = row({ ...B, folderExists: false })
    const rows = menuRows(view([A, gone]), 'claude', 'acc_a', NOW, idle)
    expect(rows[1]).toMatchObject({ disabled: 'Its profile folder is missing', status: 'Its profile folder is missing', tone: 'bad', action: 'none' })
    expect(menuRows(view([gone]), 'claude', 'acc_b', NOW, idle)[0]).toMatchObject({ disabled: null, current: true })
  })

  it('warns that an account not connected drops Termpolis\'s tools (R30), but not the default profile', () => {
    const loose = row({ ...B, connect: false })
    expect(menuRows(view([loose]), 'claude', undefined, NOW, idle)[0]).toMatchObject({ note: 'Not connected: loses Termpolis\'s tools', action: 'switch' })
    expect(menuRows(view([row({ ...A, connect: false })]), 'claude', undefined, NOW, idle)[0].note).toBeNull()
  })

  it('makes a signed-out or expired account sign in first, a busy agent wait for its turn', () => {
    const out = row({ ...B, lastEmail: null })
    const expired = row({ ...B, id: 'acc_e', identity: { email: null, signedIn: false, checkedAt: 1, source: 'sign-in-screen' } })
    expect(menuRows(view([out, expired]), 'claude', undefined, NOW, idle).map((r) => r.action)).toEqual(['sign-in-and-switch', 'sign-in-and-switch'])
    expect(menuRows(view([out, B]), 'claude', undefined, NOW, { busy: true, worker: false }).map((r) => r.action)).toEqual(['sign-in-and-switch', 'queue'])
  })

  it('offers a swarm worker only the accounts that can take it over, saying why the others can\'t (§9)', () => {
    const nobypass = row({ ...B, id: 'nb', label: 'nb', bypassReady: false })
    const loose = row({ ...B, id: 'lo', label: 'lo', connect: false })
    const worker = { busy: false, worker: true }
    const rows = menuRows(view([A, B, nobypass, loose]), 'claude', 'acc_a', NOW, worker)
    expect(rows.map((r) => [r.disabled, r.action])).toEqual([
      // Its own account is never blocked: it already runs there.
      [null, 'none'],
      [null, 'switch'],
      ['Accept bypass mode in it once to take workers', 'none'],
      ['Not connected: a worker needs Termpolis\'s tools', 'none'],
    ])
    // Without Termpolis's integration, none can.
    expect(menuRows(view([A, B], { integrationConnected: false }), 'claude', 'acc_a', NOW, worker)[1].disabled).toBe('Not connected: a worker needs Termpolis\'s tools')
  })
})

describe('actionWords', () => {
  it('says what picking a row does, or nothing for a plain switch', () => {
    const r = menuRows(view([A]), 'claude', undefined, NOW, idle)[0]
    expect(actionWords({ ...r, action: 'switch' })).toBeNull()
    expect(actionWords({ ...r, action: 'none' })).toBeNull()
    expect(actionWords({ ...r, action: 'queue' })).toBe('Switch when it finishes')
    expect(actionWords({ ...r, action: 'sign-in-and-switch' })).toBe('Sign in to personal and switch')
    expect(actionWords({ ...r, action: 'agy' })).toBe('Moves every Gemini terminal')
  })
})

describe('confirmFor (D14, R17)', () => {
  it('asks a second confirmation onto an account not offered automatically', () => {
    expect(confirmFor(A, W)).toEqual({ question: 'work isn\'t offered automatically. Switch this terminal to work?', newTerminal: false })
    expect(confirmFor(undefined, W)?.newTerminal).toBe(false)
  })

  it('asks one too for carrying a conversation off one, offering a fresh session in a new terminal instead', () => {
    expect(confirmFor(W, A)).toEqual({ question: 'This conversation is on work, which isn\'t offered automatically. Carry it to personal?', newTerminal: true })
  })

  it('asks nothing between two ordinary accounts, or from none', () => {
    expect(confirmFor(A, B)).toBeNull()
    expect(confirmFor(undefined, B)).toBeNull()
  })
})

describe('moveIndex: the menu\'s arrows, Home and End', () => {
  const on = [true, false, true, true]
  it('steps over disabled items, round the ends', () => {
    expect(moveIndex(on, 0, 'next')).toBe(2)
    expect(moveIndex(on, 3, 'next')).toBe(0)
    expect(moveIndex(on, 0, 'prev')).toBe(3)
    expect(moveIndex(on, 2, 'prev')).toBe(0)
  })
  it('goes to the first or last enabled one', () => {
    expect(moveIndex([false, true, true, false], 3, 'first')).toBe(1)
    expect(moveIndex([false, true, true, false], 0, 'last')).toBe(2)
  })
  it('starts at an end from nowhere, and finds nothing with nothing enabled', () => {
    expect(moveIndex(on, -1, 'next')).toBe(0)
    expect(moveIndex(on, -1, 'prev')).toBe(3)
    expect(moveIndex(on, 1, 'next')).toBe(0)
    expect(moveIndex([false, false], 0, 'next')).toBe(-1)
  })
})

describe('typeAhead', () => {
  const labels = ['personal', 'codedev', 'Contoso', 'work']
  it('finds the next label that starts with what was typed, any case, round the end', () => {
    expect(typeAhead(labels, 'c', 0)).toBe(1)
    expect(typeAhead(labels, 'C', 1)).toBe(2)
    expect(typeAhead(labels, 'c', 2)).toBe(1)
    expect(typeAhead(labels, 'co', -1)).toBe(1)
    expect(typeAhead(labels, 'wo', 3)).toBe(3)
  })
  it('finds nothing for what no label starts with', () => {
    expect(typeAhead(labels, 'z', 0)).toBe(-1)
    expect(typeAhead([], 'a', 0)).toBe(-1)
  })
})
