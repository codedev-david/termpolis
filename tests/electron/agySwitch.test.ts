// @vitest-environment node
//
// agy's guided account switch (src/main/agySwitch.ts), against a mock agy drawn as agy 1.4.3 draws
// itself (_switchTerminal.ts; its strings from agy's own program file, agy-signin.md). The real agy
// never runs here: a sign-out would sign David out of agy everywhere. What it pins:
//   - agy exits only while live, with /exit; never Ctrl+C (which also stops a turn) or Ctrl+D;
//   - its own /logout, in its own box, once the box shows it; the sign-in is never answered;
//   - the sign-in counts as finished only once agy's box is back after its sign-in screen;
//   - the same conversation resumes by its exact id, the first exit's, never a later one's;
//   - each step Termpolis can't drive safely says what to type, in exact words.
import { describe, it, expect, beforeEach } from 'vitest'
import { AGY_ENV_AUTH, AGY_START_MS, runAgyStep, shownEmail } from '../../src/main/agySwitch'
import { _resetSwitchLocksForTest, locks, relaunchLockReason } from '../../src/main/accountSwitch'
import type { AgyStepOutcome, AgyStepRequest } from '../../src/shared/accountSwitch'
import { FakeTerminal, ID, THROWAWAY, keys } from './_switchTerminal'
import type { TermScript } from './_switchTerminal'

const agy = (over: Partial<TermScript> = {}): TermScript => ({ agent: 'agy', family: 'posix', start: 'idle', exit: 'hint', ...over })

function step(t: FakeTerminal, req: Partial<AgyStepRequest>, env: Record<string, string> = {}) {
  const recorded: unknown[] = []
  const p = runAgyStep(
    { terminalId: 't1', targetId: 'g2', shellType: 'gitbash', step: 'sign-out', ...req },
    { io: t.io(), start: { at: t.launchedAt, commands: [t.launchLine()] }, env, record: (r) => recorded.push(r) },
  )
  return { p, recorded }
}

beforeEach(() => _resetSwitchLocksForTest())

describe('sign-out: exit, a new agy, its own /logout', () => {
  it('exits the live agy with /exit, reads its id, starts agy and types /logout into it', async () => {
    const t = new FakeTerminal(agy())
    const out = await step(t, {}).p
    expect(out).toEqual({ kind: 'signing-in', conversationId: ID, mark: expect.any(Number) })
    expect(t.writes).toEqual(['/exit', '\r', '\u0015', '\r', 'agy', '\r', '/logout', '\r'])
    expect(t.ran).toEqual(['', 'agy'])
    expect(t.signedOut).toBe(true)
    expect(keys(t)).not.toMatch(/[\u0003\u0004]/)
    expect(t.sentPrompts).toEqual([])
    expect(relaunchLockReason('t1', t.clock)).toBeNull()
  })

  it('types nothing to an agy already gone: its hint on screen names the conversation', async () => {
    const t = new FakeTerminal(agy({ start: 'gone-hint' }))
    expect(await step(t, {}).p).toEqual(expect.objectContaining({ kind: 'signing-in', conversationId: ID }))
    expect(t.writes[0]).toBe('\u0015')
  })

  it('names no conversation when agy left no hint: gone by its prompt, or exited printing none', async () => {
    const gone = new FakeTerminal(agy({ start: 'gone-quiet' }))
    expect(await step(gone, {}).p).toEqual(expect.objectContaining({ kind: 'signing-in', conversationId: null }))
    const quiet = new FakeTerminal(agy({ exit: 'no-hint' }))
    expect(await step(quiet, {}).p).toEqual(expect.objectContaining({ kind: 'signing-in', conversationId: null }))
    // With no mark, the check reads the whole output.
    quiet.completeSignIn()
    expect(await step(quiet, { step: 'check' }).p).toEqual({ kind: 'signed-in' })
  })

  it('goes straight to the sign-in when the new agy starts signed out', async () => {
    const t = new FakeTerminal(agy({ start: 'gone-hint' }))
    t.signedOut = true
    expect(await step(t, {}).p).toEqual(expect.objectContaining({ kind: 'signing-in', conversationId: ID }))
    expect(keys(t)).not.toContain('/logout')
  })

  it('says to type /login when /logout brings agy\'s box back with no sign-in', async () => {
    const t = new FakeTerminal(agy({ logout: 'box' }))
    expect(await step(t, {}).p).toEqual(expect.objectContaining({ kind: 'needs-login', conversationId: ID }))
  })

  it('refuses where agy signs in from the environment, typing nothing', async () => {
    for (const name of AGY_ENV_AUTH) {
      const t = new FakeTerminal(agy())
      expect(await step(t, {}, { [name]: 'x' }).p).toEqual({ kind: 'refused', why: `agy signs in with ${name} from the environment here, so /logout signs nothing out: change ${name} instead` })
      expect(t.writes).toEqual([])
    }
  })

  it('asks when it can\'t tell whether agy runs, and takes the user\'s word', async () => {
    const t = new FakeTerminal(agy({ start: 'blank' }))
    expect(await step(t, {}).p).toEqual({ kind: 'unknown-exit' })
    expect(t.writes).toEqual([])
    const said = new FakeTerminal(agy({ start: 'gone-quiet' }))
    expect(await step(said, { assumeExited: true }).p).toEqual(expect.objectContaining({ kind: 'signing-in', conversationId: null }))
    const hinted = new FakeTerminal(agy({ start: 'gone-hint' }))
    expect(await step(hinted, { assumeExited: true }).p).toEqual(expect.objectContaining({ kind: 'signing-in', conversationId: ID }))
  })

  it('says what to type wherever it can\'t drive a step', async () => {
    const busy = new FakeTerminal(agy({ start: 'busy' }))
    expect(await step(busy, {}).p).toEqual({ kind: 'do-it-yourself', say: 'agy isn\'t at its input: let it finish, or answer what it asks, then type /exit in agy and switch again.' })
    expect(busy.writes).toEqual([])
    const noEcho = new FakeTerminal(agy({ exit: 'no-echo' }))
    expect(await step(noEcho, {}).p).toEqual({ kind: 'do-it-yourself', say: 'Termpolis couldn\'t type /exit into agy: type /exit in agy yourself, then switch again.' })
    const ignore = new FakeTerminal(agy({ exit: 'ignore' }))
    expect(await step(ignore, {}).p).toEqual({ kind: 'do-it-yourself', say: 'Termpolis couldn\'t confirm agy exited: type /exit in agy yourself, then switch again.' })
    const dead = new FakeTerminal(agy({ start: 'gone-hint', shellDead: true }))
    expect(await step(dead, {}).p).toEqual({ kind: 'do-it-yourself', say: 'Termpolis couldn\'t start agy here: type agy, then /logout in it, and sign in again.', line: 'agy' })
    const hangs = new FakeTerminal(agy({ start: 'gone-hint', agyHangs: true }))
    const hung = await step(hangs, {}).p
    expect(hung).toEqual({ kind: 'do-it-yourself', say: 'agy didn\'t come up: type /logout in agy once it shows its input, and sign in again.', line: `agy --conversation=${ID}` })
    expect(hangs.clock).toBeGreaterThanOrEqual(AGY_START_MS)
  })

  it('says to type /logout itself when agy never shows it in its box', async () => {
    const t = new FakeTerminal(agy({ start: 'gone-hint' }))
    const io = t.io()
    // The new agy takes no typing (its box never shows what is typed).
    const out = await runAgyStep({ terminalId: 't1', targetId: 'g2', shellType: 'gitbash', step: 'sign-out' }, {
      io: { ...io, write: (id, d) => { if (d === '/logout') return; io.write(id, d) } }, env: {}, record: () => undefined,
    })
    expect(out).toEqual({ kind: 'do-it-yourself', say: 'Termpolis couldn\'t type /logout into agy: type /logout in agy yourself, and sign in again.', line: `agy --conversation=${ID}` })
  })

  it('says when agy shows neither its sign-in nor its box after /logout', async () => {
    const t = new FakeTerminal(agy({ start: 'gone-hint' }))
    const io = t.io()
    let blanked = false
    const out = await runAgyStep({ terminalId: 't1', targetId: 'g2', shellType: 'gitbash', step: 'sign-out' }, {
      io: { ...io, write: (id, d) => { io.write(id, d); if (d === '\r' && t.signedOut && !blanked) { blanked = true; t.out += '\x1b[H\x1b[2Jworking…' } } },
      env: {}, record: () => undefined,
    })
    expect(out).toEqual({ kind: 'do-it-yourself', say: 'agy didn\'t show its sign-in: type /login in agy and sign in there.' })
  })
})

describe('login: on the user\'s click only', () => {
  it('types /login into agy\'s box and finds its sign-in', async () => {
    const t = new FakeTerminal(agy({ logout: 'box' }))
    const first = await step(t, {}).p as Extract<AgyStepOutcome, { kind: 'needs-login' }>
    t.writes.length = 0
    expect(await step(t, { step: 'login', conversationId: first.conversationId, mark: first.mark }).p).toEqual(expect.objectContaining({ kind: 'signing-in', conversationId: ID }))
    expect(t.writes).toEqual(['/login', '\r'])
  })

  it('says to type /login when agy isn\'t at its box, or never shows it', async () => {
    const t = new FakeTerminal(agy({ start: 'busy' }))
    expect(await step(t, { step: 'login' }).p).toEqual({ kind: 'do-it-yourself', say: 'Type /login in agy and sign in there.' })
    const noEcho = new FakeTerminal(agy({ exit: 'no-echo' }))
    expect(await step(noEcho, { step: 'login' }).p).toEqual({ kind: 'do-it-yourself', say: 'Termpolis couldn\'t type /login into agy: type /login in agy yourself and sign in there.' })
  })
})

describe('check: has the user signed in?', () => {
  it('waits while the sign-in shows, and answers signed in once agy\'s box is back after it', async () => {
    const t = new FakeTerminal(agy())
    const out = await step(t, {}).p as Extract<AgyStepOutcome, { kind: 'signing-in' }>
    expect(await step(t, { step: 'check', mark: out.mark }).p).toEqual({ kind: 'waiting' })
    t.completeSignIn('work.user@example.test')
    expect(await step(t, { step: 'check', mark: out.mark }).p).toEqual({ kind: 'signed-in' })
    // Only the box after the sign-in counts: a box with no sign-in since the mark is not one.
    expect(await step(t, { step: 'check', mark: t.out.length }).p).toEqual({ kind: 'waiting' })
    // The check holds no lock, and types nothing.
    expect(locks.size).toBe(0)
  })
})

describe('resume: the same conversation, by its exact id', () => {
  async function signedIn(script: Partial<TermScript> = {}): Promise<{ t: FakeTerminal; conversationId: string | null }> {
    const t = new FakeTerminal(agy(script))
    const out = await step(t, {}).p as Extract<AgyStepOutcome, { kind: 'signing-in' }>
    t.completeSignIn('work.user@example.test')
    t.writes.length = 0
    t.ran.length = 0
    return { t, conversationId: out.conversationId }
  }

  it('exits the agy it signed in with and resumes the first conversation, never the later one', async () => {
    const { t, conversationId } = await signedIn()
    const { p, recorded } = step(t, { step: 'resume', conversationId })
    expect(await p).toEqual({ kind: 'switched', fresh: false, conversationId: ID, shownEmail: 'work.user@example.test' })
    expect(t.writes.slice(0, 2)).toEqual(['/exit', '\r'])
    expect(t.ran).toEqual(['', `agy --conversation=${ID}`])
    expect(keys(t)).not.toContain(THROWAWAY)
    expect(recorded).toEqual([{ start: { at: expect.any(Number), commands: [`agy --conversation=${ID}`] } }])
  })

  it('says so when agy started a new conversation instead, or had none to resume', async () => {
    const lost = await signedIn({ relaunch: ['not-found'] })
    expect(await step(lost.t, { step: 'resume', conversationId: lost.conversationId }).p).toEqual(expect.objectContaining({ kind: 'switched', fresh: true, conversationId: null }))
    const none = await signedIn()
    expect(await step(none.t, { step: 'resume', conversationId: null }).p).toEqual(expect.objectContaining({ kind: 'switched', fresh: true }))
    expect(none.t.ran[1]).toBe('agy')
  })

  it('gives the exact words to finish by hand when a step can\'t be driven', async () => {
    const stuck = await signedIn({ exit: 'ignore' })
    expect(await step(stuck.t, { step: 'resume', conversationId: ID }).p).toEqual({ kind: 'do-it-yourself', say: `Type /exit in agy, then: agy --conversation=${ID}`, line: `agy --conversation=${ID}` })
    const signedOut = await signedIn({ relaunch: ['sign-in'] })
    expect(await step(signedOut.t, { step: 'resume', conversationId: ID }).p).toEqual({ kind: 'do-it-yourself', say: 'agy is still signed out: sign in there, then it continues.' })
    const silent = await signedIn({ relaunch: ['nothing'] })
    expect(await step(silent.t, { step: 'resume', conversationId: ID }).p).toEqual({ kind: 'do-it-yourself', say: `agy didn't come back within 30 seconds: look at the terminal. The conversation resumes with agy --conversation=${ID}.`, line: `agy --conversation=${ID}` })
    const dead = await signedIn()
    dead.t.s.shellDead = true
    expect(await step(dead.t, { step: 'resume', conversationId: ID }).p).toEqual({ kind: 'do-it-yourself', say: `Termpolis couldn't type the line: type agy --conversation=${ID} in the terminal.`, line: `agy --conversation=${ID}` })
  })

  it('resumes from a shell the user says agy left, and shows no email when agy shows none', async () => {
    const t = new FakeTerminal(agy({ start: 'gone-quiet', email: 'no address here' }))
    expect(await step(t, { step: 'resume', conversationId: ID, assumeExited: true }).p).toEqual({ kind: 'switched', fresh: false, conversationId: ID })
  })
})

describe('what every step refuses', () => {
  it('refuses a shell it can\'t type into, a held terminal, and an error, letting the lock go', async () => {
    const t = new FakeTerminal(agy())
    expect(await step(t, {}).p, 'shell').toBeDefined()
    expect(await runAgyStep({ terminalId: 't1', targetId: 'g2', shellType: 'fish', step: 'sign-out' }, { io: t.io(), env: {}, record: () => undefined }))
      .toEqual({ kind: 'refused', why: 'Termpolis can\'t type into this terminal\'s shell' })
    // Held by a switch, or by the model picker.
    for (const kind of ['account', 'model'] as const) {
      locks.set('t1', { until: t.clock + 1000, kind, key: 'k' })
      expect(await step(t, { step: 'login' }).p).toEqual({ kind: 'refused', why: 'a switch is already running in this terminal' })
    }
    locks.clear()
    const broken = await runAgyStep({ terminalId: 't1', targetId: 'g2', shellType: 'bash', step: 'resume' }, {
      io: { ...t.io(), output: () => { throw new Error('buffer gone') } }, env: {}, record: () => undefined,
    })
    expect(broken).toEqual({ kind: 'refused', why: 'buffer gone' })
    const odd = await runAgyStep({ terminalId: 't1', targetId: 'g2', shellType: 'bash', step: 'resume' }, {
      io: { ...t.io(), output: () => { throw 'odd' } }, env: {}, record: () => undefined,
    })
    expect(odd).toEqual({ kind: 'refused', why: 'odd' })
    expect(locks.size).toBe(0)
  })
})

describe('shownEmail', () => {
  it('reads an address from agy\'s header rows, loosely, and nothing past them', () => {
    expect(shownEmail(['      ▄▀▀▄        Antigravity CLI 1.4.3', '     ▀▀▀▀▀▀       a.b+c@mail.example.co (Google AI Pro)'])).toBe('a.b+c@mail.example.co')
    expect(shownEmail(['no address'])).toBeNull()
    expect(shownEmail([...Array.from({ length: 10 }, () => ''), 'late@example.test'])).toBeNull()
  })
})
