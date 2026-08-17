// The two real-work signals the brain never received.
//
// outcomeSignals.deriveOutcome has understood 'git-commit' and 'test-run' since v1.36,
// but nothing PRODUCED them for ordinary work: the only commit that ever counted was one
// made through the in-app Git panel, and the only test run was swarm:run-command. A commit
// typed into a terminal pane and a test run launched by an agent — the two things that
// happen all day — reached the competence store as silence, which is why every domain sat
// at attempts:0 / "unproven" forever.
//
// These tests pin BOTH halves, and pin the precision rules just as hard as the happy paths:
// a branch switch is not a commit, and `cat vitest.config.ts` is not a test run.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { join } from 'path'
import {
  startLearningSignals,
  stopLearningSignals,
  isTestCommand,
  type LearningSignalDeps,
} from '../../src/main/learningSignals'
import type { AgentEvent } from '../../src/main/agentEventBus'
import type { WorkEvent } from '../../src/main/outcomeSignals'

const ROOT = join('/repo')
const GITDIR = join(ROOT, '.git')
const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

// ── fakes ────────────────────────────────────────────────────────────────────

/** The two reads the git plumbing performs, backed by a Map. Directories are tracked
 *  separately because gitDirOf leans on a directory read throwing EISDIR. */
function makeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  const dirs = new Set<string>([GITDIR])
  return {
    files,
    dirs,
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    readFileSync: (p: string) => {
      if (!files.has(p)) {
        throw new Error(dirs.has(p) ? `EISDIR: illegal operation on a directory, read ${p}` : `ENOENT: ${p}`)
      }
      return files.get(p) as string
    },
  }
}

/** A repo on `main` sitting at `sha`. */
function repoFs(sha: string) {
  return makeFs({
    [join(GITDIR, 'HEAD')]: 'ref: refs/heads/main\n',
    [join(GITDIR, 'refs', 'heads', 'main')]: `${sha}\n`,
  })
}

interface Harness {
  emitted: WorkEvent[]
  tick: () => void
  fire: (e: Partial<AgentEvent>) => void
  unsubscribed: () => number
  deps: LearningSignalDeps
}

/** Start the module with every seam faked, and hand back the two drivers a test needs:
 *  `tick()` runs one git poll, `fire()` pushes one agent event through the bus. */
function harness(over: Partial<LearningSignalDeps> = {}): Harness {
  const emitted: WorkEvent[] = []
  let ticker: (() => void) | null = null
  let unsubCount = 0
  const deps: LearningSignalDeps = {
    openProjects: () => [ROOT],
    cwdForTerminal: () => ROOT,
    // The real caller passes normalizeProjectSlug; '' means "not a project" (the home dir).
    normalizeProject: (cwd: string) => (cwd === join('/home', 'me') ? '' : 'repo'),
    emit: (e) => { emitted.push(e) },
    subscribe: () => { unsubCount++; return () => { unsubCount-- } },
    fs: repoFs(SHA_A),
    readBytes: () => new Uint8Array(),
    setInterval: (fn) => { ticker = fn; return 0 as unknown as ReturnType<typeof setInterval> },
    clearInterval: () => { ticker = null },
    ...over,
  }
  let listener: (e: AgentEvent) => void = () => {}
  const subscribe = deps.subscribe
  deps.subscribe = (cb) => { listener = cb; return subscribe(cb) }
  startLearningSignals(deps)
  return {
    emitted,
    tick: () => ticker?.(),
    fire: (e) => listener({ id: '1', ts: 1000, terminalId: 't1', agentType: 'claude', kind: 'tool_call', summary: '', payload: {}, ...e }),
    unsubscribed: () => unsubCount,
    deps,
  }
}

afterEach(() => stopLearningSignals())

// ── git HEAD watcher ─────────────────────────────────────────────────────────

describe('learningSignals — a commit made in a terminal is evidence', () => {
  it('seeds silently on the first tick — the sha we found is not a commit we watched land', () => {
    const h = harness()
    h.tick()
    expect(h.emitted).toEqual([])
  })

  it('emits a git-commit when HEAD advances on the SAME ref', () => {
    const fs = repoFs(SHA_A)
    const h = harness({ fs })
    h.tick()
    fs.files.set(join(GITDIR, 'refs', 'heads', 'main'), `${SHA_B}\n`)
    h.tick()
    expect(h.emitted).toEqual([{ kind: 'git-commit', project: 'repo', ok: true }])
  })

  it('does not re-emit while HEAD stands still', () => {
    const h = harness()
    h.tick()
    h.tick()
    h.tick()
    expect(h.emitted).toEqual([])
  })

  it('a branch switch is NOT a commit — the new position is adopted silently', () => {
    const fs = repoFs(SHA_A)
    fs.files.set(join(GITDIR, 'refs', 'heads', 'feature'), `${SHA_B}\n`)
    const h = harness({ fs })
    h.tick()
    fs.files.set(join(GITDIR, 'HEAD'), 'ref: refs/heads/feature\n')
    h.tick()
    expect(h.emitted).toEqual([])
    // …but a commit ON the new branch still counts.
    fs.files.set(join(GITDIR, 'refs', 'heads', 'feature'), `${SHA_A}\n`)
    h.tick()
    expect(h.emitted).toEqual([{ kind: 'git-commit', project: 'repo', ok: true }])
  })

  it('follows a DETACHED head too — the raw sha in .git/HEAD is the position', () => {
    const fs = makeFs({ [join(GITDIR, 'HEAD')]: `${SHA_A}\n` })
    const h = harness({ fs })
    h.tick()
    fs.files.set(join(GITDIR, 'HEAD'), `${SHA_B}\n`)
    h.tick()
    expect(h.emitted).toEqual([{ kind: 'git-commit', project: 'repo', ok: true }])
  })

  it('ignores a cwd that is not a repo at all', () => {
    const fs = makeFs()
    fs.dirs.delete(GITDIR)
    const h = harness({ fs })
    h.tick()
    h.tick()
    expect(h.emitted).toEqual([])
  })

  it('ignores a repo whose ref cannot be resolved yet (no loose ref, no packed-refs)', () => {
    const h = harness({ fs: makeFs({ [join(GITDIR, 'HEAD')]: 'ref: refs/heads/main\n' }) })
    h.tick()
    h.tick()
    expect(h.emitted).toEqual([])
  })

  it('never books the home directory as a project — it is not a competence domain', () => {
    const home = join('/home', 'me')
    const fs = repoFs(SHA_A)
    const h = harness({ fs, openProjects: () => [home] })
    h.tick()
    fs.files.set(join(GITDIR, 'refs', 'heads', 'main'), `${SHA_B}\n`)
    h.tick()
    expect(h.emitted).toEqual([])
  })

  it('one unreadable repo does not stop the others on the same tick', () => {
    const fs = repoFs(SHA_A)
    const bad = join('/bad')
    const h = harness({
      fs,
      openProjects: () => [bad, ROOT],
      normalizeProject: (cwd) => { if (cwd === bad) throw new Error('boom'); return 'repo' },
    })
    h.tick()
    fs.files.set(join(GITDIR, 'refs', 'heads', 'main'), `${SHA_B}\n`)
    h.tick()
    expect(h.emitted).toEqual([{ kind: 'git-commit', project: 'repo', ok: true }])
  })

  it('a broken session read costs one tick, not the ticker', () => {
    const h = harness({ openProjects: () => { throw new Error('session unreadable') } })
    expect(() => h.tick()).not.toThrow()
    expect(h.emitted).toEqual([])
  })

  it('forgets a project once it closes, so reopening it re-seeds instead of firing', () => {
    const fs = repoFs(SHA_A)
    let open = [ROOT]
    const h = harness({ fs, openProjects: () => open })
    h.tick()
    open = []
    h.tick()
    // Moved while the project was closed: reopening must adopt, not claim a commit.
    fs.files.set(join(GITDIR, 'refs', 'heads', 'main'), `${SHA_B}\n`)
    open = [ROOT]
    h.tick()
    expect(h.emitted).toEqual([])
  })
})

// ── test-run classifier ──────────────────────────────────────────────────────

describe('learningSignals — isTestCommand is deliberately narrow', () => {
  it.each([
    'npm test',
    'npm run test',
    'npm run test:unit -- --shard=1/2',
    'pnpm test',
    'yarn test',
    'bun test',
    'npx vitest run tests/electron/foo.test.ts --reporter=dot',
    'vitest run',
    'jest --ci',
    'npx jest',
    'pytest -q',
    'python -m pytest',
    'python3 -m pytest tests/',
    'cargo test',
    'go test ./...',
    'dotnet test',
    'cd /repo && npm test',
  ])('recognises %s', (cmd) => {
    expect(isTestCommand(cmd)).toBe(true)
  })

  it.each([
    '',
    'npm run build',
    'npm run lint',
    'npm install',
    'cargo build',
    'go build ./...',
    'tsc --noEmit',
    'git commit -m "tests pass"',
    // The trap a substring match falls into: reading a config file is not running it.
    'cat vitest.config.ts',
    'rm -rf node_modules/.vitest',
    'grep -rn pytest .',
  ])('refuses %s', (cmd) => {
    expect(isTestCommand(cmd)).toBe(false)
  })
})

describe('learningSignals — a test run is honest in both directions', () => {
  it('a passing run emits exitCode 0', () => {
    const h = harness()
    h.fire({ kind: 'tool_call', payload: { tool: 'Bash', input: { command: 'npm test' } } })
    h.fire({ kind: 'tool_result', payload: { toolUseId: 'x', isError: false } })
    expect(h.emitted).toEqual([{ kind: 'test-run', project: 'repo', exitCode: 0 }])
  })

  it('a failing run emits exitCode 1 — this is what calibrates confidence back DOWN', () => {
    const h = harness()
    h.fire({ kind: 'tool_call', payload: { tool: 'Bash', input: { command: 'npx vitest run' } } })
    h.fire({ kind: 'tool_result', payload: { toolUseId: 'x', isError: true } })
    expect(h.emitted).toEqual([{ kind: 'test-run', project: 'repo', exitCode: 1 }])
  })

  it('reads the command straight off payload.input when it is a bare string', () => {
    const h = harness()
    h.fire({ kind: 'tool_call', payload: { input: 'cargo test' } })
    h.fire({ kind: 'tool_result', payload: { isError: false } })
    expect(h.emitted).toEqual([{ kind: 'test-run', project: 'repo', exitCode: 0 }])
  })

  it('reads payload.command when a producer puts it there', () => {
    const h = harness()
    h.fire({ kind: 'tool_call', payload: { command: 'pytest' } })
    h.fire({ kind: 'tool_result', payload: { isError: false } })
    expect(h.emitted).toEqual([{ kind: 'test-run', project: 'repo', exitCode: 0 }])
  })

  it('emits NOTHING for a command that is not a test run', () => {
    const h = harness()
    h.fire({ kind: 'tool_call', payload: { tool: 'Bash', input: { command: 'npm run build' } } })
    h.fire({ kind: 'tool_result', payload: { isError: true } })
    expect(h.emitted).toEqual([])
  })

  it('emits NOTHING for a tool_call carrying no command at all', () => {
    const h = harness()
    h.fire({ kind: 'tool_call', payload: { tool: 'Read', input: { file_path: '/x' } } })
    h.fire({ kind: 'tool_result', payload: { isError: false } })
    expect(h.emitted).toEqual([])
  })

  it('emits NOTHING for a tool_result with no test call in front of it', () => {
    const h = harness()
    h.fire({ kind: 'tool_result', payload: { isError: true } })
    expect(h.emitted).toEqual([])
  })

  it('emits NOTHING for kinds that are neither a call nor a result', () => {
    const h = harness()
    h.fire({ kind: 'message', payload: { role: 'assistant' } })
    h.fire({ kind: 'token_update', payload: {} })
    expect(h.emitted).toEqual([])
  })

  it('a later tool_call supersedes the pending test — the result belongs to THAT call', () => {
    const h = harness()
    h.fire({ kind: 'tool_call', payload: { input: { command: 'npm test' } } })
    h.fire({ kind: 'tool_call', payload: { input: { file_path: '/x' } } })
    h.fire({ kind: 'tool_result', payload: { isError: true } })
    expect(h.emitted).toEqual([])
  })

  it('pairs per terminal — another pane\'s result is not this pane\'s test', () => {
    const h = harness()
    h.fire({ terminalId: 't1', kind: 'tool_call', payload: { input: { command: 'npm test' } } })
    h.fire({ terminalId: 't2', kind: 'tool_result', payload: { isError: true } })
    expect(h.emitted).toEqual([])
    h.fire({ terminalId: 't1', kind: 'tool_result', payload: { isError: false } })
    expect(h.emitted).toEqual([{ kind: 'test-run', project: 'repo', exitCode: 0 }])
  })

  it('emits NOTHING when the result carries no isError flag — an unknown outcome is not evidence', () => {
    // The Codex watcher publishes payload { type } with no isError. Booking that as a
    // pass would mean every Codex test run "succeeded", which is exactly the dishonest
    // ratchet this signal exists to break.
    const h = harness()
    h.fire({ kind: 'tool_call', payload: { input: { command: 'npm test' } } })
    h.fire({ kind: 'tool_result', payload: { type: 'function_call_output' } })
    expect(h.emitted).toEqual([])
    // …and the orphan is cleared, so the NEXT result can't inherit it either.
    h.fire({ kind: 'tool_result', payload: { isError: false } })
    expect(h.emitted).toEqual([])
  })

  it('refuses to pair a result that arrives long after the call', () => {
    const h = harness()
    h.fire({ ts: 1000, kind: 'tool_call', payload: { input: { command: 'npm test' } } })
    h.fire({ ts: 1000 + 60 * 60 * 1000, kind: 'tool_result', payload: { isError: false } })
    expect(h.emitted).toEqual([])
  })

  it('ignores a terminal whose cwd is unknown', () => {
    const h = harness({ cwdForTerminal: () => null })
    h.fire({ kind: 'tool_call', payload: { input: { command: 'npm test' } } })
    h.fire({ kind: 'tool_result', payload: { isError: false } })
    expect(h.emitted).toEqual([])
  })

  it('ignores a terminal sitting in the home directory', () => {
    const h = harness({ cwdForTerminal: () => join('/home', 'me') })
    h.fire({ kind: 'tool_call', payload: { input: { command: 'npm test' } } })
    h.fire({ kind: 'tool_result', payload: { isError: false } })
    expect(h.emitted).toEqual([])
  })

  it('caps the in-flight table so a terminal that never reports back cannot leak forever', () => {
    const h = harness()
    h.fire({ terminalId: 'first', kind: 'tool_call', payload: { input: { command: 'npm test' } } })
    for (let i = 0; i < 200; i++) {
      h.fire({ terminalId: `t${i}`, kind: 'tool_call', payload: { input: { command: 'npm test' } } })
    }
    h.fire({ terminalId: 'first', kind: 'tool_result', payload: { isError: false } })
    expect(h.emitted).toEqual([])
  })
})

// ── lifecycle ────────────────────────────────────────────────────────────────

describe('learningSignals — the caller owns the lifecycle', () => {
  it('stop() before any start() is a no-op', () => {
    expect(() => stopLearningSignals()).not.toThrow()
  })

  it('stop() unsubscribes from the agent event bus', () => {
    const h = harness()
    expect(h.unsubscribed()).toBe(1)
    stopLearningSignals()
    expect(h.unsubscribed()).toBe(0)
  })

  it('start() twice tears the first watcher down rather than doubling it', () => {
    const h = harness()
    startLearningSignals(h.deps)
    expect(h.unsubscribed()).toBe(1)
  })

  it('stop() drops the remembered HEADs, so a restart re-seeds instead of firing', () => {
    const fs = repoFs(SHA_A)
    const h = harness({ fs })
    h.tick()
    stopLearningSignals()
    fs.files.set(join(GITDIR, 'refs', 'heads', 'main'), `${SHA_B}\n`)
    const h2 = harness({ fs })
    h2.tick()
    expect(h2.emitted).toEqual([])
  })

  it('falls back to the real interval when no timer seam is injected', () => {
    const spy = vi.spyOn(globalThis, 'setInterval')
    const clear = vi.spyOn(globalThis, 'clearInterval')
    startLearningSignals({
      openProjects: () => [],
      cwdForTerminal: () => null,
      normalizeProject: () => '',
      emit: () => {},
      subscribe: () => () => {},
      fs: makeFs(),
      readBytes: () => new Uint8Array(),
    })
    expect(spy).toHaveBeenCalled()
    stopLearningSignals()
    expect(clear).toHaveBeenCalled()
    spy.mockRestore()
    clear.mockRestore()
  })
})
