import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { promises as fsp } from 'fs'
import { parseBySource } from '../../src/main/conversationIngest'
import { readSessionTranscript } from '../../src/main/liveTranscript'
import { reflectSoloSession, type SessionCursor } from '../../src/main/mnemeSession'
import { onSessionEpisode } from '../../src/main/mnemeReflex'
import { distillEpisode } from '../../src/main/mnemeReflect'

// End-to-end proof of the MAIN-SIDE solo-learning pipeline with the REAL modules
// (no mocked logic): a real on-disk transcript → parsed → session-delta → assembled
// episode → deterministic distillation → a lesson written + competence recorded.
// This is the assembled-behaviour verification that unit tests (each piece in
// isolation) can't give on their own.
describe('solo-session learning — full main-side pipeline (real modules)', () => {
  it('turns a real error→fix transcript into a written procedural lesson + recorded competence', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-int-'))
    const file = path.join(dir, 'session.jsonl')
    // A real Claude-format transcript: an error the agent then fixed.
    fs.writeFileSync(
      file,
      [
        '{"type":"user","timestamp":"2026-07-01T10:00:00.000Z","sessionId":"s1","cwd":"/repo/acme","message":{"role":"user","content":"the build fails with Error: cannot find module foo"}}',
        '{"type":"assistant","timestamp":"2026-07-01T10:00:05.000Z","sessionId":"s1","message":{"role":"assistant","content":[{"type":"text","text":"Fixed it — the foo package was missing from package.json. Added it and ran npm install; the build and tests pass now."}]}}',
      ].join('\n'),
    )

    const cursors = new Map<string, SessionCursor>()
    const written: unknown[] = []
    const competence: Array<{ domain: string; success: boolean }> = []

    const result = await reflectSoloSession(
      { terminalId: 't-int', cwd: '/repo/acme', agent: 'claude', project: 'acme' },
      {
        readTranscript: (cwd, agent) =>
          readSessionTranscript(cwd, agent, {
            findFile: () => file,
            readFile: (f) => fsp.readFile(f, 'utf8'),
            parse: (a, c) => parseBySource(a as never, c),
          }),
        getCursor: (id) => cursors.get(id),
        setCursor: (id, c) => {
          cursors.set(id, c)
        },
        reflect: (episode) =>
          onSessionEpisode(episode, {
            distill: (ep) => distillEpisode(ep),
            write: async (input) => {
              written.push(input)
              return { id: `mem-${written.length}` } as never
            },
            recordOutcome: (domain, success) => {
              competence.push({ domain, success })
            },
            now: 1000,
          }),
      },
    )

    try {
      // The pipeline fired and produced at least one distilled lesson.
      expect(result.fired).toBe(true)
      expect(result.lessons).toBeGreaterThan(0)
      expect(written.length).toBeGreaterThan(0)
      // Competence was recorded for the project domain as a success (error→fix).
      expect(competence).toContainEqual({ domain: 'acme', success: true })
      // The cursor advanced, so a re-run with no new turns is a no-op (idempotent).
      const rerun = await reflectSoloSession(
        { terminalId: 't-int', cwd: '/repo/acme', agent: 'claude', project: 'acme' },
        {
          readTranscript: (cwd, agent) =>
            readSessionTranscript(cwd, agent, {
              findFile: () => file,
              readFile: (f) => fsp.readFile(f, 'utf8'),
              parse: (a, c) => parseBySource(a as never, c),
            }),
          getCursor: (id) => cursors.get(id),
          setCursor: (id, c) => {
            cursors.set(id, c)
          },
          reflect: (episode) =>
            onSessionEpisode(episode, {
              distill: (ep) => distillEpisode(ep),
              write: async (input) => {
                written.push(input)
                return { id: `mem-${written.length}` } as never
              },
              recordOutcome: () => {},
              now: 2000,
            }),
        },
      )
      expect(rerun.fired).toBe(false) // no new turns → no duplicate learning
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})
