import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  attachClaudeSessionWatcher,
  claudeProjectsDir,
  mangleCwd,
  type ClaudeSessionWatcherHandle,
} from '../../src/main/transcriptWatchers/claudeCodeWatcher'
import { CONDUCTOR_CLAUDE_HOME_FILE } from '../../src/shared/conductorFiles'
import { initEventBus, query, _resetForTests as resetBus } from '../../src/main/agentEventBus'

// GitHub #36 (r5 Trace review): the swarm conductor's Trace followed the newest transcript in the
// swarm's folder, from when the conductor had first acted. That missed its first steps, and could
// be another session's: the last swarm's conductor, or a Claude Code worker in the same folder.
// The conductor now starts its session under an id of its own (`claude -p --session-id`), and
// main follows exactly that session's transcript, `<id>.jsonl`, from its first line.

const SID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427'
const OTHER = '9c0f1e2d-3b4a-4c5d-8e6f-7a8b9c0d1e2f'
const POLL = 1500

let tmpDir: string
let cwd: string
let env: NodeJS.ProcessEnv
let projects: string
let home: string
const handles: ClaudeSessionWatcherHandle[] = []

beforeEach(() => {
  // Only the watchers' polls are faked: the files are real, and so is the I/O that reads them.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  resetBus()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-csw-'))
  initEventBus(path.join(tmpDir, 'bus'))
  cwd = path.join(tmpDir, 'project')
  fs.mkdirSync(cwd)
  env = { CLAUDE_CONFIG_DIR: path.join(tmpDir, 'config') }
  projects = path.join(tmpDir, 'config', 'projects')
  // The home folder the conductor's run script records claude's config home in.
  home = path.join(tmpDir, 'home')
  fs.mkdirSync(home)
})

afterEach(() => {
  for (const h of handles.splice(0)) h.stop()
  vi.useRealTimers()
  resetBus()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

function attach(id = SID, at = cwd): ClaudeSessionWatcherHandle {
  const handle = attachClaudeSessionWatcher('conductor-1', at, id, env, home)
  expect(handle).not.toBeNull()
  handles.push(handle!)
  return handle!
}

/** A transcript line: the conductor calling a tool. */
function toolLine(tool: string): string {
  return JSON.stringify({ type: 'assistant', sessionId: SID, message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu-${tool}`, name: tool, input: {} }] } }) + '\n'
}

/** Writes a transcript, making its folder. */
function transcript(folder: string, id: string, ...tools: string[]): string {
  const dir = path.join(projects, folder)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(file, tools.map(toolLine).join(''))
  return file
}

/** The tools the watcher put on the bus for the conductor, in order. */
function tools(): string[] {
  return query({ terminalId: 'conductor-1', kind: 'tool_call' }).map((e) => e.summary)
}

/** Runs the watcher's polls. */
function poll(times = 1): void {
  vi.advanceTimersByTime(POLL * times)
}

/** Lets real I/O started by a poll (a look through every project folder) finish. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150))
}

const own = (): string => mangleCwd(fs.realpathSync(cwd))

describe('attachClaudeSessionWatcher', () => {
  it("follows the session's own transcript from its first line, not from where it stood", () => {
    transcript(own(), SID, 'swarm_create_task', 'create_terminal')
    attach()
    expect(tools()).toEqual(['swarm_create_task', 'create_terminal'])
  })

  it('waits for the transcript to appear, then reads it from its first line, and on as it grows', () => {
    attach()
    poll(2)
    expect(tools()).toEqual([])
    const file = transcript(own(), SID, 'swarm_send_message')
    poll()
    expect(tools()).toEqual(['swarm_send_message'])
    fs.appendFileSync(file, toolLine('swarm_update_task'))
    poll()
    expect(tools()).toEqual(['swarm_send_message', 'swarm_update_task'])
  })

  it('never follows another session in the folder, however new it is', () => {
    transcript(own(), OTHER, 'Edit')
    attach()
    poll(8)
    expect(tools()).toEqual([])
    transcript(own(), SID, 'swarm_create_task')
    // The other session goes on writing, and is newer still.
    fs.appendFileSync(path.join(projects, own(), `${OTHER}.jsonl`), toolLine('Bash'))
    poll(2)
    expect(tools()).toEqual(['swarm_create_task'])
  })

  // Live, claude 2.1.303 started in a junction kept its transcript under the junction's target.
  it("looks under the folder named for a link's target, where Claude Code keeps it", () => {
    const link = path.join(tmpDir, 'project-link')
    fs.symlinkSync(cwd, link, 'junction')
    transcript(own(), SID, 'Read')
    attach(SID, link)
    expect(tools()).toEqual(['Read'])
    fs.unlinkSync(link)
  })

  // PowerShell spells out a short name before it starts claude, which keeps what it was handed:
  // a conductor started in C:\Users\TERMPO~1\... kept its transcript under ...TermpolisUser1...
  const short = os.tmpdir().includes('~') && fs.realpathSync.native(os.tmpdir()) !== os.tmpdir()
  it.runIf(process.platform === 'win32' && short)('looks under the folder named for a Windows short name spelled out, as PowerShell hands it on', () => {
    expect(cwd).toContain('~')
    transcript(mangleCwd(fs.realpathSync.native(cwd)), SID, 'Glob')
    attach()
    expect(tools()).toEqual(['Glob'])
  })

  // A look is the one at attach and then one each poll; every 4th looks through every folder.
  it('looks under the folder named for a working folder that is not there, as it was given', () => {
    const gone = path.join(tmpDir, 'not-there')
    transcript(mangleCwd(gone), SID, 'Read')
    attach(SID, gone)
    expect(tools()).toEqual(['Read'])
  })

  it('finds it in any project folder, looking through all of them every 4th look', async () => {
    const elsewhere = transcript('named-some-other-way', SID, 'TodoWrite')
    const handle = attach()
    poll(2)
    await settle()
    expect(tools()).toEqual([])
    poll()
    await vi.waitFor(() => expect(tools()).toEqual(['TodoWrite']))
    expect(handle.sessionFile).toBe(elsewhere)
  })

  // One folder of many holds it, listed anywhere: the look takes that one, not the first listed.
  it('finds it in a project folder listed after others that hold no such file', async () => {
    fs.mkdirSync(path.join(projects, 'aaa-listed-first'), { recursive: true })
    const elsewhere = transcript('zzz-listed-last', SID, 'TodoWrite')
    // Node lists a folder by name on Linux and macOS, and NTFS keeps one in that order: the folder
    // that holds the session is not the first listed.
    expect(fs.readdirSync(projects)).toEqual(['aaa-listed-first', 'zzz-listed-last'])
    const handle = attach()
    poll(3)
    await vi.waitFor(() => expect(tools()).toEqual(['TodoWrite']))
    expect(handle.sessionFile).toBe(elsewhere)
  })

  it('looks through every folder up to the 200th look', async () => {
    attach()
    poll(198)
    await settle()
    transcript('named-some-other-way', SID, 'TodoWrite')
    poll()
    await vi.waitFor(() => expect(tools()).toEqual(['TodoWrite']))
  })

  it('stops looking through every folder after the 200th look, and goes on looking where it will be', async () => {
    attach()
    poll(199)
    await settle()
    transcript('named-some-other-way', SID, 'TodoWrite')
    poll(8)
    await settle()
    expect(tools()).toEqual([])
    transcript(own(), SID, 'swarm_create_task')
    poll()
    expect(tools()).toEqual(['swarm_create_task'])
  })

  it('follows one file only, when the look through every folder answers after the file was found where it will be', async () => {
    transcript('named-some-other-way', SID, 'Elsewhere')
    attach()
    poll(3) // the 4th look goes through every folder, and answers later
    transcript(own(), SID, 'Own')
    poll() // finds it where it will be first
    await settle()
    poll(2)
    expect(tools()).toEqual(['Own'])
  })

  it('looks where its environment keeps Claude Code sessions', () => {
    env = { CLAUDE_CONFIG_DIR: path.join(tmpDir, 'other-config') }
    transcript(own(), SID, 'Read')
    attach()
    poll(8)
    expect(tools()).toEqual([])
  })

  it('takes a session id in either case, and nothing that is no session id', () => {
    for (const id of ['../../etc/passwd', 'not-a-uuid', '', `${SID}.jsonl`, `${SID}x`, `x${SID}`]) {
      expect(attachClaudeSessionWatcher('conductor-1', cwd, id, env, home)).toBeNull()
    }
    transcript(own(), SID.toUpperCase(), 'Read')
    attach(SID.toUpperCase())
    expect(tools()).toEqual(['Read'])
  })

  it('reads nothing once stopped, before or after its file appears', async () => {
    const early = attach()
    expect(vi.getTimerCount()).toBe(1) // it looks for its file
    early.stop()
    expect(vi.getTimerCount()).toBe(0) // and no longer does
    const file = transcript(own(), SID, 'Read')
    poll(8)
    await settle()
    expect(tools()).toEqual([])

    const late = attach()
    expect(tools()).toEqual(['Read'])
    expect(vi.getTimerCount()).toBe(1) // the tail's poll, not the look for the file
    late.stop()
    expect(vi.getTimerCount()).toBe(0)
    fs.appendFileSync(file, toolLine('Edit'))
    poll(2)
    expect(tools()).toEqual(['Read'])
  })

  it('starts no tail when a look through every folder answers after it was stopped', async () => {
    transcript('named-some-other-way', SID, 'TodoWrite')
    const handle = attach()
    poll(3)
    handle.stop()
    await settle()
    poll(2)
    expect(tools()).toEqual([])
  })

  it("names the file it looks for until it finds one, then the one it follows", () => {
    const handle = attach()
    expect(handle.sessionFile).toBe(path.join(projects, own(), `${SID}.jsonl`))
    expect(handle.sessionId).toBe(SID)
    expect(handle.terminalId).toBe('conductor-1')
  })
})

// The conductor's claude keeps its session under the config home it gets from the shell it runs in,
// which the shell's profile or a command typed before the run can set: the run script records it.
describe('attachClaudeSessionWatcher: the config home the run script recorded', () => {
  /** What the run script writes: Windows PowerShell 5.1 as UTF-8 with a BOM and CRLF, bash plainly. */
  function record(id: string, configDir: string, windows = true): void {
    const text = windows ? '\uFEFF' + id + '\r\n' + configDir + '\r\n' : id + '\n' + configDir + '\n'
    fs.writeFileSync(path.join(home, CONDUCTOR_CLAUDE_HOME_FILE), text)
  }
  /** A transcript of this session under a config home's projects folder. */
  function under(configHome: string, tool: string): void {
    const dir = path.join(configHome, 'projects', own())
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, SID + '.jsonl'), toolLine(tool))
  }

  it("follows the session under the recorded config home, not the environment's", () => {
    under(path.join(tmpDir, 'config'), 'FromEnv')
    under(path.join(tmpDir, 'profile'), 'FromRecord')
    for (const windows of [true, false]) {
      resetBus()
      record(SID, path.join(tmpDir, 'profile'), windows)
      const handle = attach()
      expect(tools()).toEqual(['FromRecord'])
      expect(handle.sessionFile).toBe(path.join(tmpDir, 'profile', 'projects', own(), SID + '.jsonl'))
      handle.stop()
    }
  })

  it('reads a record that names the session in another case, as an id is the same in any case', () => {
    under(path.join(tmpDir, 'profile'), 'FromRecord')
    record(SID.toUpperCase(), path.join(tmpDir, 'profile'))
    attach()
    expect(tools()).toEqual(['FromRecord'])
  })

  it('takes a record with no config home for ~/.claude, whatever the environment says', () => {
    under(path.join(home, '.claude'), 'Default')
    under(path.join(tmpDir, 'config'), 'FromEnv')
    record(SID, '')
    attach()
    expect(tools()).toEqual(['Default'])
    // Nor does a record of the id alone, with no line after it.
    resetBus()
    for (const h of handles.splice(0)) h.stop()
    fs.writeFileSync(path.join(home, CONDUCTOR_CLAUDE_HOME_FILE), SID)
    attach()
    expect(tools()).toEqual(['Default'])
  })

  it('reads a relative config home from the folder claude runs in', () => {
    under(path.join(cwd, 'profiles', 'work'), 'Relative')
    record(SID, 'profiles/work')
    attach()
    expect(tools()).toEqual(['Relative'])
  })

  it("leaves another session's record, the last launch's, to the environment", () => {
    under(path.join(tmpDir, 'config'), 'FromEnv')
    under(path.join(tmpDir, 'profile'), 'FromRecord')
    record(OTHER, path.join(tmpDir, 'profile'))
    attach()
    expect(tools()).toEqual(['FromEnv'])
  })

  it('uses a record written after it started looking, and looks through that config home from then on', async () => {
    const handle = attach()
    poll()
    record(SID, path.join(tmpDir, 'profile'))
    const dir = path.join(tmpDir, 'profile', 'projects', 'named-some-other-way')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, SID + '.jsonl'), toolLine('Scanned'))
    poll(2) // the 4th look goes through every folder of the recorded config home
    await vi.waitFor(() => expect(tools()).toEqual(['Scanned']))
    expect(handle.sessionFile).toBe(path.join(dir, SID + '.jsonl'))
  })

  it("keeps the session's record once read, though the file is written again for the next launch", () => {
    record(SID, path.join(tmpDir, 'profile'))
    attach()
    record(OTHER, path.join(tmpDir, 'other-profile'))
    under(path.join(tmpDir, 'profile'), 'FromRecord')
    poll()
    expect(tools()).toEqual(['FromRecord'])
  })
})

describe('claudeProjectsDir', () => {
  it("is ~/.claude/projects without CLAUDE_CONFIG_DIR, or with it empty, as Claude Code's own code reads it", () => {
    expect(claudeProjectsDir(cwd, {})).toBe(path.join(os.homedir(), '.claude', 'projects'))
    expect(claudeProjectsDir(cwd, {}, home)).toBe(path.join(home, '.claude', 'projects'))
    expect(claudeProjectsDir(cwd, { CLAUDE_CONFIG_DIR: '' })).toBe(path.join(os.homedir(), '.claude', 'projects'))
  })

  it('is under CLAUDE_CONFIG_DIR when that is set, a relative one read from the folder claude runs in', () => {
    expect(claudeProjectsDir(cwd, { CLAUDE_CONFIG_DIR: path.join(tmpDir, 'cfg') })).toBe(path.join(tmpDir, 'cfg', 'projects'))
    expect(claudeProjectsDir(cwd, { CLAUDE_CONFIG_DIR: 'profiles/work' })).toBe(path.join(cwd, 'profiles', 'work', 'projects'))
  })

  it("defaults to the environment Termpolis runs in, which its terminals are started with", () => {
    const saved = process.env.CLAUDE_CONFIG_DIR
    try {
      process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, 'from-env')
      expect(claudeProjectsDir(cwd)).toBe(path.join(tmpDir, 'from-env', 'projects'))
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
    }
  })
})
