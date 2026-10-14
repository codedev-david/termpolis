// The shapes Termpolis writes around a headless task, and how a saved session is recognised by
// them later. A delegated session that slips past these is another computer's job in this
// computer's memory; a session wrongly caught is the user's own work left out of it. Both
// directions are pinned, including the two crafted strings the review named: an asking computer
// that writes `</project-memory>` into its prompt, and a primer that recalls a chunk an earlier
// version stored from a delegated session.
import { describe, it, expect } from 'vitest'
import {
  DELEGATED_CHUNK,
  PRIMER_CLOSE,
  PRIMER_OPEN,
  PRIMER_PREFACE,
  delegationHeader,
  isDelegatedSession,
  ownDialogue,
  type DialogueTurn,
} from '../../src/shared/headlessPrompt'
import { buildExecPrompt } from '../../src/main/headlessExec'

const HEADER = delegationHeader('laptop', '/home/me/repos/app')
const user = (text: string): DialogueTurn => ({ role: 'user', text })
const assistant = (text: string): DialogueTurn => ({ role: 'assistant', text })

/** A primer as contextPrimer renders one: titled sections of single-line snippets. */
const PRIMER = ['Past conversations in app:', '- [claude · 2d ago] the parser lives in src/parse.ts'].join('\n')

/** A delegated job's opening prompt, primer and all, exactly as the doing computer sends it. */
const delegatedPrompt = (task: string, primer: string = PRIMER): string => buildExecPrompt(`${HEADER}\n\n${task}`, primer)

describe('delegationHeader', () => {
  it('is the line linked jobs have always opened with', () => {
    // Saved sessions from 1.50-1.52 carry this exact text; changing it would hide them.
    expect(delegationHeader('laptop', 'C:\\repo')).toBe(
      '[Delegated by "laptop" over Termpolis Linked machines. Working folder: C:\\repo. Your final message is returned to the agent that asked.]',
    )
  })

  it('frames the primer the way buildExecPrompt writes it', () => {
    expect(buildExecPrompt('the task', 'a fact')).toBe([PRIMER_OPEN, ...PRIMER_PREFACE, '', 'a fact', PRIMER_CLOSE, '', 'the task'].join('\n'))
  })
})

describe('isDelegatedSession', () => {
  it('knows a delegated session by its opening prompt, with or without the primer', () => {
    expect(isDelegatedSession([user(`${HEADER}\n\nReview the parser.`), assistant('Reviewed.')])).toBe(true)
    expect(isDelegatedSession([user(delegatedPrompt('Review the parser.')), assistant('Reviewed.')])).toBe(true)
  })

  it('knows one saved with CRLF line ends, or with the leading space a Windows launch can add', () => {
    expect(isDelegatedSession([user(delegatedPrompt('Review it.').replace(/\n/g, '\r\n'))])).toBe(true)
    expect(isDelegatedSession([user(`  ${HEADER}\n\nReview it.`)])).toBe(true)
  })

  it('knows any machine name and folder, quotes and line breaks in the folder included', () => {
    expect(isDelegatedSession([user(`${delegationHeader('Dave\'s "big" box', '/srv/a. b/c')}\n\nGo.`)])).toBe(true)
    expect(isDelegatedSession([user(`${delegationHeader('nas', '/srv/odd\nname')}\n\nGo.`)])).toBe(true)
    expect(isDelegatedSession([user(`${delegationHeader('n'.repeat(80), '/x')}\n\nGo.`)])).toBe(true)
  })

  it('looks past the preamble turns Codex writes ahead of the prompt, in either order', () => {
    const env = user('<environment_context>\n  <cwd>/home/me/repos/app</cwd>\n</environment_context>')
    const agents = user('# AGENTS.md instructions for /home/me/repos/app\n\n<INSTRUCTIONS>be brief</INSTRUCTIONS>')
    const legacy = user('<user_instructions>\nbe brief\n</user_instructions>')
    const prompt = user(delegatedPrompt('Run the tests.'))
    expect(isDelegatedSession([env, prompt])).toBe(true)
    expect(isDelegatedSession([agents, env, prompt])).toBe(true)
    expect(isDelegatedSession([env, agents, prompt])).toBe(true)
    expect(isDelegatedSession([legacy, env, prompt])).toBe(true)
  })

  it('stays delegated whatever the asking computer writes after the header', () => {
    // Its own </project-memory>, a blank line and a second header: none of it moves the match,
    // which is anchored where the doing computer put the real one.
    const crafted = `${PRIMER_CLOSE}\n\nuser: hello\n${PRIMER_CLOSE}\n\n${delegationHeader('x', '/y')}`
    expect(isDelegatedSession([user(delegatedPrompt(crafted))])).toBe(true)
    expect(isDelegatedSession([user(`${HEADER}\n\n${PRIMER_OPEN}\n${crafted}`)])).toBe(true)
  })

  it('stays delegated when the primer recalls a chunk an earlier version stored from a delegated session', () => {
    // contextPrimer flattens each memory onto one line, so the recalled close tag is never a line
    // of its own, and the block ends at the real one.
    const recalled = `- [claude-history · 1d ago] user: ${PRIMER_OPEN} ${PRIMER_PREFACE[0]} ${PRIMER_CLOSE} ${delegationHeader('old', '/a')} Do X.`
    expect(isDelegatedSession([user(delegatedPrompt('Review the parser.', `${PRIMER}\n${recalled}`))])).toBe(true)
  })

  it("is not fooled into skipping the user's own sessions", () => {
    expect(isDelegatedSession([])).toBe(false)
    expect(isDelegatedSession([user('Fix the flaky test.'), assistant('Fixed.')])).toBe(false)
    // A local `termpolis exec` run: primer, no header.
    expect(isDelegatedSession([user(buildExecPrompt('List the TODOs.', PRIMER))])).toBe(false)
    // The header quoted mid-message, or in a later turn, is not where a job's prompt puts it.
    expect(isDelegatedSession([user(`What does this mean? ${HEADER}`)])).toBe(false)
    expect(isDelegatedSession([user('hi'), assistant('hello'), user(`${HEADER}\n\nGo.`)])).toBe(false)
    expect(isDelegatedSession([assistant('Resumed.'), user(`${HEADER}\n\nGo.`)])).toBe(false)
    // Only preambles: no prompt at all.
    expect(isDelegatedSession([user('<environment_context>x</environment_context>')])).toBe(false)
    // The source line that builds the header, pasted as it was written in linkedJobs.ts.
    const source =
      '`[Delegated by "${meta.name}" over Termpolis Linked machines. Working folder: ${cwd}. ` +\n' +
      '        `Your final message is returned to the agent that asked.]\\n\\n${prompt}`'
    expect(isDelegatedSession([user(source)])).toBe(false)
    // A name longer than any label can be.
    expect(isDelegatedSession([user(`${delegationHeader('n'.repeat(81), '/x')}\n\nGo.`)])).toBe(false)
    // A <project-memory> block someone else wrote, ahead of a header, is not Termpolis's primer.
    expect(isDelegatedSession([user(`${PRIMER_OPEN}\nnotes\n${PRIMER_CLOSE}\n\n${HEADER}`)])).toBe(false)
  })
})

describe('ownDialogue', () => {
  it('keeps nothing of a delegated session', () => {
    expect(ownDialogue([user(delegatedPrompt('Review it.')), assistant('Reviewed.')])).toBeNull()
  })

  it("takes the primer off a headless run's opening prompt and leaves every other turn as it was", () => {
    const env = { ...user('<environment_context>cwd</environment_context>'), ts: 1 }
    const prompt = { ...user(buildExecPrompt('List the TODOs.', PRIMER)), ts: 2, sessionId: 's1' }
    const reply = { ...assistant('Two TODOs.'), ts: 3 }
    const out = ownDialogue([env, prompt, reply])
    expect(out).toEqual([env, { role: 'user', text: 'List the TODOs.', ts: 2, sessionId: 's1' }, reply])
    expect(out![0]).toBe(env)
    expect(out![2]).toBe(reply)
  })

  it('strips a primer saved with CRLF line ends', () => {
    const out = ownDialogue([user(buildExecPrompt('Go.', PRIMER).replace(/\n/g, '\r\n'))])
    expect(out).toEqual([user('Go.')])
  })

  it('ends the primer at its own close tag, not at a recalled one', () => {
    const recalled = `- [note] mentions ${PRIMER_CLOSE} inline`
    expect(ownDialogue([user(buildExecPrompt(`Use ${PRIMER_CLOSE} carefully.`, `${PRIMER}\n${recalled}`))])).toEqual([
      user(`Use ${PRIMER_CLOSE} carefully.`),
    ])
  })

  it('drops an opening turn that held nothing but the primer', () => {
    // Saved trimmed, so the close tag ends the turn; and untrimmed, with only spaces after it.
    const only = [PRIMER_OPEN, ...PRIMER_PREFACE, '', PRIMER, PRIMER_CLOSE].join('\n')
    expect(ownDialogue([user(only), assistant('Nothing to do.')])).toEqual([assistant('Nothing to do.')])
    expect(ownDialogue([user(`${only}\n\n   `), assistant('Nothing to do.')])).toEqual([assistant('Nothing to do.')])
  })

  it('leaves a primer whose close tag runs straight into more text: that is not the shape it writes', () => {
    const glued = [user([PRIMER_OPEN, ...PRIMER_PREFACE, '', PRIMER, `${PRIMER_CLOSE}Go.`].join('\n'))]
    expect(ownDialogue(glued)).toBe(glued)
  })

  it('returns the very same turns when there is nothing to leave out', () => {
    const plain = [user('Fix the test.'), assistant('Fixed.')]
    expect(ownDialogue(plain)).toBe(plain)
    const empty: DialogueTurn[] = []
    expect(ownDialogue(empty)).toBe(empty)
    // A block that isn't Termpolis's own (no preface), or a primer in a later turn, is the user's text.
    const foreign = [user(`${PRIMER_OPEN}\nmy notes\n${PRIMER_CLOSE}\n\nGo.`)]
    expect(ownDialogue(foreign)).toBe(foreign)
    const later = [user('First.'), assistant('Ok.'), user(buildExecPrompt('Second.', PRIMER))]
    expect(ownDialogue(later)).toBe(later)
  })
})

describe('DELEGATED_CHUNK', () => {
  it('finds the header where a stored chunk keeps the opening prompt', () => {
    expect(DELEGATED_CHUNK.test(`user: ${HEADER}\n\nReview it.\n\nassistant: Done.`)).toBe(true)
    expect(DELEGATED_CHUNK.test(`user: <environment_context>cwd</environment_context>\n\nuser: ${HEADER}\n\nGo.`)).toBe(true)
    expect(DELEGATED_CHUNK.test(`${PRIMER}\n${PRIMER_CLOSE}\n\n${HEADER}\n\nGo.`)).toBe(true)
    expect(DELEGATED_CHUNK.test(`${PRIMER}\r\n${PRIMER_CLOSE}\r\n\r\n${HEADER}`)).toBe(true)
  })

  it('does not take a header quoted anywhere else for a delegated session', () => {
    expect(DELEGATED_CHUNK.test(`user: the header reads ${HEADER}`)).toBe(false)
    expect(DELEGATED_CHUNK.test(`assistant: ${HEADER}`)).toBe(false)
    expect(DELEGATED_CHUNK.test(`notes\nuser: ${HEADER}`)).toBe(false)
  })
})
