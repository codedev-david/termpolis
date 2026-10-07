import { describe, it, expect } from 'vitest'
import {
  distillEpisode,
  isDecisionSentence,
  isFixSentence,
  isProblemSentence,
  type Episode,
} from '../../src/main/mnemeReflect'

// Every sentence below was stored as a lesson in a real brain between 2026-09-25 and 2026-10-06,
// most at importance 0.85-0.95, the highest a lesson gets. None of them is a lesson.

const said = (...texts: string[]): Episode => ({
  id: 'junk',
  project: 'p',
  source: 'claude',
  turns: texts.map((text) => ({ role: 'assistant' as const, text })),
})

const procedural = async (...texts: string[]) =>
  (await distillEpisode(said(...texts))).filter((l) => l.memoryType === 'procedural')
const decisions = async (...texts: string[]) =>
  (await distillEpisode(said(...texts))).filter((l) => l.kind === 'decision')

describe('mnemeReflect — no "problem" in a word that merely starts with e', () => {
  it.each([
    ['Confirming the installers, adding the release notes, and checking the email notification:',
      'I added the release notes covering Linked machines, the setup steps and the fixes.'],
    ['When he does, adding each person takes one API call.',
      'That fixed the duplicate entries.'],
    ['Reading the extractor and its base class first.',
      "Only `GetContentBlocksFromFile` routes by extension, so the fix covers that extractor's whole path."],
    ["That address isn't a secret, so it goes straight into PAS-APP-CONFIG with no Key Vault entry.",
      "It's live again, and PAS-APP-CONFIG PR 40755 mirrors the fix."],
    ["Status: I'm done with everything I can finish myself except the Flyway work.",
      'The Flyway fix is in PR 40625.'],
    ['Nothing is broken, and the only deadline is 13 Oct, when the access ends.',
      'Before 13 Oct: run the 40-file check, then pick the fix.'],
  ])('%s', async (problem, fix) => {
    expect(await procedural(problem, fix)).toEqual([])
  })

  it('still reads a real error code as a problem', async () => {
    const [lesson] = await procedural(
      'npm install dies with EACCES on the global prefix.',
      'Fixed by switching to a user-level prefix.',
    )
    expect(lesson?.content).toBe('Problem: npm install dies with EACCES on the global prefix. → Fix: Fixed by switching to a user-level prefix.')
  })

  it('tells the codes from the words', () => {
    for (const s of ['open() returned ENOENT', 'connect ECONNREFUSED 127.0.0.1:9315', 'spawn E2BIG']) {
      expect(isProblemSentence(s), s).toBe(true)
    }
    for (const s of ['Check the email.', 'Each entry exists.', 'Extending the extractor.', 'Enrich every event.']) {
      expect(isProblemSentence(s), s).toBe(false)
    }
  })
})

describe('mnemeReflect — a fix has to be one', () => {
  it('a status that says it is NOT fixed is not a fix', async () => {
    expect(await procedural(
      'The sync job failed again overnight.',
      '- **SDP 73754:** still In Progress, not resolved.',
    )).toEqual([])
    for (const s of ['not resolved', "it isn't fixed yet", "hasn't been fixed", 'no fix yet', 'never patched']) {
      expect(isFixSentence(s), s).toBe(false)
    }
  })

  it('a question is not a fix', async () => {
    expect(await procedural(
      'The OCR check found the cause of the prod "PDF not valid" failures, and the fix is small.',
      'Want me to send either message and write the OCR fix PR?',
    )).toEqual([])
  })

  it('a "- **Fix:**" bullet still is one', async () => {
    const [lesson] = await procedural(
      "- an iteration path `MSI-PAS\\Current` that doesn't exist in any project.",
      '- **Fix:** PR 40835, merged into the sandbox branch and deployed.',
    )
    expect(lesson?.content).toMatch(/^Problem: - an iteration path .* → Fix: - \*\*Fix:\*\* PR 40835/)
  })
})

describe('mnemeReflect — reference lines are not lessons', () => {
  it('a "- **Label:** value" bullet is not a problem, even with "failed" in it', async () => {
    expect(await procedural(
      '- **Full suite with coverage (`--retry=2`, as CI):** 608 files passed (1 skipped), 0 failed.',
      'The full suite is running with the macOS fixes.',
    )).toEqual([])
    expect(await procedural(
      "- **How it runs:** the other Termpolis runs the request with its existing headless `exec`, which can't run there.",
      '- fixing `exec` so it runs in the right folder;',
    )).toEqual([])
  })
})

describe('mnemeReflect — a decision has to have been made', () => {
  it.each([
    '- **Password:** the Samba password you chose when running the script.',
    '- decide with Mike whether OrchDebug goes beyond Dev. The rest:',
    'One security problem turned up along the way, and you need to decide what happens next with it.',
    '**Decide on your four full-access ADO tokens.** The action list has a suggestion for each.',
    '| **ADO tokens** | Not decided. All 4 still exist, valid to Sep 2027. |',
    "Pulling the specifics for 73138 from today's log so the plan is concrete:",
    'Both live tries matched the lab exactly, as did the "chose hang by mistake" troubleshooting row.',
    'Make them required reviewers on development, qa and staging, and decide whether they replace the old policy |',
    "We haven't decided which region to deploy to.",
  ])('%s', async (text) => {
    expect(await decisions(text)).toEqual([])
  })

  it.each([
    ['We decided to use HNSW instead of brute force for the vector index.', /HNSW/],
    ['I chose Postgres over SQLite because two writers share the database.', /Postgres/],
    ['The plan is to ship the patch on Friday, after the smoke test.', /Friday/],
    ['Going with the managed identity, since the key would otherwise sit in a file.', /managed identity/],
  ])('still records: %s', async (text, expected) => {
    const [d] = await decisions(text)
    expect(d?.content).toMatch(expected)
  })

  it('a short "the plan is" trigger still takes its substance from the next sentence', () => {
    expect(isDecisionSentence('The plan is clear.')).toBe(true)
    expect(isDecisionSentence('Pulling the specifics from the log so the plan is concrete:')).toBe(false)
  })
})
