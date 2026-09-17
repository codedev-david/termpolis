import { describe, it, expect } from 'vitest'
import { distillEpisode, type Episode } from '../../src/main/mnemeReflect'

// The v1.46 distiller picked `problem` as the FIRST error-ish sentence anywhere in the
// episode (including the user's own turns) and `fix` as the FIRST fix-ish assistant
// sentence, then stapled them: `Problem: ${problem} → Fix: ${fix}`. Nothing checked the
// two were about the same thing, so a real store filled up with lessons like
//   "Problem: ok can we do everything but the APIM part? → Fix: fa8a158 Merged PR 39863"
// These tests pin the causal requirement: a procedural lesson may only be minted when the
// problem and the fix are actually related.

const procedural = (ls: Awaited<ReturnType<typeof distillEpisode>>) =>
  ls.filter((l) => l.memoryType === 'procedural')

describe('distillEpisode — causal problem→fix pairing', () => {
  it('does not pair a problem with an unrelated fix from a distant turn', async () => {
    const episode: Episode = {
      id: 'e1',
      turns: [
        { role: 'user', text: 'The deploy cannot find the config file.' },
        { role: 'assistant', text: 'Let me look at the deploy pipeline.' },
        { role: 'user', text: 'Also the invoice screen shows the wrong month.' },
        { role: 'assistant', text: 'Switching to the invoice module now.' },
        { role: 'assistant', text: 'Fixed the date formatting in the invoice module.' },
      ],
      outcome: { kind: 'commit', success: true },
    }

    const lessons = await distillEpisode(episode)

    // The config-file problem and the date-formatting fix share no subject. Stapling them
    // produces a recipe that would later be recommended for the wrong problem.
    for (const l of procedural(lessons)) {
      expect(`${l.problem} ${l.solution}`).not.toMatch(/cannot find the config file[\s\S]*date formatting/)
    }
  })

  it('still mints a procedural lesson when the fix genuinely addresses the problem', async () => {
    const episode: Episode = {
      id: 'e2',
      turns: [
        { role: 'user', text: 'Builds fail with ENOENT because `config.yaml` is not found.' },
        { role: 'assistant', text: 'Fixed it — `config.yaml` was gitignored, so CI never checked it out.' },
      ],
      outcome: { kind: 'commit', success: true },
    }

    const lessons = await distillEpisode(episode)

    expect(procedural(lessons).length).toBeGreaterThan(0)
    expect(procedural(lessons)[0].solution).toMatch(/gitignored/)
  })

  it('never emits a lesson whose problem and solution are the same sentence', async () => {
    const episode: Episode = {
      id: 'e3',
      turns: [
        {
          role: 'assistant',
          text: 'The build failed and the fix is to bump the compiler.',
        },
      ],
      outcome: { kind: 'commit', success: true },
    }

    const lessons = await distillEpisode(episode)

    for (const l of procedural(lessons)) {
      expect(l.problem).not.toBe(l.solution)
    }
  })

  it('does not mine harness noise for a problem statement', async () => {
    const episode: Episode = {
      id: 'e4',
      turns: [
        { role: 'user', text: '<status>failed</status>' },
        { role: 'assistant', text: 'Resolved the flaky selector by waiting on the settled text.' },
      ],
      outcome: { kind: 'test', success: true },
    }

    const lessons = await distillEpisode(episode)

    for (const l of procedural(lessons)) {
      expect(l.problem ?? '').not.toMatch(/<status>|<summary>|Background command/)
    }
  })
})
