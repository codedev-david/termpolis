import { describe, it, expect } from 'vitest'
import { distillEpisode, type Episode } from '../../src/main/mnemeReflect'

// The distiller finds the problem by regex. That regex knew `crash`, `crashed` and `crashes` —
// but not `crashing`; `failed` and `failure` — but not `failing`; `throw` and `throws` — but not
// `throwing`. The present participle is how people actually report a problem while it is still
// happening: "it keeps crashing", "the build is failing", "it's throwing a TypeError".
//
// The consequence was worse than one missed sentence. With the user's turn invisible, the only
// remaining error-ish sentence was the ASSISTANT's own fix ("Fixed the concurrent teardown
// crash…" — it says `crash`), and a fix cannot be paired with itself, so the episode yielded NO
// lesson at all. An entire, perfectly clean diagnose-and-fix session taught the brain nothing.
//
// That is how the real-model semantic-recall test was failing: not a recall bug, an intake bug.

const procedural = (ls: Awaited<ReturnType<typeof distillEpisode>>) =>
  ls.filter((l) => l.memoryType === 'procedural')

function episodeSaying(problem: string): Episode {
  return {
    id: 'p1',
    turns: [
      { role: 'user', text: problem },
      {
        role: 'assistant',
        text: 'Fixed it by serializing terminal disposal behind a mutex so two panes never dispose the same pty.',
      },
    ],
    outcome: { kind: 'test', success: true },
  } as Episode
}

describe('distillEpisode — a problem reported in the present tense is still a problem', () => {
  it('learns from "keeps crashing"', async () => {
    const lessons = await distillEpisode(episodeSaying('the app keeps crashing when two terminals close at the same moment'))
    expect(procedural(lessons).length).toBeGreaterThan(0)
  })

  it('learns from "is failing"', async () => {
    const lessons = await distillEpisode(episodeSaying('the terminal teardown is failing whenever two panes close together'))
    expect(procedural(lessons).length).toBeGreaterThan(0)
  })

  it('learns from "throwing"', async () => {
    const lessons = await distillEpisode(episodeSaying('closing two terminals at once is throwing on the pty dispose path'))
    expect(procedural(lessons).length).toBeGreaterThan(0)
  })

  it('learns from "hanging" and "breaking", which report the same way', async () => {
    for (const p of [
      'the terminal teardown is hanging when two panes close at the same time',
      'closing two terminals at once keeps breaking the pty dispose path',
    ]) {
      expect(procedural(await distillEpisode(episodeSaying(p))).length).toBeGreaterThan(0)
    }
  })

  it('keeps the user sentence as the problem, not the assistant sentence that fixed it', async () => {
    // The specific inversion this bug caused: with the user's turn invisible, the assistant's own
    // fix was the only error-ish sentence in the episode.
    const lessons = procedural(
      await distillEpisode(episodeSaying('the app keeps crashing when two terminals close at the same moment')),
    )
    expect(lessons[0].problem).toMatch(/crashing/i)
    expect(lessons[0].problem).not.toMatch(/^Fixed/i)
  })

  it('does not fire on prose that merely uses the words', async () => {
    // Precision matters more than recall here: a wrong pairing writes a recipe that will later be
    // recommended for a problem it does not solve.
    const lessons = await distillEpisode({
      id: 'p2',
      turns: [
        { role: 'user', text: 'Add a breaking-change note to the changelog.' },
        { role: 'assistant', text: 'Added the note under Unreleased.' },
      ],
      outcome: { kind: 'test', success: true },
    } as Episode)
    expect(procedural(lessons)).toHaveLength(0)
  })
})
