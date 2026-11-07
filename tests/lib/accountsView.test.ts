import { describe, it, expect } from 'vitest'
import type { AccountRowView } from '../../src/shared/agentAccounts'
import {
  ACCOUNT_COLORS, ACCOUNT_COLOR_NAMES, AGENT_COLOR, accountBadge, accountsOf, agentOfCommand, agentOfName, agentOfTerminal, folderLine, freeColor, hasAccounts, onUnconnectedAccount,
} from '../../src/renderer/src/lib/accountsView'
import type { AccountsView } from '../../src/shared/agentAccounts'

const HOME = 'C:\\Users\\me'

function row(over: Partial<AccountRowView> = {}): AccountRowView {
  return {
    id: 'acc_000000000001', agent: 'claude', label: 'codedev', profile: `${HOME}\\.claude-codedev`, folder: `${HOME}\\.claude-codedev`,
    isDefault: false, autoOffer: true, order: 1, connect: true, origin: 'created', folderExists: true, shares: [],
    lastEmail: null, connection: { server: true, hook: true, allow: true }, bypassReady: true, terminals: 0, recopyAvailable: false,
    ...over,
  }
}

describe('accountsOf and hasAccounts', () => {
  it('keeps one agent\'s rows, in the order main sent them', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', agent: 'codex' }), row({ id: 'c' })]
    expect(accountsOf(rows, 'claude').map((r) => r.id)).toEqual(['a', 'c'])
    expect(accountsOf(rows, 'agy')).toEqual([])
  })

  it('says whether any account is registered at all (D13: none, no change)', () => {
    expect(hasAccounts([])).toBe(false)
    expect(hasAccounts([row()])).toBe(true)
  })
})

describe('accountBadge: the row\'s state, worst first', () => {
  const now = 1_000_000

  it('says the profile folder is missing before anything else', () => {
    expect(accountBadge(row({ folderExists: false }), now)).toEqual({ text: 'folder missing', tone: 'bad' })
  })

  it('names a recorded limit with its reset, or the hook\'s marker, before the sign-in', () => {
    const reset = new Date(2026, 9, 19, 15, 0).getTime()
    const limited = accountBadge(row({ limit: { seenAt: now, resetsAt: reset, text: 'x', scope: 'account' } }), now)
    expect(limited.tone).toBe('warn')
    expect(limited.text).toMatch(/^out of usage · resets /)
    expect(accountBadge(row({ limit: { seenAt: now, resetsAt: null, text: 'x', scope: 'account' } }), now)).toEqual({ text: 'out of usage', tone: 'warn' })
    // A limit on one model leaves the account eligible: it is said, not counted as out.
    expect(accountBadge(row({ limit: { seenAt: now, resetsAt: null, text: 'You\'ve hit your Opus limit', scope: 'model' } }), now)).toEqual({ text: 'a model is out of usage', tone: 'warn' })
    expect(accountBadge(row({ limitedOutside: now - 1000 }), now)).toEqual({ text: 'out of usage (seen by your failover hook)', tone: 'warn' })
  })

  it('warns when the profile is signed in to another email than the account\'s own', () => {
    expect(accountBadge(row({ email: 'b@example.test', lastEmail: 'a@example.test' }), now))
      .toEqual({ text: 'signed in to a@example.test instead!', tone: 'bad' })
    // Case doesn't make another account.
    expect(accountBadge(row({ email: 'B@Example.test', lastEmail: 'b@example.test' }), now).tone).not.toBe('bad')
  })

  it('reads the last check first, then "last signed in as", then signed out', () => {
    const checked = { email: 'b@example.test', signedIn: true, checkedAt: 5, source: 'auth-status' as const }
    expect(accountBadge(row({ identity: checked }), now)).toEqual({ text: 'signed in as b@example.test', tone: 'good' })
    expect(accountBadge(row({ identity: { ...checked, email: null } }), now)).toEqual({ text: 'signed in', tone: 'good' })
    expect(accountBadge(row({ identity: { ...checked, signedIn: false } }), now)).toEqual({ text: 'signed out', tone: 'muted' })
    // A relaunch on it landed on its sign-in screen: its stored sign-in no longer works (§7.2 step 10).
    expect(accountBadge(row({ identity: { ...checked, email: null, signedIn: false, source: 'sign-in-screen' } }), now)).toEqual({ text: 'sign-in expired', tone: 'bad' })
    // A check that couldn't tell falls back to the email the profile names.
    expect(accountBadge(row({ identity: { ...checked, signedIn: null }, lastEmail: 'b@example.test' }), now)).toEqual({ text: 'last signed in as b@example.test', tone: 'muted' })
    expect(accountBadge(row({ lastEmail: 'b@example.test' }), now)).toEqual({ text: 'last signed in as b@example.test', tone: 'muted' })
    expect(accountBadge(row(), now)).toEqual({ text: 'signed out', tone: 'muted' })
  })

  it('compares the check\'s email with the account\'s too', () => {
    const checked = { email: 'c@example.test', signedIn: true, checkedAt: 5, source: 'auth-status' as const }
    expect(accountBadge(row({ email: 'b@example.test', identity: checked }), now)).toEqual({ text: 'signed in to c@example.test instead!', tone: 'bad' })
  })

  it('shows an agy label by its email alone: agy draws who is signed in on its own screen', () => {
    expect(accountBadge(row({ agent: 'agy', profile: null, folder: null, folderExists: false, email: 'g@example.test' }), now))
      .toEqual({ text: 'g@example.test', tone: 'muted' })
    expect(accountBadge(row({ agent: 'agy', profile: null, folder: null, folderExists: false }), now))
      .toEqual({ text: 'no email given', tone: 'muted' })
  })
})

describe('ACCOUNT_COLOR_NAMES: what the colour picker reads out', () => {
  it('names every colour of the palette, so the picker never has a hex code to read', () => {
    for (const c of ACCOUNT_COLORS) expect(ACCOUNT_COLOR_NAMES[c], c).toMatch(/^[a-z]+$/)
    expect(new Set(ACCOUNT_COLORS.map((c) => ACCOUNT_COLOR_NAMES[c])).size).toBe(ACCOUNT_COLORS.length)
  })
})

describe('freeColor: the Add wizard\'s first colour', () => {
  const v = (accounts: AccountRowView[]) => ({ accounts }) as unknown as AccountsView
  it('is the agent\'s own until one of its accounts has it, then the next free one, any case', () => {
    expect(freeColor(null, 'claude')).toBe(AGENT_COLOR.claude)
    expect(freeColor(v([row({ agent: 'codex' })]), 'claude')).toBe(AGENT_COLOR.claude)
    // An account with no colour of its own wears the agent's.
    expect(freeColor(v([row({ color: undefined })]), 'claude')).toBe(ACCOUNT_COLORS[1])
    expect(freeColor(v([row({ color: '#d97706' }), row({ color: '#10B981' })]), 'claude')).toBe(ACCOUNT_COLORS[2])
  })
  it('falls back to the agent\'s own once every colour is taken', () => {
    expect(freeColor(v(ACCOUNT_COLORS.map((c) => row({ agent: 'agy', color: c }))), 'agy')).toBe(AGENT_COLOR.agy)
  })
})

describe('folderLine', () => {
  it('shows the folder with the home folder as ~, and says which is the main profile', () => {
    expect(folderLine(row(), HOME)).toBe('~\\.claude-codedev')
    expect(folderLine(row({ isDefault: true, profile: null, folder: `${HOME}\\.claude` }), HOME)).toBe('~\\.claude (main profile)')
    expect(folderLine(row({ folder: null }), HOME)).toBe('')
    expect(folderLine(row({ folder: 'D:\\profiles\\x' }), HOME)).toBe('D:\\profiles\\x')
  })
})

describe("agentOfName: which account agent a swarm worker's name says it runs", () => {
  it('reads Claude, Codex, and Gemini as agy, which Termpolis runs for it', () => {
    expect(agentOfName('Claude')).toBe('claude')
    expect(agentOfName('Claude Code')).toBe('claude')
    expect(agentOfName('Codex')).toBe('codex')
    expect(agentOfName('Gemini')).toBe('agy')
    expect(agentOfName('Antigravity CLI')).toBe('agy')
    expect(agentOfName('agy')).toBe('agy')
    expect(agentOfName('Legacy')).toBeNull()
    expect(agentOfName('Stagy')).toBeNull()
  })
})

describe('agentOfCommand: which account agent a terminal runs', () => {
  it('maps a launch command to its agent, and anything else to none', () => {
    expect(agentOfCommand('claude --model opus')).toBe('claude')
    expect(agentOfCommand('codex')).toBe('codex')
    expect(agentOfCommand('agy')).toBe('agy')
    expect(agentOfCommand('gemini')).toBe(null)
    expect(agentOfCommand('npm test')).toBe(null)
    expect(agentOfCommand(undefined)).toBe(null)
  })

  it('names the agent by its first word, with a path or an .exe, and never a wrapper that only starts with it', () => {
    expect(agentOfCommand('  C:\\tools\\claude.exe --verbose')).toBe('claude')
    expect(agentOfCommand('/usr/local/bin/codex -a never')).toBe('codex')
    expect(agentOfCommand('CLAUDE')).toBe('claude')
    // A wrapper adds something (a sandbox) that a relaunch of the bare agent would drop: it has no
    // account, no chip and no switch, and launches as it did before accounts (D13).
    for (const wrapper of ['claude-sandbox --permission-mode plan', 'claudex', 'codex-wrapper', 'agy2', 'agyx --model m', 'npx claude', 'sandbox-run claude --model x']) {
      expect(agentOfCommand(wrapper), wrapper).toBeNull()
    }
  })
})

describe('agentOfTerminal: the agent a terminal runs, as Termpolis knows it', () => {
  it('reads the command it launched, a swarm worker\'s recorded agent, and never the conductor\'s', () => {
    expect(agentOfTerminal({ agentCommand: 'codex -m x' })).toBe('codex')
    expect(agentOfTerminal({ isSwarm: true, swarmAgent: 'claude' })).toBe('claude')
    expect(agentOfTerminal({ isSwarm: true })).toBeNull()
    // agy's switch is its own sign-in, which a worker's hidden terminal can't show.
    expect(agentOfTerminal({ isSwarm: true, swarmAgent: 'agy' })).toBeNull()
    expect(agentOfTerminal({ isSwarm: true, swarmAgent: 'codex' })).toBe('codex')
    // A recorded agent counts only on a worker's terminal.
    expect(agentOfTerminal({ swarmAgent: 'claude' })).toBeNull()
    expect(agentOfTerminal({ agentCommand: 'claude', isConductor: true, isSwarm: true })).toBeNull()
    expect(agentOfTerminal(undefined)).toBeNull()
  })
})

describe('onUnconnectedAccount: a terminal whose registered account the user did not connect (R17)', () => {
  const view = (...rows: AccountRowView[]) => ({ accounts: rows })
  const other = row({ id: 'acc_o', isDefault: false, connect: false })
  it('is true only for a registered account that is neither the default profile nor connected', () => {
    expect(onUnconnectedAccount({ id: 't', agentAccountId: 'acc_o' }, view(other), {})).toBe(true)
    expect(onUnconnectedAccount({ id: 't', agentAccountId: 'acc_o' }, view({ ...other, connect: true }), {})).toBe(false)
    expect(onUnconnectedAccount({ id: 't', agentAccountId: 'acc_o' }, view({ ...other, isDefault: true }), {})).toBe(false)
  })
  it('judges no terminal it knows nothing of: no account, a stale one, one changed by hand, no view, no record', () => {
    expect(onUnconnectedAccount({ id: 't' }, view(other), {})).toBe(false)
    expect(onUnconnectedAccount({ id: 't', agentAccountId: 'acc_gone' }, view(other), {})).toBe(false)
    expect(onUnconnectedAccount({ id: 't', agentAccountId: 'acc_o' }, view(other), { t: true })).toBe(false)
    expect(onUnconnectedAccount({ id: 't', agentAccountId: 'acc_o' }, null, {})).toBe(false)
    expect(onUnconnectedAccount({ id: 't', agentAccountId: 'acc_o' }, undefined, undefined)).toBe(false)
    expect(onUnconnectedAccount({ id: 't', agentAccountId: 'acc_o' }, view(), {})).toBe(false)
    expect(onUnconnectedAccount(undefined, view(other), {})).toBe(false)
    // A record kept for a terminal of another id is no word on this one.
    expect(onUnconnectedAccount({ id: 't', agentAccountId: 'acc_o' }, view(other), { u: true })).toBe(true)
    expect(onUnconnectedAccount({ id: 't', agentAccountId: 'acc_o' }, view(other), undefined)).toBe(true)
  })
})
