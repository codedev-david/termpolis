// mnemeReflectQuality.test.ts
//
// QUALITY-regression tests for the Mneme distiller (src/main/mnemeReflect.ts).
//
// The sibling suite (mnemeReflect.test.ts) proves the extractor emits STRUCTURED
// output from tiny two-line inputs. It does NOT prove the extractor pulls a GOOD
// lesson out of a realistic, noisy session. This file closes that gap: each case
// is a multi-turn episode with real-sounding errors/files/decisions interleaved
// with conversational chatter ("thanks", "let me look", "ok running it now"), and
// the assertions pin the QUALITY of the distilled lesson -- that the real signal is
// captured and the noise does not manufacture junk lessons.
//
// Findings about the deterministic extractor, encoded into the episode phrasing so
// these tests document the real contract rather than an idealized one:
//
//  * The problem/fix pair for a PROCEDURAL lesson can span turns -- the problem is
//    the first ERROR-shaped sentence anywhere, the fix is the first FIX-shaped
//    ASSISTANT sentence anywhere after it. Episode 1 exercises that cross-turn join.
//  * DECISION and GOTCHA lessons are emitted per matching ASSISTANT *sentence*, and
//    the lesson content is that whole sentence. So the substance (the chosen option
//    + why, or the actual root cause) must sit in the SAME sentence as the trigger
//    word. "Found the root cause." as its own sentence would distill to a useless
//    "Found the root cause." lesson; the real cause in the next sentence would be
//    dropped. Episodes 2 and 3 keep trigger + substance in one sentence, which is
//    also how engineers actually phrase these -- but it is a genuine precision limit
//    worth knowing when tuning the classifiers.
//  * A fix must come from the ASSISTANT: a user typing "fix" does not manufacture a
//    procedural lesson (Episode 3's closing user turn says "build change", and even
//    a "fix" there would be ignored because fixes are read from assistant turns).

import { distillEpisode, type Episode } from '../../src/main/mnemeReflect'

function ep(partial: Partial<Episode> & { turns: Episode['turns'] }): Episode {
  return { id: 'ep-quality', project: 'termpolis', source: 'claude', ...partial }
}

function contentBlob(lessons: Awaited<ReturnType<typeof distillEpisode>>): string {
  return lessons
    .map((l) => [l.content, l.problem, l.solution, l.gotcha].filter(Boolean).join(' '))
    .join('\n')
}

describe('mnemeReflect -- lesson quality on realistic, noisy episodes', () => {
  it('episode 1: a noisy debugging session distills to ONE grounded procedural lesson', async () => {
    // 6 turns / ~13 sentences: a stack trace, two turns of investigation chatter,
    // the actual diagnosis+fix, a green test run, and a thank-you. Only the fix is
    // durable knowledge; everything else is noise.
    const debugging = ep({
      id: 'ep-debug-terminal-crash',
      outcome: { kind: 'test', success: true, detail: '41 passed' },
      turns: [
        {
          role: 'user',
          // Realistic: user pastes the stack trace first, then the repro note.
          text:
            "TypeError: Cannot read properties of undefined (reading 'dispose') at " +
            'TerminalManager.closeSession (src/renderer/terminalManager.ts:142). I get ' +
            'this every single time I close the second terminal tab, and the whole ' +
            'renderer process goes down with it.',
        },
        {
          role: 'assistant',
          // Pure chatter -- must NOT become a lesson.
          text:
            'Thanks for the report, let me take a look. I will start by reproducing ' +
            'this locally with two tabs open.',
        },
        {
          role: 'assistant',
          // Investigation narration -- an ERROR-shaped word ("exception") appears here
          // but it is neither the first error nor a fix, so it stays noise.
          text:
            'Okay, I can reproduce it now. Running the app with a debugger attached ' +
            'shows the exception fires during teardown.',
        },
        {
          role: 'assistant',
          // The signal: diagnosis + the applied fix (fix sentence names closeSession).
          text:
            'Found it. The renderer registers a dispose handler but never null-checks ' +
            'the session, so closing a tab that failed to fully initialize throws. I ' +
            'fixed it by guarding the session lookup in `closeSession` and bailing out ' +
            'when the terminal was never registered.',
        },
        {
          role: 'assistant',
          text:
            'Ran the full terminal test suite and all 41 specs pass now. I also added ' +
            'a regression test that opens and closes a half-initialized tab.',
        },
        {
          role: 'user',
          text:
            'Confirmed on my machine, opening and closing tabs is smooth now. ' +
            'Appreciate the quick turnaround.',
        },
      ],
    })

    const lessons = await distillEpisode(debugging)

    // Signal-in-noise: ~13 sentences must NOT yield ~13 lessons.
    expect(lessons.length).toBeGreaterThanOrEqual(1)
    expect(lessons.length).toBeLessThanOrEqual(3)

    const proc = lessons.find((l) => l.memoryType === 'procedural')
    expect(proc).toBeDefined()
    expect(proc!.kind).toBe('fact')
    expect(proc!.links).toEqual([{ relation: 'solves' }])

    // problem field mentions the REAL error, not the "crashes" hand-wave.
    expect(proc!.problem).toMatch(/Cannot read properties of undefined/i)
    expect(proc!.problem).toMatch(/dispose/)

    // solution field mentions the REAL fix (the guard), not the repro chatter.
    expect(proc!.solution).toMatch(/guarding the session/i)
    expect(proc!.solution).toMatch(/closeSession/)

    // The referenced file and function entities were pulled out of the noise.
    expect(proc!.entities).toEqual(
      expect.arrayContaining(['src/renderer/terminalManager.ts', 'closeSession']),
    )

    // Grounded on a passing test -> high importance.
    expect(proc!.importance).toBeGreaterThan(0.6)

    // Exactly one procedural lesson; the investigation narration did not spawn
    // decision/gotcha lessons per sentence.
    expect(lessons.filter((l) => l.memoryType === 'procedural')).toHaveLength(1)
    expect(lessons.filter((l) => l.kind === 'decision')).toHaveLength(0)

    // None of the conversational filler leaked into a lesson.
    const blob = contentBlob(lessons)
    expect(blob).not.toMatch(/let me take a look/i)
    expect(blob).not.toMatch(/reproduc/i)
    expect(blob).not.toMatch(/debugger/i)
    expect(blob).not.toMatch(/appreciate/i)
  })

  it('episode 2: a deliberation distills to ONE decision lesson that keeps the choice AND its reason', async () => {
    // The assistant weighs SQLite vs JSONL over two turns, then commits with a
    // reason. Only the commitment sentence is a durable decision; the weighing
    // prose and the chit-chat are not.
    const decision = ep({
      id: 'ep-decide-index-store',
      turns: [
        {
          role: 'user',
          text:
            'We need to persist the memory index across restarts. Should we use ' +
            'SQLite or just write JSONL to disk? I want something simple but durable.',
        },
        {
          role: 'assistant',
          // Chatter -- "commit to either" is not a decision keyword.
          text: 'Let me think through the tradeoffs before we commit to either one.',
        },
        {
          role: 'assistant',
          // Weighing prose: option analysis, but no commitment -> not a lesson.
          text:
            'SQLite gives us transactions and indexed queries, but it pulls in a ' +
            'native binary that has to be rebuilt per Electron version and per ' +
            'platform, which has bitten this project before. JSONL is append-only, ' +
            'trivial to sync across machines, and needs zero native modules, at the ' +
            'cost of loading the whole file on startup.',
        },
        {
          role: 'assistant',
          // The decision -- choice + rationale deliberately in ONE sentence so the
          // distilled lesson carries the "why", not just the "what".
          text:
            'I am going with JSONL over SQLite because avoiding a native binary keeps ' +
            'Termpolis to a single installer and sidesteps the per-platform rebuild ' +
            'pain that has bitten us before, and our index is small enough that a ' +
            'full-file load stays well under 50ms on startup.',
        },
      ],
    })

    const lessons = await distillEpisode(decision)

    expect(lessons.length).toBeGreaterThanOrEqual(1)
    expect(lessons.length).toBeLessThanOrEqual(3)

    const dec = lessons.find((l) => l.kind === 'decision')
    expect(dec).toBeDefined()
    expect(dec!.memoryType).toBe('semantic')

    // Captured the choice, the rejected alternative, and the reason.
    expect(dec!.content).toMatch(/JSONL/)
    expect(dec!.content).toMatch(/SQLite/)
    expect(dec!.content).toMatch(/native binary|single installer/i)
    expect(dec!.entities).toEqual(expect.arrayContaining(['JSONL']))

    // Exactly one decision lesson: the option-weighing sentence was NOT distilled,
    // and no spurious procedural lesson was invented from the "bitten before" prose.
    expect(lessons.filter((l) => l.kind === 'decision')).toHaveLength(1)
    expect(lessons.filter((l) => l.memoryType === 'procedural')).toHaveLength(0)

    const blob = contentBlob(lessons)
    expect(blob).not.toMatch(/tradeoffs/i)
    expect(blob).not.toMatch(/append-only/i)
  })

  it('episode 3: a root-cause diagnosis distills to ONE semantic gotcha lesson', async () => {
    // A "why is this broken" thread: the fix has NOT been applied yet, so the durable
    // takeaway is the root cause itself, captured as a semantic fact/gotcha.
    const gotcha = ep({
      id: 'ep-rootcause-autoupdate',
      turns: [
        {
          role: 'user',
          text:
            'The auto-updater silently stops offering new versions for a chunk of our ' +
            'Windows users. There is no error dialog at all, it just goes quiet after ' +
            'one update. Any idea what is happening?',
        },
        {
          role: 'assistant',
          // Classic filler: "let me look" + "thanks".
          text:
            'Let me look. Thanks for the detailed report, I will dig into the update ' +
            'logs.',
        },
        {
          role: 'assistant',
          // "running it now" filler + an observation with no durable takeaway yet.
          text:
            'Okay, running it now against a broken install. I can reproduce it: the ' +
            'app checks for updates but the request never fires.',
        },
        {
          role: 'assistant',
          // The signal: the actual root cause, stated in ONE sentence with the
          // trigger phrase so the full explanation is captured.
          text:
            'The root cause is that our two-phase Windows signing build drops ' +
            'resources/app-update.yml: the --prepackaged step skips the pack phase ' +
            'that normally writes that file, so the installed app ends up with no ' +
            'update feed and the updater exits early without ever surfacing a dialog.',
        },
        {
          role: 'user',
          // Ack + follow-up. "build change" (not "build fix") -- and because fixes are
          // only read from ASSISTANT turns, this could not create a procedural lesson
          // regardless.
          text:
            'Ah, that explains it. Thanks for digging in, I will open a ticket to ' +
            'track the build change.',
        },
      ],
    })

    const lessons = await distillEpisode(gotcha)

    expect(lessons.length).toBeGreaterThanOrEqual(1)
    expect(lessons.length).toBeLessThanOrEqual(3)

    const fact = lessons.find((l) => l.kind === 'fact' && l.memoryType === 'semantic')
    expect(fact).toBeDefined()
    expect(fact!.gotcha).toBeDefined()

    // The distilled gotcha names the real cause (the dropped feed file + the build
    // step that drops it), not the surface symptom ("stops offering updates").
    expect(fact!.gotcha).toMatch(/app-update\.yml/)
    expect(fact!.gotcha).toMatch(/prepackaged/)
    expect(fact!.content).toMatch(/root cause/i)
    expect(fact!.entities).toEqual(expect.arrayContaining(['resources/app-update.yml']))

    // No fix was applied by the assistant, so no procedural lesson should be
    // fabricated even though a problem is clearly present.
    expect(lessons.filter((l) => l.memoryType === 'procedural')).toHaveLength(0)

    const blob = contentBlob(lessons)
    expect(blob).not.toMatch(/let me look/i)
    expect(blob).not.toMatch(/thanks/i)
    expect(blob).not.toMatch(/running it now/i)
    expect(blob).not.toMatch(/reproduce/i)
  })

  it('rejects a purely-conversational episode: no signal in, no manufactured lessons out', async () => {
    // The degenerate case behind the noise assertions above: an entire session of
    // pairing chit-chat with zero technical signal must distill to nothing. This is
    // the strongest statement that the extractor does not manufacture junk.
    const smallTalk = ep({
      id: 'ep-small-talk',
      turns: [
        {
          role: 'user',
          text:
            'Hey, are you around this afternoon? I would love to pair on the settings ' +
            'panel for a bit.',
        },
        {
          role: 'assistant',
          text:
            'Yes, I am here and ready whenever you are. Let me finish reading through ' +
            'the current file and I will ping you.',
        },
        {
          role: 'user',
          text:
            'Perfect, no rush at all. I am going to grab a coffee and I will be back ' +
            'in five minutes.',
        },
        {
          role: 'assistant',
          text:
            'Sounds great. Ok, I am running the app now so it is already warm by the ' +
            'time you get back.',
        },
        {
          role: 'user',
          text:
            'Thanks so much for setting that up, I really appreciate it. See you in a ' +
            'few.',
        },
      ],
    })

    expect(await distillEpisode(smallTalk)).toEqual([])
  })
})
