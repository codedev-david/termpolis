// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import {
  ACCOUNTS_FILE, AccountsRefusal, accountProfileTargets, accountsFilePath, accountsShDrift, accountsShLines,
  accountsShPath, checkProfileFolder, claudeJsonOf, comparisonKey, cooldownFor, defaultProfileDir, discoverShares,
  emptyAccountsFile, findAccount, isAccountConnected, isReachable, lastSignedInAs, launchString, limitedMarker,
  liveProfileDir, loadAccounts, newAccountId, parseAccountsDoc, parseAccountsSh, previewAccountsSh, profileDirOf,
  readAccountsSh, saveAccounts, serializeAccountsDoc, updateAccounts,
} from '../../src/main/agentAccounts'
import type { AccountsDoc } from '../../src/main/agentAccounts'
import type { AgentAccount } from '../../src/shared/agentAccounts'
import { accountFs } from '../../src/main/accountFs'
import type { AccountFs } from '../../src/main/accountFs'

let root: string
let home: string
let userData: string
let savedTestHome: string | undefined
const links: string[] = []

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tp-accts-')))
  home = join(root, 'home')
  userData = join(root, 'userData')
  mkdirSync(home)
  savedTestHome = process.env.TERMPOLIS_TEST_AGENT_HOME
  process.env.TERMPOLIS_TEST_AGENT_HOME = home
})

afterEach(() => {
  for (const l of links.splice(0).reverse()) {
    try { rmdirSync(l) } catch { try { unlinkSync(l) } catch { /* gone */ } }
  }
  if (savedTestHome === undefined) delete process.env.TERMPOLIS_TEST_AGENT_HOME
  else process.env.TERMPOLIS_TEST_AGENT_HOME = savedTestHome
  rmSync(root, { recursive: true, force: true })
})

function link(target: string, at: string): void {
  symlinkSync(target, at, 'junction')
  links.push(at)
}

function acct(fields: Partial<AgentAccount> & Pick<AgentAccount, 'id' | 'label'>): AgentAccount {
  return { agent: 'claude', profile: null, autoOffer: true, order: 0, connect: false, origin: 'adopted', links: [], ...fields }
}

const ID = (n: number): string => `acc_${String(n).padStart(12, '0')}`

function docWith(...accounts: AgentAccount[]): AccountsDoc {
  const doc = parseAccountsDoc({})
  doc.file.accounts.push(...accounts)
  return doc
}

describe('the registry file', () => {
  it('parses an empty or foreign value as an empty registry, the chooser on by default', () => {
    expect(parseAccountsDoc(null).file).toEqual(emptyAccountsFile())
    expect(parseAccountsDoc([]).file).toEqual(emptyAccountsFile())
    expect(emptyAccountsFile()).toEqual({ version: 1, accounts: [], preferred: {}, chooser: true, cooldownSec: {}, limits: {}, identity: {} })
  })

  it('keeps when a profile was started from a copy only when it is a time', () => {
    const acc = (copiedAt: unknown) => parseAccountsDoc({ version: 1, accounts: [{ id: 'acc_000000000001', agent: 'claude', label: 'b', profile: join(sep, 'p', '.claude-b'), copiedAt }] }).file.accounts[0]
    expect(acc(1_760_000_000_000).copiedAt).toBe(1_760_000_000_000)
    for (const bad of [0, -1, Number.NaN, '5', null]) expect('copiedAt' in acc(bad)).toBe(false)
  })

  it('keeps unknown top-level fields, unknown fields of an account and accounts it cannot read', () => {
    const raw = {
      version: 1,
      policy: { claude: 'next' },
      future: [1, 2],
      accounts: [
        { id: ID(1), agent: 'claude', label: 'personal', profile: null, newField: { x: 1 }, autoOffer: true, order: 0, connect: true, origin: 'accounts-sh', importedAs: 'personal', links: [] },
        { id: ID(2), agent: 'gemini-cli', label: 'g', profile: '/x' },
        { id: 'bad', agent: 'claude', label: 'x' },
        { id: ID(1), agent: 'claude', label: 'dup' },
        'not even an object',
      ],
    }
    const doc = parseAccountsDoc(raw)
    expect(doc.file.accounts.map((a) => a.label)).toEqual(['personal'])
    expect(doc.unknown).toHaveLength(4)
    const out = JSON.parse(serializeAccountsDoc(doc))
    expect(out.policy).toEqual({ claude: 'next' })
    expect(out.future).toEqual([1, 2])
    expect(out.accounts[0].newField).toEqual({ x: 1 })
    expect(out.accounts.slice(1)).toEqual(raw.accounts.slice(1))
  })

  it('normalises every known field of an account', () => {
    const doc = parseAccountsDoc({
      version: 1,
      accounts: [
        { id: ID(1), agent: 'codex', label: '  work  ', profile: join(home, '.codex-work'), email: 'not an email', color: 'red', importedAs: 'a b', links: [{ name: 'sessions', target: join(home, '.codex', 'sessions') }, { name: '', target: '/x' }, { name: 'n', target: 'relative' }, 7], order: 'x' },
        { id: ID(2), agent: 'agy', label: 'google', email: 'me@example.test', color: '#AbCdEf', autoOffer: false, connect: true, origin: 'bogus' },
        { id: ID(3), agent: 'agy', label: 'with-profile', profile: '/x' },
        { id: ID(4), agent: 'claude', label: 'rel', profile: 'relative/path' },
        { id: ID(5), agent: 'claude', label: 'ctl', profile: '/a\u0007b' },
        { id: ID(6), agent: 'claude', label: '', profile: null },
        { id: ID(7), agent: 'claude', label: 'num', profile: 42 },
      ],
    })
    const [codex, agy] = doc.file.accounts
    expect(doc.file.accounts).toHaveLength(2)
    expect(codex).toMatchObject({ label: 'work', profile: join(home, '.codex-work'), autoOffer: true, connect: false, origin: 'adopted', order: 0 })
    expect(codex.email).toBeUndefined()
    expect(codex.color).toBeUndefined()
    expect(codex.importedAs).toBeUndefined()
    expect(codex.links).toEqual([{ name: 'sessions', target: join(home, '.codex', 'sessions') }])
    expect(agy).toMatchObject({ label: 'google', email: 'me@example.test', color: '#AbCdEf', autoOffer: false, connect: true, origin: 'label', order: 1, profile: null })
    expect(doc.unknown).toHaveLength(5)
  })

  it('parses the per-agent maps, limits, identity and hidden flags, keeping only well-formed entries', () => {
    const doc = parseAccountsDoc({
      version: 1,
      preferred: { claude: ID(1), codex: '', agy: 7, other: ID(2) },
      chooser: false,
      cooldownSec: { claude: 3600, codex: -5, agy: 1.5 },
      limits: { [ID(1)]: { seenAt: 1, resetsAt: null, text: 'x', scope: 'account' }, [ID(2)]: { seenAt: 'no' }, junk: { seenAt: 1, text: 'y' } },
      identity: { [ID(1)]: { email: 'me@example.test', signedIn: true, checkedAt: 5, source: 'auth-status' }, [ID(3)]: { email: null } },
      hidden: { hookAdvice: true, authEnvAdvice: 'yes', limitBanner: true, other: true },
    })
    expect(doc.file.preferred).toEqual({ claude: ID(1) })
    expect(doc.file.chooser).toBe(false)
    expect(doc.file.cooldownSec).toEqual({ claude: 3600 })
    expect(Object.keys(doc.file.limits)).toEqual([ID(1)])
    expect(Object.keys(doc.file.identity)).toEqual([ID(1)])
    expect(doc.file.hidden).toEqual({ hookAdvice: true, limitBanner: true })
    expect(parseAccountsDoc({ version: 1, hidden: {} }).file.hidden).toEqual({})
    expect(JSON.parse(serializeAccountsDoc(parseAccountsDoc({ version: 1, hidden: {} })))).not.toHaveProperty('hidden')
    expect(JSON.parse(serializeAccountsDoc(parseAccountsDoc({ version: 1, hidden: { hookAdvice: true } }))).hidden).toEqual({ hookAdvice: true })
    expect(JSON.parse(serializeAccountsDoc(parseAccountsDoc({ version: 1 })))).not.toHaveProperty('hidden')
  })

  it('round-trips through disk, written privately and atomically', () => {
    expect(loadAccounts(userData)).toEqual({ ok: true, doc: parseAccountsDoc({}), exists: false })
    const doc = docWith(acct({ id: ID(1), label: 'personal', email: 'a@example.test' }))
    doc.rest = { keep: 'me' }
    expect(saveAccounts(userData, doc)).toBeNull()
    const file = join(userData, ACCOUNTS_FILE)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    const again = loadAccounts(userData)
    expect(again.ok && again.exists).toBe(true)
    expect(again.ok && again.doc.file.accounts[0].email).toBe('a@example.test')
    expect(again.ok && again.doc.rest).toEqual({ keep: 'me' })
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
  })

  it('refuses to read, and so never overwrites, a registry it cannot parse', () => {
    mkdirSync(userData)
    const file = join(userData, ACCOUNTS_FILE)
    writeFileSync(file, '{ oops')
    expect(loadAccounts(userData)).toEqual({ ok: false, error: `${ACCOUNTS_FILE} is not valid JSON, so Termpolis left it as it is` })
    expect(updateAccounts(userData, () => 1)).toEqual({ ok: false, error: `${ACCOUNTS_FILE} is not valid JSON, so Termpolis left it as it is` })
    expect(readFileSync(file, 'utf8')).toBe('{ oops')
    writeFileSync(file, JSON.stringify({ version: 2, accounts: [] }))
    expect(loadAccounts(userData)).toEqual({ ok: false, error: `${ACCOUNTS_FILE} was written by another version of Termpolis` })
    writeFileSync(file, '\uFEFF' + JSON.stringify({ version: 1 }))
    expect(loadAccounts(userData).ok).toBe(true)
    writeFileSync(file, 'x'.repeat(1024 * 1024 + 1))
    expect(loadAccounts(userData)).toEqual({ ok: false, error: `${ACCOUNTS_FILE} can't be read` })
  })

  it('refuses a userData folder that is not a full path', () => {
    expect(accountsFilePath('relative')).toBeNull()
    expect(loadAccounts('relative')).toEqual({ ok: false, error: 'the folder Termpolis keeps its settings in is not a full path' })
    expect(saveAccounts('relative', parseAccountsDoc({}))).toBe('the folder Termpolis keeps its settings in is not a full path')
  })

  it('reports a failed save by its code, never by content', () => {
    mkdirSync(userData)
    mkdirSync(join(userData, ACCOUNTS_FILE))
    expect(saveAccounts(userData, parseAccountsDoc({}))).toMatch(/^agent-accounts\.json could not be saved \(\w+\)$/)
    const failing: AccountFs = { ...accountFs, exists: () => true, writePrivate: () => { throw new Error('boom') } }
    expect(saveAccounts(userData, parseAccountsDoc({}), failing)).toBe(`${ACCOUNTS_FILE} could not be saved (error)`)
  })

  it('updates in one read-modify-write, saves nothing on a refusal, and passes other errors on', () => {
    const r = updateAccounts(userData, (doc) => {
      doc.file.accounts.push(acct({ id: ID(1), label: 'a' }))
      return 'added'
    })
    expect(r.ok && r.value).toBe('added')
    expect(updateAccounts(userData, (doc) => {
      doc.file.accounts = []
      throw new AccountsRefusal('no')
    })).toEqual({ ok: false, error: 'no' })
    const after = loadAccounts(userData)
    expect(after.ok && after.doc.file.accounts).toHaveLength(1)
    expect(() => updateAccounts(userData, () => { throw new Error('bug') })).toThrow('bug')
    const failing: AccountFs = { ...accountFs, writePrivate: () => { throw new Error('disk full') } }
    expect(updateAccounts(userData, () => 1, failing)).toEqual({ ok: false, error: `${ACCOUNTS_FILE} could not be saved (error)` })
  })

  it('makes ids of acc_ and 12 hex digits', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newAccountId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^acc_[0-9a-f]{12}$/)
  })
})

describe('profile paths', () => {
  it('stores the launch string: resolved, NFC, no trailing separator, and never realpath\'d (R14)', () => {
    expect(launchString(join(home, '.claude-x') + sep)).toBe(join(home, '.claude-x'))
    expect(launchString(join(home, 'a', '..', '.claude-x'))).toBe(join(home, '.claude-x'))
    expect(launchString(join(home, 'jose\u0301'))).toBe(join(home, 'jos\u00e9'))
    const root0 = process.platform === 'win32' ? 'C:\\' : '/'
    expect(launchString(root0)).toBe(root0)
    // A linked folder keeps the spelling it was given: macOS names the Keychain entry after it.
    const real = join(home, 'real-profile')
    mkdirSync(real)
    const alias = join(home, '.claude-alias')
    link(real, alias)
    expect(launchString(alias)).toBe(alias)
    expect(comparisonKey(alias)).toBe(comparisonKey(real))
  })

  it('compares folders case-insensitively where the filesystem does', () => {
    const fold = process.platform === 'win32' || process.platform === 'darwin'
    expect(comparisonKey(join(home, 'ABC')) === comparisonKey(join(home, 'abc'))).toBe(fold)
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...original, value: 'linux' })
    try {
      expect(comparisonKey(join(home, 'ABC')) === comparisonKey(join(home, 'abc'))).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', original)
    }
  })

  it('counts a folder outside the test home as missing while a test run sets one', () => {
    expect(isReachable(join(home, '.claude'))).toBe(true)
    expect(isReachable(join(root, 'elsewhere'))).toBe(false)
    expect(isReachable(join(root, 'elsewhere'), {})).toBe(true)
    expect(isReachable(join(root, 'elsewhere'), { TERMPOLIS_TEST_AGENT_HOME: '  ' })).toBe(true)
  })

  it('finds each account\'s folder and .claude.json, the default profile\'s in the home folder', () => {
    const def = acct({ id: ID(1), label: 'p' })
    const other = acct({ id: ID(2), label: 'c', profile: join(home, '.claude-c') })
    const codex = acct({ id: ID(3), label: 'x', agent: 'codex', profile: null })
    const agy = acct({ id: ID(4), label: 'g', agent: 'agy' })
    expect(defaultProfileDir('claude', home)).toBe(join(home, '.claude'))
    expect(profileDirOf(def, home)).toBe(join(home, '.claude'))
    expect(profileDirOf(other, home)).toBe(join(home, '.claude-c'))
    expect(profileDirOf(codex, home)).toBe(join(home, '.codex'))
    expect(profileDirOf(agy, home)).toBeNull()
    expect(profileDirOf(def, '')).toBeNull()
    expect(claudeJsonOf(def, home)).toBe(join(home, '.claude.json'))
    expect(claudeJsonOf(other, home)).toBe(join(home, '.claude-c', '.claude.json'))
    expect(claudeJsonOf(codex, home)).toBeNull()
    expect(claudeJsonOf(def, 'relative')).toBeNull()
    expect(liveProfileDir(other, home)).toBeNull()
    mkdirSync(join(home, '.claude-c'))
    expect(liveProfileDir(other, home)).toBe(join(home, '.claude-c'))
    const outside = acct({ id: ID(5), label: 'o', profile: join(root, 'outside') })
    mkdirSync(join(root, 'outside'))
    expect(liveProfileDir(outside, home)).toBeNull()
  })
})

describe('checkProfileFolder', () => {
  const ctx = (accounts: AgentAccount[] = [], selfId?: string) => ({ home, accounts, ...(selfId ? { selfId } : {}) })

  it('takes a new folder as its launch string, and the agent\'s default folder as null', () => {
    expect(checkProfileFolder('claude', join(home, '.claude-codedev') + sep, ctx())).toEqual({ profile: join(home, '.claude-codedev') })
    expect(checkProfileFolder('claude', join(home, '.claude'), ctx())).toEqual({ profile: null })
    expect(checkProfileFolder('codex', join(home, '.codex'), ctx())).toEqual({ profile: null })
  })

  it('refuses what can never be a profile', () => {
    expect(checkProfileFolder('claude', '', ctx())).toEqual({ error: 'no folder was chosen' })
    expect(checkProfileFolder('claude', 5, ctx())).toEqual({ error: 'no folder was chosen' })
    expect(checkProfileFolder('claude', join(home, 'a\u0001b'), ctx())).toEqual({ error: 'the folder name holds a control character' })
    expect(checkProfileFolder('claude', 'relative/.claude-x', ctx())).toEqual({ error: 'the folder is not a full path' })
    expect(checkProfileFolder('claude', join(home, 'x'), { home: '', accounts: [] })).toEqual({ error: 'your home folder is unknown, so no profile can be checked' })
    expect(checkProfileFolder('claude', join(root, 'outside'), ctx())).toEqual({ error: 'the folder is outside the test home' })
    expect(checkProfileFolder('claude', home, ctx())).toEqual({ error: 'your home folder itself can\'t be a profile' })
  })

  it('refuses a drive or filesystem root', () => {
    const r0 = process.platform === 'win32' ? 'C:\\' : '/'
    expect(checkProfileFolder('claude', r0, { home: r0 === '/' ? '/home/x' : 'C:\\Users\\x', accounts: [] }, { ...accountFs })).toEqual(
      process.env.TERMPOLIS_TEST_AGENT_HOME ? { error: 'the folder is outside the test home' } : { error: 'a drive or filesystem root can\'t be a profile' },
    )
    const saved = process.env.TERMPOLIS_TEST_AGENT_HOME
    delete process.env.TERMPOLIS_TEST_AGENT_HOME
    try {
      expect(checkProfileFolder('claude', r0, { home: r0 === '/' ? '/home/x' : 'C:\\Users\\x', accounts: [] })).toEqual({ error: 'a drive or filesystem root can\'t be a profile' })
    } finally {
      process.env.TERMPOLIS_TEST_AGENT_HOME = saved
    }
  })

  it('refuses a folder another account uses, and the default profile twice', () => {
    const accounts = [acct({ id: ID(1), label: 'personal' }), acct({ id: ID(2), label: 'codedev', profile: join(home, '.claude-codedev') })]
    expect(checkProfileFolder('claude', join(home, '.claude'), ctx(accounts))).toEqual({ error: 'personal already uses that folder' })
    expect(checkProfileFolder('claude', join(home, '.claude-codedev'), ctx(accounts))).toEqual({ error: 'codedev already uses that folder' })
    // Re-checking an account's own folder is fine.
    expect(checkProfileFolder('claude', join(home, '.claude-codedev'), ctx(accounts, ID(2)))).toEqual({ profile: join(home, '.claude-codedev') })
    // agy accounts have no folder and never clash.
    expect(checkProfileFolder('claude', join(home, '.claude-z'), ctx([acct({ id: ID(9), label: 'g', agent: 'agy' })]))).toEqual({ profile: join(home, '.claude-z') })
  })

  it('refuses a folder inside another profile, or holding one, and inside an agent\'s main profile', () => {
    const accounts = [acct({ id: ID(2), label: 'codedev', profile: join(home, 'profiles', 'codedev') })]
    expect(checkProfileFolder('claude', join(home, 'profiles', 'codedev', 'nested'), ctx(accounts))).toEqual({ error: 'that folder is inside codedev\'s profile, or holds it' })
    expect(checkProfileFolder('codex', join(home, 'profiles'), ctx(accounts))).toEqual({ error: 'that folder is inside codedev\'s profile, or holds it' })
    expect(checkProfileFolder('claude', join(home, '.claude', 'sub'), ctx())).toEqual({ error: 'that folder is inside an agent\'s main profile, or holds it' })
    expect(checkProfileFolder('claude', join(home, '.codex'), ctx())).toEqual({ error: 'that folder is inside an agent\'s main profile, or holds it' })
    expect(checkProfileFolder('codex', join(home, '.codex', 'x'), ctx())).toEqual({ error: 'that folder is inside an agent\'s main profile, or holds it' })
  })

  it('compares by realpath, so a link to a registered folder is the same folder', () => {
    const real = join(home, '.claude-real')
    mkdirSync(real)
    const alias = join(home, 'alias')
    link(real, alias)
    expect(checkProfileFolder('claude', alias, ctx([acct({ id: ID(2), label: 'real', profile: real })]))).toEqual({ error: 'real already uses that folder' })
  })
})

describe('discoverShares', () => {
  it('lists the subfolders that are links into the main profile', () => {
    const main = join(home, '.claude')
    for (const d of ['projects', 'skills']) mkdirSync(join(main, d), { recursive: true })
    const p = join(home, '.claude-x')
    mkdirSync(p)
    link(join(main, 'projects'), join(p, 'projects'))
    link(join(main, 'skills'), join(p, 'skills'))
    mkdirSync(join(root, 'elsewhere'))
    link(join(root, 'elsewhere'), join(p, 'commands'))
    mkdirSync(join(p, 'plain'))
    writeFileSync(join(p, 'settings.json'), '{}')
    expect(discoverShares('claude', p, home)).toEqual(['projects', 'skills'])
  })

  it('finds none without a home folder, a main profile or a readable folder', () => {
    expect(discoverShares('claude', join(home, 'x'), '')).toEqual([])
    expect(discoverShares('claude', join(home, 'x'), home)).toEqual([])
    mkdirSync(join(home, '.claude'))
    expect(discoverShares('claude', join(home, 'missing'), home)).toEqual([])
  })

  it('never looks into a link named like a sign-in file', () => {
    const main = join(home, '.claude')
    mkdirSync(join(main, 'projects'), { recursive: true })
    const p = join(home, '.claude-y')
    mkdirSync(p)
    link(join(main, 'projects'), join(p, 'auth.json'))
    expect(discoverShares('claude', p, home)).toEqual([])
  })
})

// A SYNTHETIC accounts.sh in the shape of the real one (never a real address in this repo).
const ACCOUNTS_SH = `# The Claude accounts on this machine.
ACCOUNTS=(personal codedev work)

declare -A ACCOUNT_EMAIL=(
  [personal]="personal@example.test"
  [codedev]='codedev@example.test'
  # a comment
  [work]=work@example.test   # trailing comment
)

DEFAULT_ACCOUNT=personal
declare -A ACCOUNT_DIR=(
  [personal]=".claude"
  [codedev]=".claude-codedev"
  [work]=".claude-work"
)

FAILOVER_ORDER=(personal codedev)
LIMIT_COOLDOWN=18000
account_for_dir() { :; }
`

function writeAccountsSh(text = ACCOUNTS_SH): string {
  const f = join(home, '.claude', 'accounts.sh')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(f, text)
  return f
}

describe('parseAccountsSh', () => {
  it('reads the tables with anchored patterns', () => {
    expect(parseAccountsSh(ACCOUNTS_SH)).toEqual({
      accounts: ['personal', 'codedev', 'work'],
      emails: { personal: 'personal@example.test', codedev: 'codedev@example.test', work: 'work@example.test' },
      dirs: { personal: '.claude', codedev: '.claude-codedev', work: '.claude-work' },
      defaultAccount: 'personal',
      failover: ['personal', 'codedev'],
      cooldown: 18000,
      refused: [],
    })
  })

  it('refuses any value holding $, a backtick or a backslash, and names that aren\'t plain', () => {
    const sh = parseAccountsSh(`ACCOUNTS=(ok bad\\name $x)
declare -A ACCOUNT_EMAIL=(
  [ok]="$HOME@x.yy"
  [two]="\`id\`@x.yy"
  [three]="a\\\\b@c.dd"
  [bad key]="x@y.zz"
  garbage line here
)
declare -A ACCOUNT_DIR=(
  [ok]=".claude-ok"
)
DEFAULT_ACCOUNT="$USER"
`)
    expect(sh.accounts).toEqual(['ok'])
    expect(sh.emails).toEqual({})
    expect(sh.dirs).toEqual({ ok: '.claude-ok' })
    expect(sh.defaultAccount).toBeUndefined()
    expect(sh.refused).toEqual([
      'ACCOUNTS: "bad\\name" is not a plain name',
      'ACCOUNTS: "$x" is not a plain name',
      'ACCOUNT_EMAIL[ok] holds $, ` or \\, so it was skipped',
      'ACCOUNT_EMAIL[two] holds $, ` or \\, so it was skipped',
      'ACCOUNT_EMAIL[three] holds $, ` or \\, so it was skipped',
      'ACCOUNT_EMAIL: "bad key" is not a plain name',
      'ACCOUNT_EMAIL: a line Termpolis can\'t read was skipped',
      'DEFAULT_ACCOUNT is not a plain name',
    ])
  })

  it('ends a table at its first ), so a value holding one cuts it short and nothing after it is taken', () => {
    const sh = parseAccountsSh(`declare -A ACCOUNT_EMAIL=(
  [a]="a@x.yy"
  [b]="$(curl evil)"
  [c]="c@x.yy"
)
`)
    expect(sh.emails).toEqual({ a: 'a@x.yy' })
    expect(sh.refused).toEqual(['ACCOUNT_EMAIL: a line Termpolis can\'t read was skipped'])
  })

  it('takes DEFAULT_ACCOUNT in every quoting, and leaves out what isn\'t there', () => {
    expect(parseAccountsSh("DEFAULT_ACCOUNT='a'").defaultAccount).toBe('a')
    expect(parseAccountsSh('DEFAULT_ACCOUNT="b" # c').defaultAccount).toBe('b')
    expect(parseAccountsSh('DEFAULT_ACCOUNT=c').defaultAccount).toBe('c')
    expect(parseAccountsSh('  # DEFAULT_ACCOUNT=x')).toEqual({ accounts: [], emails: {}, dirs: {}, failover: [], refused: [] })
    expect(parseAccountsSh('LIMIT_COOLDOWN=abc').cooldown).toBeUndefined()
  })
})

describe('readAccountsSh and previewAccountsSh', () => {
  it('reads nothing when the file is missing, outside the test home, or too large', () => {
    expect(readAccountsSh(home)).toEqual({ kind: 'missing' })
    expect(readAccountsSh('')).toEqual({ kind: 'missing' })
    expect(accountsShPath('rel')).toBeNull()
    writeAccountsSh('#'.repeat(64 * 1024 + 1))
    expect(readAccountsSh(home)).toEqual({ kind: 'error', error: 'accounts.sh is larger than 64 KB or can\'t be read' })
    expect(previewAccountsSh(home, parseAccountsDoc({}))).toEqual({ error: 'accounts.sh is larger than 64 KB or can\'t be read' })
    rmSync(join(home, '.claude', 'accounts.sh'))
    expect(previewAccountsSh(home, parseAccountsDoc({}))).toEqual({ error: '~/.claude/accounts.sh doesn\'t exist' })
  })

  it('previews the import in failover order: the default profile as null, work never offered automatically', () => {
    writeAccountsSh()
    mkdirSync(join(home, '.claude', 'projects'))
    mkdirSync(join(home, '.claude-codedev'))
    link(join(home, '.claude', 'projects'), join(home, '.claude-codedev', 'projects'))
    const p = previewAccountsSh(home, parseAccountsDoc({}))
    expect(p).toEqual({
      rows: [
        { key: 'personal', label: 'personal', email: 'personal@example.test', profile: null, autoOffer: true, order: 0, registered: false, folderExists: true, shares: [] },
        { key: 'codedev', label: 'codedev', email: 'codedev@example.test', profile: launchString(home + sep + '.claude-codedev'), autoOffer: true, order: 1, registered: false, folderExists: true, shares: ['projects'] },
        { key: 'work', label: 'work', email: 'work@example.test', profile: launchString(home + sep + '.claude-work'), autoOffer: false, order: 2, registered: false, folderExists: false, shares: [] },
      ],
      refused: [],
      cooldownSec: 18000,
    })
  })

  it('marks rows already registered, and refuses a folder that isn\'t a plain name or a second default', () => {
    writeAccountsSh(`ACCOUNTS=(personal codedev odd also)
declare -A ACCOUNT_EMAIL=(
  [personal]="nope"
)
declare -A ACCOUNT_DIR=(
  [personal]=".claude"
  [codedev]=".claude-codedev"
  [odd]="../etc"
  [also]=".claude"
)
DEFAULT_ACCOUNT=personal
`)
    const doc = docWith(acct({ id: ID(1), label: 'mine', profile: join(home, '.claude-codedev') }))
    const p = previewAccountsSh(home, doc)
    if ('error' in p) throw new Error(p.error)
    expect(p.rows.map((r) => [r.key, r.registered, r.email])).toEqual([['personal', false, undefined], ['codedev', true, undefined]])
    expect(p.refused).toEqual(['odd: its folder isn\'t a plain folder name in your home folder', 'also: only one account can be the default profile'])
    expect(p).not.toHaveProperty('cooldownSec')
  })
})

describe('accountsShDrift', () => {
  it('says nothing without an accounts.sh', () => {
    expect(accountsShDrift(home, parseAccountsDoc({}))).toEqual({ lines: [], unlisted: 0 })
  })

  it('names every difference, one sentence each', () => {
    writeAccountsSh()
    const doc = docWith(
      acct({ id: ID(1), label: 'personal', importedAs: 'personal', email: 'personal@example.test' }),
      acct({ id: ID(2), label: 'dev', importedAs: 'codedev', email: 'other@example.test', profile: join(home, '.claude-elsewhere') }),
      acct({ id: ID(3), label: 'gone', importedAs: 'old', profile: join(home, '.claude-old') }),
      acct({ id: ID(4), label: 'mine', profile: join(home, '.claude-mine') }),
      acct({ id: ID(5), label: 'cx', agent: 'codex', profile: join(home, '.codex-x') }),
    )
    const d = accountsShDrift(home, doc)
    expect(d.lines).toEqual([
      'accounts.sh gives codedev another email than Termpolis has for dev.',
      'accounts.sh puts codedev in another folder than Termpolis has for dev.',
      'gone was imported as old, which accounts.sh no longer lists.',
      'accounts.sh lists work, which Termpolis hasn\'t imported.',
      'dev isn\'t in accounts.sh, so your status line and failover hook count its sessions as personal. Add it there to fix that.',
      'gone isn\'t in accounts.sh, so your status line and failover hook count its sessions as personal. Add it there to fix that.',
      'mine isn\'t in accounts.sh, so your status line and failover hook count its sessions as personal. Add it there to fix that.',
    ])
    expect(d.unlisted).toBe(3)
  })

  it('finds no drift when the registry matches, and names the default account when accounts.sh has none', () => {
    writeAccountsSh()
    const match = docWith(
      acct({ id: ID(1), label: 'personal', importedAs: 'personal', email: 'personal@example.test' }),
      acct({ id: ID(2), label: 'codedev', importedAs: 'codedev', email: 'CODEDEV@example.test', profile: launchString(home + sep + '.claude-codedev') }),
      acct({ id: ID(3), label: 'work', importedAs: 'work', profile: launchString(home + sep + '.claude-work') }),
    )
    expect(accountsShDrift(home, match)).toEqual({ lines: [], unlisted: 0 })
    writeAccountsSh('ACCOUNTS=(a)\ndeclare -A ACCOUNT_DIR=(\n  [a]=".claude-a"\n)\n')
    const d = accountsShDrift(home, docWith(acct({ id: ID(4), label: 'b', profile: join(home, '.claude-b') })))
    expect(d.lines).toContain('b isn\'t in accounts.sh, so your status line and failover hook count its sessions as the default account. Add it there to fix that.')
  })
})

describe('accountsShLines', () => {
  it('gives the three lines that make the scripts know a new account, and none without the file', () => {
    expect(accountsShLines(home, 'Foo', 'me@example.test', join(home, '.claude-foo'))).toBeNull()
    writeAccountsSh()
    expect(accountsShLines(home, 'Foo Bar', 'me@example.test', join(home, '.claude-foo-bar'))).toEqual([
      'ACCOUNTS=(personal codedev work foo-bar)   # add foo-bar',
      '  [foo-bar]="me@example.test"   # in ACCOUNT_EMAIL',
      '  [foo-bar]=".claude-foo-bar"   # in ACCOUNT_DIR',
    ])
    expect(accountsShLines(home, '日本', undefined, join(home, '.claude-x'))?.[1]).toBe('  [account]=""   # in ACCOUNT_EMAIL')
  })

  // SAFETY-R2-2: the lines are pasted into a file the user's scripts SOURCE, where a folder name holding a command
  // substitution would run at every status-line render. Termpolis's own reading of the file refuses such a value, and its
  // import takes only [A-Za-z0-9._-] folder names: the lines are offered for the same names, and for no other.
  it('offers no lines for a folder whose name the scripts could not read safely', () => {
    writeAccountsSh()
    for (const name of ['.claude-$(touch pwned)', '.claude-`id`', '.claude-a"b', '.claude-a b', '.claude-a;b', '.claude-$HOME', '.claude-a&b', '.claude-a|b', '.claude-a\'b', '.claude-é']) {
      expect(accountsShLines(home, 'side', 'me@example.test', join(home, name)), name).toBeNull()
    }
    for (const name of ['.claude-side', '.claude-side_2.x', '.claude-A-b', 'plain']) {
      expect(accountsShLines(home, 'side', 'me@example.test', join(home, name)), name).not.toBeNull()
    }
  })
})

describe('limitedMarker', () => {
  it('reads the hook\'s epoch-seconds marker, read-only', () => {
    writeAccountsSh()
    writeFileSync(join(home, '.claude', '.limited-codedev'), '1792347851\n')
    expect(limitedMarker(home, 'codedev')).toBe(1792347851)
    writeFileSync(join(home, '.claude', '.limited-junk'), 'soon')
    expect(limitedMarker(home, 'junk')).toBeNull()
    writeFileSync(join(home, '.claude', '.limited-big'), '1'.repeat(100))
    expect(limitedMarker(home, 'big')).toBeNull()
    expect(limitedMarker(home, 'missing')).toBeNull()
    expect(limitedMarker(home, undefined)).toBeNull()
    expect(limitedMarker(home, '../x')).toBeNull()
    expect(limitedMarker('', 'codedev')).toBeNull()
    const saved = process.env.TERMPOLIS_TEST_AGENT_HOME
    process.env.TERMPOLIS_TEST_AGENT_HOME = join(root, 'other')
    try {
      expect(limitedMarker(home, 'codedev')).toBeNull()
    } finally {
      process.env.TERMPOLIS_TEST_AGENT_HOME = saved
    }
  })
})

describe('lastSignedInAs', () => {
  it('reads the email from the profile\'s .claude.json, ~/.claude.json for the default profile', () => {
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'p@example.test' }, primaryApiKey: 'a'.repeat(40) }))
    const def = acct({ id: ID(1), label: 'p' })
    expect(lastSignedInAs(def, home, docWith(def))).toBe('p@example.test')
    const other = acct({ id: ID(2), label: 'c', profile: join(home, '.claude-c') })
    expect(lastSignedInAs(other, home, docWith(other))).toBeNull()
    mkdirSync(join(home, '.claude-c'))
    expect(lastSignedInAs(other, home, docWith(other))).toBeNull()
    writeFileSync(join(home, '.claude-c', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'not an email' } }))
    expect(lastSignedInAs(other, home, docWith(other))).toBeNull()
    writeFileSync(join(home, '.claude-c', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'c@example.test' } }))
    expect(lastSignedInAs(other, home, docWith(other))).toBe('c@example.test')
    expect(lastSignedInAs(def, '', docWith(def))).toBeNull()
  })

  it('takes Codex\'s from the last account/read, and has none for agy', () => {
    const codex = acct({ id: ID(3), label: 'x', agent: 'codex', profile: null })
    const doc = docWith(codex)
    expect(lastSignedInAs(codex, home, doc)).toBeNull()
    doc.file.identity[ID(3)] = { email: 'x@example.test', signedIn: true, checkedAt: 1, source: 'login-status' }
    expect(lastSignedInAs(codex, home, doc)).toBeNull()
    doc.file.identity[ID(3)] = { email: 'x@example.test', signedIn: true, checkedAt: 1, source: 'account-read' }
    expect(lastSignedInAs(codex, home, doc)).toBe('x@example.test')
    const agy = acct({ id: ID(4), label: 'g', agent: 'agy' })
    expect(lastSignedInAs(agy, home, docWith(agy))).toBeNull()
  })
})

describe('accounts as profile targets', () => {
  it('lists every Claude and Codex profile that exists, connected ones only when asked', () => {
    for (const d of ['.claude', '.claude-on', '.claude-off', '.codex-w']) mkdirSync(join(home, d))
    const doc = docWith(
      acct({ id: ID(1), label: 'default' }),
      acct({ id: ID(2), label: 'on', profile: join(home, '.claude-on'), connect: true }),
      acct({ id: ID(3), label: 'off', profile: join(home, '.claude-off'), connect: false }),
      acct({ id: ID(4), label: 'gone', profile: join(home, '.claude-gone'), connect: true }),
      acct({ id: ID(5), label: 'cw', agent: 'codex', profile: join(home, '.codex-w'), connect: true }),
      acct({ id: ID(6), label: 'g', agent: 'agy' }),
    )
    expect(accountProfileTargets({ home }, doc, { connectedOnly: true })).toEqual([
      { agent: 'claude', dir: join(home, '.claude'), claudeJson: join(home, '.claude.json'), accountId: ID(1) },
      { agent: 'claude', dir: join(home, '.claude-on'), claudeJson: join(home, '.claude-on', '.claude.json'), accountId: ID(2) },
      { agent: 'codex', dir: join(home, '.codex-w'), accountId: ID(5) },
    ])
    expect(accountProfileTargets({ home }, doc, { connectedOnly: false }).map((t) => t.accountId)).toEqual([ID(1), ID(2), ID(3), ID(5)])
  })

  it('finds accounts by id, says which are connected, and gives each agent its cooldown', () => {
    const doc = docWith(acct({ id: ID(1), label: 'a' }), acct({ id: ID(2), label: 'b', profile: '/b' }))
    expect(findAccount(doc, ID(2))?.label).toBe('b')
    expect(findAccount(doc, 3)).toBeUndefined()
    expect(isAccountConnected(undefined)).toBe(true)
    expect(isAccountConnected(doc.file.accounts[0])).toBe(true)
    expect(isAccountConnected(doc.file.accounts[1])).toBe(false)
    expect(isAccountConnected({ ...doc.file.accounts[1], connect: true })).toBe(true)
    expect(cooldownFor(doc, 'claude')).toBe(18000)
    doc.file.cooldownSec.claude = 60
    expect(cooldownFor(doc, 'claude')).toBe(60)
  })
})
