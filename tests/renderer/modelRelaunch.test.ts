import { describe, it, expect } from 'vitest'
import {
  relaunchAgentWithModel,
  QUIT_PRESSES,
  QUIT_PRESS_GAP_MS,
  EXIT_POLL_MS,
  EXIT_CEILING_MS,
  BLIND_EXIT_WAIT_MS,
  PROMPT_SETTLE_MS,
  RESUME_PROBE_MS,
  LEAD_WINDOW,
} from '../../src/renderer/src/lib/modelRelaunch'
import type { ModelCatalog } from '../../src/renderer/src/lib/modelCatalog'
import {
  CLAUDE_EXIT_AFTER_A_TURN,
  CLAUDE_EXIT_NO_TURN,
  AGY_EXIT_AFTER_A_TURN,
  AGY_EXIT_NO_TURN,
  CLAUDE_SESSION_ID,
  AGY_CONVERSATION_ID,
} from '../fixtures/agentExitOutput'

const CAT: ModelCatalog = {
  claude: { provider: 'claude', models: [{ id: 'opus', label: 'Opus' }], source: 'builtin', fetchedAt: 0 },
  codex: { provider: 'codex', models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }], source: 'cli', fetchedAt: 1 },
  gemini: { provider: 'gemini', models: [{ id: 'gemini-3.8-flash-high', label: 'Flash' }], source: 'cli', fetchedAt: 1 },
}

type Answer = boolean | null | 'throw'

interface Script {
  /** What the OS says, in order; the last answer repeats once the script runs out. */
  alone: Answer[]
  /** What the terminal printed since the mark (or null / 'throw' when it can't be read). */
  output?: string | null | 'throw'
  /** What marking the terminal's output answers. */
  mark?: number | null | 'throw'
  /** What the terminal showed BEFORE the mark (null: that part cannot be read). Returned, with the quit's own
   *  output after it, to a read that starts below the mark. */
  lead?: string | null
}

/** A scripted terminal: every write, sleep, question and read lands in ONE ordered log, so a test can
 *  prove not just WHAT was typed but WHEN, relative to the OS saying the agent was gone. */
function fakeIo(script: Script) {
  const log: string[] = []
  let clock = 0
  let asked = 0
  const io = {
    write: (data: string) => { log.push(`write:${JSON.stringify(data)}`) },
    sleep: async (ms: number) => { clock += ms; log.push(`sleep:${ms}`) },
    now: () => clock,
    shellAlone: async (): Promise<boolean | null> => {
      log.push('alone?')
      const a = script.alone[Math.min(asked++, script.alone.length - 1)]
      if (a === 'throw') throw new Error('the query blew up')
      return a
    },
    outputMark: async (): Promise<number | null> => {
      log.push('mark')
      if (script.mark === 'throw') throw new Error('no buffer')
      return script.mark === undefined ? 100 : script.mark
    },
    outputSince: async (mark: number | null): Promise<string | null> => {
      log.push(`read:${mark}`)
      if (script.output === 'throw') throw new Error('no buffer')
      const markAt = script.mark === undefined || script.mark === 'throw' || script.mark === null ? 100 : script.mark
      const out = script.output === undefined ? null : script.output
      // A read that starts BELOW the mark also returns what came before it.
      if (mark !== null && mark < markAt) {
        if (script.lead === null) return null
        return out === null ? null : (script.lead ?? '') + out
      }
      return out
    },
  }
  return {
    io,
    log,
    writes: () => log.filter((e) => e.startsWith('write:')).map((e) => JSON.parse(e.slice(6)) as string),
    questions: () => log.filter((e) => e === 'alone?').length,
    slept: () => log.filter((e) => e.startsWith('sleep:')).map((e) => Number(e.slice(6))),
    indexOf: (entry: string) => log.indexOf(entry),
    lastIndexOf: (entry: string) => log.lastIndexOf(entry),
  }
}

const CTRL_C = '\x03'
const w = (s: string) => `write:${JSON.stringify(s)}`
const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const CODEX_HINT = `Token usage: total=12 input=8 output=4\nTo continue this session, run codex resume ${ID}\n`

describe('relaunchAgentWithModel: quitting the agent', () => {
  it('quits with Ctrl+C presses, waits for the OS to say the agent is gone, and types only THEN', async () => {
    const f = fakeIo({ alone: [false, false, false, true], output: CLAUDE_EXIT_AFTER_A_TURN })
    const outcome = await relaunchAgentWithModel('claude', 'opus', CAT, f.io)

    expect(outcome).toBe('relaunched')
    expect(f.writes()).toEqual([CTRL_C, CTRL_C, CTRL_C, `claude --model opus --resume ${CLAUDE_SESSION_ID}\r`])
    // The relaunch is the last thing that happens, after the final "is it gone?" answer and a
    // short settle for the prompt: typing earlier is what lost the command on Claude Code 2.1.311.
    const relaunchAt = f.indexOf(w(`claude --model opus --resume ${CLAUDE_SESSION_ID}\r`))
    expect(relaunchAt).toBeGreaterThan(f.lastIndexOf('alone?'))
    expect(f.log[relaunchAt - 2]).toBe(`sleep:${PROMPT_SETTLE_MS}`)
  })

  it('spaces the presses exactly: press, gap, press, gap, press, and only then the first question', async () => {
    const f = fakeIo({ alone: [false, true], output: AGY_EXIT_NO_TURN })
    await relaunchAgentWithModel('gemini', 'gemini-3.8-flash-high', CAT, f.io)
    const firstKey = f.indexOf(w(CTRL_C))
    expect(f.log.slice(firstKey, firstKey + 5)).toEqual([
      w(CTRL_C), `sleep:${QUIT_PRESS_GAP_MS}`, w(CTRL_C), `sleep:${QUIT_PRESS_GAP_MS}`, w(CTRL_C),
    ])
    expect(QUIT_PRESSES).toBe(3)
    // The poll comes after the last press, never between them.
    expect(f.log[firstKey + 5]).toBe(`sleep:${EXIT_POLL_MS}`)
  })

  it('marks the terminal\'s output BEFORE the first key, so only the quit\'s own output is read', async () => {
    const f = fakeIo({ alone: [false, true], output: CLAUDE_EXIT_AFTER_A_TURN, mark: 4321 })
    await relaunchAgentWithModel('claude', 'opus', CAT, f.io)
    expect(f.indexOf('mark')).toBeGreaterThan(-1)
    expect(f.indexOf('mark')).toBeLessThan(f.indexOf(w(CTRL_C)))
    expect(f.log).toContain('read:4321')
    // ...and reads it only after the agent is gone and the prompt has settled.
    expect(f.indexOf('read:4321')).toBeGreaterThan(f.lastIndexOf('alone?'))
    expect(f.indexOf('read:4321')).toBeGreaterThan(f.indexOf(`sleep:${PROMPT_SETTLE_MS}`))
  })

  it('NEVER sends Ctrl+D: at a shell prompt it closes the terminal, and Antigravity ignores it', async () => {
    for (const [p, id] of [['claude', 'opus'], ['codex', 'gpt-5.6-sol'], ['gemini', 'gemini-3.8-flash-high']] as const) {
      const f = fakeIo({ alone: [false, true], output: null })
      await relaunchAgentWithModel(p, id, CAT, f.io)
      expect(f.writes()).not.toContain('\x04')
    }
  })

  it('goes straight to the relaunch when the OS says only the shell is left (the agent already exited)', async () => {
    const f = fakeIo({ alone: [true, false], output: CLAUDE_EXIT_AFTER_A_TURN })
    const outcome = await relaunchAgentWithModel('claude', 'opus', CAT, f.io)
    expect(outcome).toBe('relaunched')
    // No keys at all: pressing them now would only reach the shell. And no mark: nothing to watch.
    expect(f.writes()).toEqual([`claude --model opus --resume ${CLAUDE_SESSION_ID}\r`])
    expect(f.log).not.toContain('mark')
    // It reads whatever the terminal still holds, for the hint the agent printed when it exited.
    expect(f.log).toContain('read:null')
    // That hint may be old (or the folder may have changed since), so it checks the start took.
    expect(f.slept()).toEqual([RESUME_PROBE_MS])
    expect(f.questions()).toBe(2)
  })

  it('starts a new session when an id read from an agent that had already exited does not resume', async () => {
    const f = fakeIo({ alone: [true, true], output: CLAUDE_EXIT_AFTER_A_TURN })
    const outcome = await relaunchAgentWithModel('claude', 'opus', CAT, f.io)
    expect(outcome).toBe('started-fresh')
    expect(f.writes()).toEqual([`claude --model opus --resume ${CLAUDE_SESSION_ID}\r`, 'claude --model opus\r'])
  })

  it('types NOTHING more when the agent never goes: no relaunch into a live agent', async () => {
    const f = fakeIo({ alone: [false], output: CLAUDE_EXIT_AFTER_A_TURN })
    const outcome = await relaunchAgentWithModel('claude', 'opus', CAT, f.io)
    expect(outcome).toBe('still-running')
    expect(f.writes()).toEqual([CTRL_C, CTRL_C, CTRL_C])
    expect(f.log).not.toContain('read:100')
    // Bounded: it asked a finite number of times, and no longer than the ceiling.
    const waited = f.slept().reduce((a, b) => a + b, 0)
    expect(waited).toBeGreaterThanOrEqual(EXIT_CEILING_MS)
    expect(waited).toBeLessThan(EXIT_CEILING_MS + EXIT_POLL_MS * 4 + QUIT_PRESS_GAP_MS * QUIT_PRESSES)
  })

  it('waits a long, blind beat when the OS cannot tell, then types (WSL, an unknown shell)', async () => {
    const f = fakeIo({ alone: [null], output: CLAUDE_EXIT_AFTER_A_TURN })
    const outcome = await relaunchAgentWithModel('claude', 'opus', CAT, f.io)
    expect(outcome).toBe('relaunched')
    expect(f.writes().slice(0, 3)).toEqual([CTRL_C, CTRL_C, CTRL_C])
    expect(f.slept()).toContain(BLIND_EXIT_WAIT_MS)
    // Blind means blind: it does not keep asking a question it already knows it cannot answer.
    expect(f.questions()).toBe(2)
  })

  it('treats a failing query like "cannot tell"', async () => {
    const f = fakeIo({ alone: ['throw'], output: CLAUDE_EXIT_AFTER_A_TURN })
    const outcome = await relaunchAgentWithModel('claude', 'opus', CAT, f.io)
    expect(outcome).toBe('relaunched')
    expect(f.slept()).toContain(BLIND_EXIT_WAIT_MS)
  })

  it('does NOT go blind when a query that worked a moment ago fails once: it asks again', async () => {
    // The OS could answer ("still running"), so a single hiccup is a hiccup, not a reason to type
    // into an agent that may still be tearing down.
    const f = fakeIo({ alone: [false, false, null, false, true], output: CLAUDE_EXIT_AFTER_A_TURN })
    const outcome = await relaunchAgentWithModel('claude', 'opus', CAT, f.io)
    expect(outcome).toBe('relaunched')
    expect(f.slept()).not.toContain(BLIND_EXIT_WAIT_MS)
    expect(f.questions()).toBe(5)
  })

  it('leaves the terminal alone when the OS answers, then goes silent, and the agent never shows as gone', async () => {
    const f = fakeIo({ alone: [false, false, null], output: CLAUDE_EXIT_AFTER_A_TURN })
    const outcome = await relaunchAgentWithModel('claude', 'opus', CAT, f.io)
    expect(outcome).toBe('still-running')
    expect(f.writes()).toEqual([CTRL_C, CTRL_C, CTRL_C])
  })

  it('works without any OS query wired in (older callers): quit, blind wait, relaunch', async () => {
    const f = fakeIo({ alone: [true] })
    const outcome = await relaunchAgentWithModel('claude', 'opus', CAT, { write: f.io.write, sleep: f.io.sleep })
    expect(outcome).toBe('relaunched')
    expect(f.writes().slice(0, 3)).toEqual([CTRL_C, CTRL_C, CTRL_C])
    expect(f.slept()).toContain(BLIND_EXIT_WAIT_MS)
  })

  it('uses the real clock for the ceiling when no clock is injected', async () => {
    const f = fakeIo({ alone: [false, true, false], output: null })
    const { now: _now, ...noClock } = f.io
    expect(await relaunchAgentWithModel('claude', 'opus', CAT, noClock)).toBe('relaunched')
  })
})

describe('relaunchAgentWithModel: which conversation it resumes', () => {
  it('resumes exactly the Claude session that was just quit', async () => {
    const f = fakeIo({ alone: [false, true], output: CLAUDE_EXIT_AFTER_A_TURN })
    await relaunchAgentWithModel('claude', 'opus', CAT, f.io)
    expect(f.writes().at(-1)).toBe(`claude --model opus --resume ${CLAUDE_SESSION_ID}\r`)
  })

  it('resumes exactly the Antigravity conversation that was just quit (its "latest" is global)', async () => {
    const f = fakeIo({ alone: [false, true], output: AGY_EXIT_AFTER_A_TURN })
    await relaunchAgentWithModel('gemini', 'gemini-3.8-flash-high', CAT, f.io)
    expect(f.writes().at(-1)).toBe(`agy --model gemini-3.8-flash-high --conversation=${AGY_CONVERSATION_ID}\r`)
  })

  it('resumes exactly the Codex session when Codex names it', async () => {
    const f = fakeIo({ alone: [false, true], output: CODEX_HINT })
    await relaunchAgentWithModel('codex', 'gpt-5.6-sol', CAT, f.io)
    expect(f.writes().at(-1)).toBe(`codex --model gpt-5.6-sol resume ${ID}\r`)
  })

  it('starts a NEW Claude session when the quit named nothing: there was nothing to resume', async () => {
    // Switching right after launch, before anything was said, used to type `--continue` and get
    // "No conversation found to continue" at a bare prompt.
    const f = fakeIo({ alone: [false, true], output: CLAUDE_EXIT_NO_TURN })
    const outcome = await relaunchAgentWithModel('claude', 'opus', CAT, f.io, 'claude --dangerously-skip-permissions')
    expect(outcome).toBe('started-new')
    expect(f.writes().at(-1)).toBe('claude --dangerously-skip-permissions --model opus\r')
    // A fresh start cannot come up empty, so there is nothing to double-check afterwards.
    expect(f.slept()).not.toContain(RESUME_PROBE_MS)
  })

  it('starts a NEW Antigravity session in that case, rather than resuming some other project\'s conversation', async () => {
    const f = fakeIo({ alone: [false, true], output: AGY_EXIT_NO_TURN })
    await relaunchAgentWithModel('gemini', 'gemini-3.8-flash-high', CAT, f.io)
    expect(f.writes().at(-1)).toBe('agy --model gemini-3.8-flash-high\r')
  })

  it('does not trust the absence of a Codex hint: it resumes the latest and double-checks it came up', async () => {
    const f = fakeIo({ alone: [false, true, false], output: 'bye\n' })
    const outcome = await relaunchAgentWithModel('codex', 'gpt-5.6-sol', CAT, f.io)
    expect(outcome).toBe('relaunched')
    expect(f.writes().at(-1)).toBe('codex --model gpt-5.6-sol resume --last\r')
    expect(f.slept()).toContain(RESUME_PROBE_MS)
  })

  it('resumes the latest when the output cannot be read at all', async () => {
    for (const output of [null, 'throw'] as const) {
      const f = fakeIo({ alone: [false, true, false], output })
      await relaunchAgentWithModel('claude', 'opus', CAT, f.io)
      expect(f.writes().at(-1), String(output)).toBe('claude --model opus --continue\r')
    }
  })

  it('resumes the latest when it could not mark the output, since it can no longer tell what the quit printed', async () => {
    for (const mark of [null, 'throw'] as const) {
      const f = fakeIo({ alone: [false, true, false], mark, output: CLAUDE_EXIT_NO_TURN })
      await relaunchAgentWithModel('claude', 'opus', CAT, f.io)
      expect(f.writes().at(-1), String(mark)).toBe('claude --model opus --continue\r')
    }
  })

  it('resumes the latest when there are no output readers wired in', async () => {
    const f = fakeIo({ alone: [false, true, false] })
    await relaunchAgentWithModel('claude', 'opus', CAT, { write: f.io.write, sleep: f.io.sleep, now: f.io.now, shellAlone: f.io.shellAlone })
    expect(f.writes().at(-1)).toBe('claude --model opus --continue\r')
  })

  it('resumes the latest when the agent printed a hint it cannot read (a renamed session), not "nothing"', async () => {
    const f = fakeIo({ alone: [false, true, false], output: 'Resume this session with:\nclaude --resume "my feature work"\n' })
    await relaunchAgentWithModel('claude', 'opus', CAT, f.io)
    expect(f.writes().at(-1)).toBe('claude --model opus --continue\r')
  })

  it('does not call it "nothing to resume" for an agent that had already exited: it did not watch the quit', async () => {
    const f = fakeIo({ alone: [true, false], output: '$ \n' })
    await relaunchAgentWithModel('claude', 'opus', CAT, f.io)
    expect(f.writes()).toEqual(['claude --model opus --continue\r'])
  })

  it('carries the terminal\'s launch flags through every kind of relaunch', async () => {
    const withId = fakeIo({ alone: [false, true], output: CLAUDE_EXIT_AFTER_A_TURN })
    await relaunchAgentWithModel('claude', 'opus', CAT, withId.io, 'claude --dangerously-skip-permissions --model sonnet --resume old')
    expect(withId.writes().at(-1)).toBe(`claude --dangerously-skip-permissions --model opus --resume ${CLAUDE_SESSION_ID}\r`)

    const codex = fakeIo({ alone: [false, true], output: CODEX_HINT })
    await relaunchAgentWithModel('codex', 'gpt-5.6-sol', CAT, codex.io, 'codex --yolo')
    expect(codex.writes().at(-1)).toBe(`codex --yolo --model gpt-5.6-sol resume ${ID}\r`)
  })
})

describe('relaunchAgentWithModel: when it cannot be sure', () => {
  // The OS could not say whether the agent was running (WSL, a shell it does not know), so the quit
  // was not WATCHED from the start: with the agent already gone, the three Ctrl+C presses land on the
  // shell and the hint it printed earlier sits BEFORE the mark. "No hint after the mark" then means
  // nothing, and starting a new conversation would silently abandon the real one.
  it('does not read "no hint after the mark" as "nothing to resume" when the OS could not see the agent', async () => {
    const f = fakeIo({ alone: [null], output: CLAUDE_EXIT_NO_TURN })
    const outcome = await relaunchAgentWithModel('claude', 'opus', CAT, f.io)
    expect(outcome).not.toBe('started-new')
    expect(f.writes()).toContain('claude --model opus --continue\r')
    expect(f.writes()).not.toContain('claude --model opus\r')
  })

  it('still resumes the exact conversation when the OS could not see the agent but the hint is after the mark', async () => {
    const f = fakeIo({ alone: [null], output: CLAUDE_EXIT_AFTER_A_TURN })
    expect(await relaunchAgentWithModel('claude', 'opus', CAT, f.io)).toBe('relaunched')
    expect(f.writes().at(-1)).toBe(`claude --model opus --resume ${CLAUDE_SESSION_ID}\r`)
  })

  it('does not read an unrecognised hint as "nothing to resume": any id or resume-like word in the output stops that', async () => {
    for (const output of [
      `To continue, run: claude -r ${ID}`,
      `claude resume ${ID}`,
      `Session ${ID} saved. Run claude --continue`,
      'Your conversation was saved.',
    ]) {
      const f = fakeIo({ alone: [false, true, false], output })
      const outcome = await relaunchAgentWithModel('claude', 'opus', CAT, f.io)
      expect(outcome, output).toBe('relaunched')
      expect(f.writes().at(-1), output).toBe('claude --model opus --continue\r')
    }
  })

  // The Antigravity CLI's "most recent" is global: after a quit with nothing said it resumed a
  // conversation from another project. When Termpolis cannot tell which conversation is this
  // terminal's, a new session is the safe answer, and it is reported.
  it('NEVER types agy --continue: when it cannot tell which conversation is this terminal\'s it starts a new one', async () => {
    const cases: Array<[string, Script, string]> = [
      ['output unreadable', { alone: [false, true], output: null }, 'started-unsure'],
      ['output read failed', { alone: [false, true], output: 'throw' }, 'started-unsure'],
      ['mark failed', { alone: [false, true], mark: null, output: AGY_EXIT_NO_TURN }, 'started-unsure'],
      ['the OS could not see the agent', { alone: [null], output: AGY_EXIT_NO_TURN }, 'started-unsure'],
      ['an unreadable conversation id', { alone: [false, true], output: 'Resume with -c (or command below):\nagy --conversation=named-thing\n' }, 'started-unsure'],
      ['the agent had already exited', { alone: [true], output: AGY_EXIT_NO_TURN }, 'started-unsure'],
    ]
    for (const [label, script, outcome] of cases) {
      const f = fakeIo(script)
      expect(await relaunchAgentWithModel('gemini', 'gemini-3.8-flash-high', CAT, f.io), label).toBe(outcome)
      expect(f.writes().at(-1), label).toBe('agy --model gemini-3.8-flash-high\r')
      expect(f.writes().join(''), label).not.toContain('--continue')
    }
  })

  it('names the Antigravity conversation when it can, whatever else is uncertain', async () => {
    for (const alone of [[false, true], [null], [true, false]]) {
      const f = fakeIo({ alone, output: AGY_EXIT_AFTER_A_TURN })
      await relaunchAgentWithModel('gemini', 'gemini-3.8-flash-high', CAT, f.io)
      expect(f.writes().at(-1), JSON.stringify(alone)).toBe(`agy --model gemini-3.8-flash-high --conversation=${AGY_CONVERSATION_ID}\r`)
    }
  })

  it('never reports a deliberate new session as a resume', async () => {
    const empty = fakeIo({ alone: [false, true], output: AGY_EXIT_NO_TURN })
    expect(await relaunchAgentWithModel('gemini', 'gemini-3.8-flash-high', CAT, empty.io)).toBe('started-new')
    const unsure = fakeIo({ alone: [false, true], output: null })
    expect(await relaunchAgentWithModel('gemini', 'gemini-3.8-flash-high', CAT, unsure.io)).toBe('started-unsure')
  })
})

describe('relaunchAgentWithModel: a second opinion before "nothing to resume"', () => {
  const READ_FROM = (mark: number) => `read:${Math.max(0, mark - LEAD_WINDOW)}`

  it('looks just BEFORE the quit before concluding there was nothing to resume', async () => {
    const f = fakeIo({ alone: [false, true], output: CLAUDE_EXIT_NO_TURN, mark: 50_000, lead: 'Try "fix typecheck errors"\n' })
    expect(await relaunchAgentWithModel('claude', 'opus', CAT, f.io)).toBe('started-new')
    expect(f.log).toContain(READ_FROM(50_000))
    expect(f.writes().at(-1)).toBe('claude --model opus\r')
  })

  it('does not start over when a hint was printed just before the mark (an agent the user quit by hand, still shutting down)', async () => {
    // Quit with /exit a moment ago: the OS still says "running" while the shutdown hooks run, but the
    // hint is already on the screen, before the mark. Nothing after the mark names a conversation.
    const f = fakeIo({ alone: [false, true, false], output: '$ ', mark: 50_000, lead: CLAUDE_EXIT_AFTER_A_TURN })
    const outcome = await relaunchAgentWithModel('claude', 'opus', CAT, f.io)
    expect(outcome).toBe('relaunched')
    expect(f.writes().at(-1)).toBe('claude --model opus --continue\r')
    expect(f.writes()).not.toContain('claude --model opus\r')
  })

  it('does the same for the Antigravity CLI, except that it never asks for its global latest', async () => {
    const f = fakeIo({ alone: [false, true], output: '$ ', mark: 50_000, lead: AGY_EXIT_AFTER_A_TURN })
    const outcome = await relaunchAgentWithModel('gemini', 'gemini-3.8-flash-high', CAT, f.io)
    expect(outcome).toBe('started-unsure')
    expect(f.writes().join('')).not.toContain('--continue')
  })

  it('does not start over when the screen before the mark shows the --resume of a switch typed moments ago', async () => {
    // Picking again while the relaunched agent is still booting: nothing was printed yet, but the shell
    // shows the line that was just typed.
    const f = fakeIo({ alone: [false, true, false], output: CLAUDE_EXIT_NO_TURN, mark: 50_000, lead: `$ claude --model sonnet --resume ${ID}\r\n` })
    expect(await relaunchAgentWithModel('claude', 'opus', CAT, f.io)).toBe('relaunched')
    expect(f.writes().at(-1)).toBe('claude --model opus --continue\r')
  })

  it('does not start over on a UUID before the mark either (some wording of a hint it does not know)', async () => {
    const f = fakeIo({ alone: [false, true, false], output: CLAUDE_EXIT_NO_TURN, mark: 50_000, lead: `Session ${ID} saved.\n` })
    expect(await relaunchAgentWithModel('claude', 'opus', CAT, f.io)).toBe('relaunched')
  })

  it('ignores ordinary words before the mark: a running agent\'s own screen is full of them', async () => {
    const lead = 'Tip: use /resume to continue a previous conversation in this session.\n'
    const f = fakeIo({ alone: [false, true], output: CLAUDE_EXIT_NO_TURN, mark: 50_000, lead })
    expect(await relaunchAgentWithModel('claude', 'opus', CAT, f.io)).toBe('started-new')
  })

  it('does not start over when it cannot read what came before the mark', async () => {
    const f = fakeIo({ alone: [false, true, false], output: CLAUDE_EXIT_NO_TURN, mark: 50_000, lead: null })
    expect(await relaunchAgentWithModel('claude', 'opus', CAT, f.io)).toBe('relaunched')
    expect(f.writes().at(-1)).toBe('claude --model opus --continue\r')
  })

  it('starts the look at the beginning of the output when the mark is nearer than the window', async () => {
    const f = fakeIo({ alone: [false, true], output: CLAUDE_EXIT_NO_TURN, mark: 300 })
    await relaunchAgentWithModel('claude', 'opus', CAT, f.io)
    expect(f.log).toContain('read:0')
  })

  it('does not look back at all when nothing is being concluded from the quit (a hint was found)', async () => {
    const f = fakeIo({ alone: [false, true], output: CLAUDE_EXIT_AFTER_A_TURN, mark: 50_000 })
    await relaunchAgentWithModel('claude', 'opus', CAT, f.io)
    expect(f.log.filter((e) => e.startsWith('read:'))).toEqual(['read:50000'])
  })

  it('does not take a word in the shell PROMPT for a hint (a folder or branch called "resume-ui")', async () => {
    const prompt = '\r\n~/session-manager (feat/resume-ui) $ '
    const f = fakeIo({ alone: [false, true], output: CLAUDE_EXIT_NO_TURN + prompt })
    expect(await relaunchAgentWithModel('claude', 'opus', CAT, f.io)).toBe('started-new')
    expect(f.writes().at(-1)).toBe('claude --model opus\r')
    const g = fakeIo({ alone: [false, true], output: AGY_EXIT_NO_TURN + prompt })
    expect(await relaunchAgentWithModel('gemini', 'gemini-3.8-flash-high', CAT, g.io)).toBe('started-new')
  })
})

describe('relaunchAgentWithModel: a terminal that does not run the agent\'s own command', () => {
  // The picker is shown for any command that merely STARTS with an agent's name. Typing the bare agent
  // in place of `claude-sandbox` would run the agent outside whatever the wrapper put it in.
  it.each([
    ['claude', 'opus', 'claude-sandbox --verbose'],
    ['claude', 'opus', 'claudex'],
    ['claude', 'opus', 'claudebox --dangerously-skip-permissions'],
    ['claude', 'opus', 'C:\\tools\\claude-yolo.exe'],
    ['codex', 'gpt-5.6-sol', 'codex-cli --yolo'],
    ['codex', 'gpt-5.6-sol', 'codex-docker'],
    ['gemini', 'gemini-3.8-flash-high', 'agy-dev'],
    ['gemini', 'gemini-3.8-flash-high', 'gemini --yolo'],
  ] as const)('refuses %s %s for "%s": nothing is sent, asked or marked', async (provider, model, command) => {
    const f = fakeIo({ alone: [false, true], output: CLAUDE_EXIT_AFTER_A_TURN })
    expect(await relaunchAgentWithModel(provider, model, CAT, f.io, command)).toBe('unsupported')
    expect(f.log).toEqual([])
  })

  it.each([
    ['claude', 'opus', 'claude'],
    ['claude', 'opus', 'claude --dangerously-skip-permissions'],
    ['claude', 'opus', 'CLAUDE.EXE --verbose'],
    ['claude', 'opus', 'C:\\tools\\claude.exe --verbose'],
    ['claude', 'opus', '/usr/local/bin/claude'],
    ['codex', 'gpt-5.6-sol', 'codex.cmd --yolo'],
    ['gemini', 'gemini-3.8-flash-high', 'agy'],
  ] as const)('restarts %s %s for "%s"', async (provider, model, command) => {
    const f = fakeIo({ alone: [false, true, false], output: null })
    expect(await relaunchAgentWithModel(provider, model, CAT, f.io, command)).not.toBe('unsupported')
    expect(f.writes().length).toBeGreaterThan(0)
  })

  it('does not look at a command it was not given (older callers, tests)', async () => {
    const f = fakeIo({ alone: [false, true, false], output: null })
    expect(await relaunchAgentWithModel('claude', 'opus', CAT, f.io)).toBe('relaunched')
    const g = fakeIo({ alone: [false, true, false], output: null })
    expect(await relaunchAgentWithModel('claude', 'opus', CAT, g.io, '   ')).toBe('relaunched')
    const h = fakeIo({ alone: [false, true, false], output: null })
    expect(await relaunchAgentWithModel('claude', 'opus', CAT, h.io, null)).toBe('relaunched')
  })

  it('checks the model first: a bad model is "invalid" whatever the command', async () => {
    const f = fakeIo({ alone: [false] })
    expect(await relaunchAgentWithModel('claude', 'rm -rf', CAT, f.io, 'claude-sandbox')).toBe('invalid')
  })
})

describe('relaunchAgentWithModel: double-checking a resume of "the latest"', () => {
  it('types a NEW session when the resume left only the shell: nothing to continue after all', async () => {
    // Codex's wording is unconfirmed, so an unreadable quit resumes the latest -- which can come up
    // empty and exit. Seen with Claude: "No conversation found to continue".
    const f = fakeIo({ alone: [false, true, true], output: 'bye\n' })
    const outcome = await relaunchAgentWithModel('codex', 'gpt-5.6-sol', CAT, f.io, 'codex --yolo')
    expect(outcome).toBe('started-fresh')
    expect(f.writes().slice(-2)).toEqual(['codex --yolo --model gpt-5.6-sol resume --last\r', 'codex --yolo --model gpt-5.6-sol\r'])
    // It waited long enough for a failed start (which takes seconds) before judging.
    const typed = f.indexOf(w('codex --yolo --model gpt-5.6-sol resume --last\r'))
    expect(f.log[typed + 1]).toBe(`sleep:${RESUME_PROBE_MS}`)
    expect(RESUME_PROBE_MS).toBeGreaterThanOrEqual(7000)
  })

  it('leaves it alone when the agent is up', async () => {
    const f = fakeIo({ alone: [false, true, false], output: null })
    expect(await relaunchAgentWithModel('claude', 'opus', CAT, f.io)).toBe('relaunched')
    expect(f.writes()).toEqual([CTRL_C, CTRL_C, CTRL_C, 'claude --model opus --continue\r'])
  })

  it('leaves it alone when the OS cannot tell', async () => {
    const f = fakeIo({ alone: [false, true, null], output: null })
    expect(await relaunchAgentWithModel('claude', 'opus', CAT, f.io)).toBe('relaunched')
    expect(f.writes()).toHaveLength(4)
  })

  it('does not double-check a resume of an exact conversation after a quit it watched, or a new session', async () => {
    for (const [output, outcome] of [[CLAUDE_EXIT_AFTER_A_TURN, 'relaunched'], [CLAUDE_EXIT_NO_TURN, 'started-new']] as const) {
      const f = fakeIo({ alone: [false, true, true], output })
      expect(await relaunchAgentWithModel('claude', 'opus', CAT, f.io)).toBe(outcome)
      expect(f.slept()).not.toContain(RESUME_PROBE_MS)
      expect(f.writes()).toHaveLength(4)
    }
  })
})

describe('relaunchAgentWithModel: refusing', () => {
  it('writes NOTHING, marks nothing and asks nothing when the model is not one the catalog offers', async () => {
    // The guard has to come before the quit keys: killing the agent and then failing to relaunch
    // it would be strictly worse than doing nothing.
    for (const [p, id] of [['codex', 'gpt-9-imaginary'], ['claude', 'claude-opus-5-5'], ['gemini', '']] as const) {
      const f = fakeIo({ alone: [false], output: CLAUDE_EXIT_AFTER_A_TURN })
      const outcome = await relaunchAgentWithModel(p, id, CAT, f.io)
      expect(outcome).toBe('invalid')
      expect(f.log).toEqual([])
    }
  })

  it('treats a discovered provider with no catalog yet as invalid', async () => {
    const f = fakeIo({ alone: [false] })
    expect(await relaunchAgentWithModel('codex', 'gpt-5.6-sol', null, f.io)).toBe('invalid')
    expect(f.log).toEqual([])
  })
})
