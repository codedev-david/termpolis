// @vitest-environment node
//
// agy's switch-all, a terminal's two steps (src/main/agySwitch.ts), against a mock agy drawn as agy
// 1.4.3 draws itself (_switchTerminal.ts; its strings from agy's own program file, agy-signin.md).
// The real agy never runs here: a sign-out would sign David out of agy everywhere. The sign-in
// itself runs in main's hidden session (signInSession.test.ts). What it pins:
//   - agy exits only while live and at its input, with /exit; never Ctrl+C (which also stops a
//     turn) or Ctrl+D; a turn at work is waited for, never stopped;
//   - the same conversation resumes by its exact id, the exit's;
//   - a step Termpolis can't drive says why and types nothing more: no command handed to the user.
import { describe, it, expect, beforeEach } from 'vitest'
import { AGY_ENV_AUTH, agyEnvAuth, runAgyStep, shownEmail } from '../../src/main/agySwitch'
import { _resetSwitchLocksForTest, locks, relaunchLockReason } from '../../src/main/accountSwitch'
import type { AgyStepRequest } from '../../src/shared/accountSwitch'
import { FakeTerminal, ID, keys } from './_switchTerminal'
import type { TermScript } from './_switchTerminal'

const agy = (over: Partial<TermScript> = {}): TermScript => ({ agent: 'agy', family: 'posix', start: 'idle', exit: 'hint', ...over })

function step(t: FakeTerminal, req: Partial<AgyStepRequest>, env: Record<string, string> = {}) {
  const recorded: unknown[] = []
  const p = runAgyStep(
    { terminalId: 't1', targetId: 'g2', shellType: 'gitbash', step: 'exit', ...req },
    { io: t.io(), start: { at: t.launchedAt, commands: [t.launchLine()] }, env, record: (r) => recorded.push(r) },
  )
  return { p, recorded }
}

beforeEach(() => _resetSwitchLocksForTest())

describe('exit: agy out of the terminal, by its own /exit', () => {
  it('exits the live agy with /exit, entered once its box shows it, and reads its conversation\'s id', async () => {
    const t = new FakeTerminal(agy())
    expect(await step(t, {}).p).toEqual({ kind: 'exited', conversationId: ID })
    expect(t.writes).toEqual(['/exit', '\r'])
    expect(keys(t)).not.toMatch(/[\u0003\u0004]/)
    expect(t.sentPrompts).toEqual([])
    expect(relaunchLockReason('t1', t.clock)).toBeNull()
  })

  it('types nothing to an agy already gone: its hint on screen names the conversation', async () => {
    const t = new FakeTerminal(agy({ start: 'gone-hint' }))
    expect(await step(t, {}).p).toEqual({ kind: 'exited', conversationId: ID })
    expect(t.writes).toEqual([])
  })

  it('names no conversation when agy left no hint: gone by its prompt, or exited printing none', async () => {
    expect(await step(new FakeTerminal(agy({ start: 'gone-quiet' })), {}).p).toEqual({ kind: 'exited', conversationId: null })
    expect(await step(new FakeTerminal(agy({ exit: 'no-hint' })), {}).p).toEqual({ kind: 'exited', conversationId: null })
  })

  it('waits for a turn at work, and for a question agy asks: nothing is typed', async () => {
    for (const start of ['busy', 'question'] as const) {
      const t = new FakeTerminal(agy({ start }))
      expect(await step(t, {}).p).toEqual({ kind: 'busy' })
      expect(t.writes).toEqual([])
    }
  })

  it('asks the user when it can\'t tell whether agy runs, and takes their word with its hint', async () => {
    const t = new FakeTerminal(agy({ start: 'blank' }))
    expect(await step(t, {}).p).toEqual({ kind: 'unknown-exit' })
    expect(t.writes).toEqual([])
    expect(await step(t, { assumeExited: true }).p).toEqual({ kind: 'exited', conversationId: null })
    const hinted = new FakeTerminal(agy({ start: 'gone-hint' }))
    expect(await step(hinted, { assumeExited: true }).p).toEqual({ kind: 'exited', conversationId: ID })
  })

  it('says why when /exit can\'t be typed or isn\'t confirmed, and types nothing more', async () => {
    const noEcho = new FakeTerminal(agy({ exit: 'no-echo' }))
    expect(await step(noEcho, {}).p).toEqual({ kind: 'not-exited', why: 'Termpolis couldn\'t type /exit into agy\'s input, so it typed nothing more' })
    const ignores = new FakeTerminal(agy({ exit: 'ignore' }))
    expect(await step(ignores, {}).p).toEqual({ kind: 'not-exited', why: 'agy didn\'t confirm it exited, so Termpolis typed nothing more' })
    expect(ignores.writes).toEqual(['/exit', '\r'])
  })

  it('refuses, before anything is typed, where agy signs in from the environment, by the name only', async () => {
    for (const name of AGY_ENV_AUTH) {
      const t = new FakeTerminal(agy())
      const out = await step(t, {}, { [name]: 'a'.repeat(40) }).p
      expect(out).toEqual({ kind: 'refused', why: `agy signs in with ${name} from the environment here, so switching its sign-in changes nothing: change ${name} instead` })
      expect(JSON.stringify(out)).not.toContain('aaaa')
      expect(t.writes).toEqual([])
    }
    expect(agyEnvAuth({ GEMINI_API_KEY: '' })).toBeNull()
  })

  it('refuses a shell it can\'t type into, a terminal another switch holds, and an error, unlocking after', async () => {
    const t = new FakeTerminal(agy())
    expect(await step(t, { shellType: 'nushell' }).p).toEqual({ kind: 'refused', why: 'Termpolis can\'t type into this terminal\'s shell' })
    locks.set('t1', { until: t.clock + 60_000, kind: 'account' })
    expect(await step(t, {}).p).toEqual({ kind: 'refused', why: 'a switch is already running in this terminal' })
    _resetSwitchLocksForTest()
    const broken = runAgyStep({ terminalId: 't1', targetId: 'g2', shellType: 'gitbash', step: 'exit' }, { io: { ...t.io(), write: () => { throw new Error('the PTY is gone') } }, env: {}, record: () => undefined })
    expect(await broken).toEqual({ kind: 'refused', why: 'the PTY is gone' })
    const odd = runAgyStep({ terminalId: 't1', targetId: 'g2', shellType: 'gitbash', step: 'exit' }, { io: { ...t.io(), write: () => { throw 'odd' } }, env: {}, record: () => undefined })
    expect(await odd).toEqual({ kind: 'refused', why: 'odd' })
    expect(relaunchLockReason('t1', t.clock)).toBeNull()
  })
})

describe('resume: the conversation by its exact id', () => {
  async function exited(over: Partial<TermScript> = {}): Promise<FakeTerminal> {
    const t = new FakeTerminal(agy(over))
    await step(t, {}).p
    t.writes.length = 0
    return t
  }

  it('types agy --conversation=<id> at the prompt, entered once it shows there, and records the start', async () => {
    const t = await exited({ email: 'new.person@example.test' })
    const { p, recorded } = step(t, { step: 'resume', conversationId: ID })
    expect(await p).toEqual({ kind: 'resumed', fresh: false, conversationId: ID, shownEmail: 'new.person@example.test' })
    expect(t.ran).toContain(`agy --conversation=${ID}`)
    expect(recorded).toEqual([{ start: { at: expect.any(Number), commands: [`agy --conversation=${ID}`] } }])
    expect(keys(t)).not.toMatch(/[\u0003\u0004]/)
  })

  it('starts a new conversation with no id, and says so when agy found no such one', async () => {
    const none = await exited()
    expect(await step(none, { step: 'resume', conversationId: null }).p).toEqual(expect.objectContaining({ kind: 'resumed', fresh: true, conversationId: null }))
    expect(none.ran).toContain('agy')
    const lost = await exited({ relaunch: ['not-found'] })
    expect(await step(lost, { step: 'resume', conversationId: ID }).p).toEqual(expect.objectContaining({ kind: 'resumed', fresh: true, conversationId: null }))
  })

  it('shows no email agy\'s header didn\'t show', async () => {
    const t = await exited({ email: '' })
    expect(await step(t, { step: 'resume', conversationId: ID }).p).toEqual({ kind: 'resumed', fresh: false, conversationId: ID })
  })

  it('says why it didn\'t resume: the line never showed, agy still signed out, nothing came back, another shell', async () => {
    const dead = await exited({ shellDead: true })
    expect(await step(dead, { step: 'resume', conversationId: ID }).p).toEqual({ kind: 'not-resumed', why: 'the line never showed in the terminal, so nothing was entered' })
    const signedOut = await exited({ relaunch: ['sign-in'] })
    expect(await step(signedOut, { step: 'resume', conversationId: ID }).p).toEqual({ kind: 'not-resumed', why: 'agy shows its sign-in in the terminal: it isn\'t signed in' })
    const quiet = await exited({ relaunch: ['nothing'] })
    expect(await step(quiet, { step: 'resume', conversationId: ID }).p).toEqual({ kind: 'not-resumed', why: 'agy didn\'t come back within 30 seconds' })
  })

  it('takes the line back out of an agy that is running in the terminal again', async () => {
    const t = new FakeTerminal(agy())
    expect(await step(t, { step: 'resume', conversationId: ID }).p).toEqual({ kind: 'not-resumed', why: 'agy is running in this terminal again' })
  })
})

// The OS's word on whether agy's process is gone (shellAlone.ts) has the last say here as in the
// account switch: the box it leaves on the screen proves nothing, and its goodbye can come at the
// start of its teardown or only at the end.
describe('exit: the OS has the last word on whether agy is gone', () => {
  it('waits out agy\'s teardown before it calls the exit done, and still reads the conversation', async () => {
    const t = new FakeTerminal(agy({ reports: false, os: 'tells', teardownMs: 7000 }))
    expect(await step(t, {}).p).toEqual({ kind: 'exited', conversationId: ID })
    expect(t.clock).toBeGreaterThanOrEqual(7000)
    expect(t.writes).toEqual(['/exit', '\r'])
  })

  it('waits on past the screen\'s 8 s for a goodbye that comes only at the end of a slow teardown', async () => {
    const t = new FakeTerminal(agy({ reports: false, os: 'tells', teardownMs: 12_000, hintAfterTeardown: true }))
    expect(await step(t, {}).p).toEqual({ kind: 'exited', conversationId: ID })
    // ...where without the OS the same screen confirms nothing.
    const blind = new FakeTerminal(agy({ reports: false, teardownMs: 12_000, hintAfterTeardown: true }))
    expect(await step(blind, {}).p).toMatchObject({ kind: 'not-exited' })
  })

  it('types no /exit to an agy the OS says is gone, though its last frame is still on the screen', async () => {
    const t = new FakeTerminal(agy({ start: 'gone-quiet', reports: false, os: 'tells' }))
    expect(await step(t, {}).p).toEqual({ kind: 'exited', conversationId: null })
    expect(t.writes).toEqual([])
  })

  it('does not take the user\'s word to the OS: assumeExited asks nothing', async () => {
    const t = new FakeTerminal(agy({ start: 'gone-hint', os: 'tells' }))
    expect(await step(t, { assumeExited: true }).p).toEqual({ kind: 'exited', conversationId: ID })
    expect(t.osAsked).toBe(0)
  })
})
describe('shownEmail: what agy\'s header shows, for display only', () => {
  it('reads an address in the first rows, and nothing below them', () => {
    expect(shownEmail(['  Antigravity CLI', '  someone@example.co.uk (Google AI Pro)'])).toBe('someone@example.co.uk')
    expect(shownEmail([...Array(10).fill(''), 'late@example.test'])).toBeNull()
    expect(shownEmail(['no address here'])).toBeNull()
  })
})
