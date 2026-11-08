// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readClaudeWindowSettings, claudeWindowSettingsFiles, SETTINGS_FILE_MAX_BYTES } from '../../src/main/headroom/shapingEnvReader'
import { buildShapingEnv, resolveShapingEnv } from '../../src/main/headroom/shapingEnv'

/**
 * The files a Claude launch's window is checked against. Every test uses a temp folder: the reader is
 * handed the folders to look in, so nothing here can reach the developer's own ~/.claude.
 */

const VAR = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'

describe('reading the Claude Code settings files that can hold a window', () => {
  let root: string
  let userDir: string
  let project: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-shaping-reader-'))
    userDir = path.join(root, 'user-claude')
    project = path.join(root, 'project')
    fs.mkdirSync(userDir, { recursive: true })
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true })
  })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  const put = (file: string, content: unknown): void => fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
  const userFile = (): string => path.join(userDir, 'settings.json')
  const projectFile = (): string => path.join(project, '.claude', 'settings.json')
  const localFile = (): string => path.join(project, '.claude', 'settings.local.json')
  const NOTHING = { env: null, savedWindow: false }

  it('looks at exactly three files: the user one, and the launch folder\'s two', () => {
    expect(claudeWindowSettingsFiles(userDir, project)).toEqual([userFile(), projectFile(), localFile()])
  })

  it('looks at the user file alone when there is no launch folder, and at nothing for a folder that is not absolute', () => {
    expect(claudeWindowSettingsFiles(userDir, undefined)).toEqual([userFile()])
    expect(claudeWindowSettingsFiles(userDir, '')).toEqual([userFile()])
    expect(claudeWindowSettingsFiles(userDir, 'relative/project')).toEqual([userFile()])
    // A blank home resolves to '' and joined it would be a file relative to wherever Termpolis was started from.
    expect(claudeWindowSettingsFiles('', project)).toEqual([projectFile(), localFile()])
    expect(claudeWindowSettingsFiles('relative/.claude', project)).toEqual([projectFile(), localFile()])
    expect(claudeWindowSettingsFiles('', undefined)).toEqual([])
  })

  it('reads nothing from a place with no settings files', async () => {
    expect(await readClaudeWindowSettings(userDir, project)).toEqual(NOTHING)
    expect(await readClaudeWindowSettings(path.join(root, 'does-not-exist'), path.join(root, 'nor-this'))).toEqual(NOTHING)
    expect(await readClaudeWindowSettings('', undefined)).toEqual(NOTHING)
  })

  it('reads the window variable out of the env block of the user file, and keeps no other entry of it', async () => {
    put(userFile(), { env: { [VAR]: '250000', OTHER: 'SENTINEL-KEY-NOT-KEPT' } })
    const got = await readClaudeWindowSettings(userDir, project)
    expect(got).toEqual({ env: { [VAR]: '250000' }, savedWindow: false })
    expect(JSON.stringify(got)).not.toContain('SENTINEL')
  })

  it('reads the env block of the launch folder\'s project file and of its local file', async () => {
    put(projectFile(), { env: { [VAR]: '250000' } })
    expect((await readClaudeWindowSettings(userDir, project)).env).toEqual({ [VAR]: '250000' })
    fs.rmSync(projectFile())
    put(localFile(), { env: { [VAR]: '350000' } })
    expect((await readClaudeWindowSettings(userDir, project)).env).toEqual({ [VAR]: '350000' })
  })

  it('puts the three together, a later file over an earlier one', async () => {
    // The same variable in three spellings: the later file's entry replaces the earlier one's under the same
    // spelling, and the spellings that differ are all kept (Windows reads the name in any case).
    put(userFile(), { env: { [VAR]: 'user', other: 'dropped' } })
    put(projectFile(), { env: { [VAR]: 'project' } })
    put(localFile(), { env: { [VAR.toLowerCase()]: 'local', A: 'dropped' } })
    expect((await readClaudeWindowSettings(userDir, project)).env).toEqual({ [VAR]: 'project', [VAR.toLowerCase()]: 'local' })
  })

  it('sees a saved window at the top level, or one saved for a model by /autocompact', async () => {
    put(userFile(), { autoCompactWindow: 200000 })
    expect(await readClaudeWindowSettings(userDir, project)).toEqual({ env: null, savedWindow: true })
    put(userFile(), { modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 500000 } } })
    expect((await readClaudeWindowSettings(userDir, project)).savedWindow).toBe(true)
    put(userFile(), {})
    put(localFile(), { autoCompactWindow: 'auto' })
    expect((await readClaudeWindowSettings(userDir, project)).savedWindow).toBe(true)
  })

  it('keeps only the env block and whether a window is saved: nothing else in a file is carried out of it', async () => {
    put(userFile(), {
      env: { A: '1' },
      apiKeyHelper: 'SENTINEL-HELPER-NOT-KEPT',
      permissions: { allow: ['Bash(SENTINEL-RULE-NOT-KEPT)'] },
      hooks: { SessionStart: [{ command: 'SENTINEL-HOOK-NOT-KEPT' }] },
      model: 'SENTINEL-MODEL-NOT-KEPT',
    })
    const got = await readClaudeWindowSettings(userDir, project)
    expect(Object.keys(got).sort()).toEqual(['env', 'savedWindow'])
    expect(JSON.stringify(got)).not.toContain('SENTINEL')
  })

  it('reads a file that begins with a byte-order mark, as Windows editors write them', async () => {
    put(userFile(), '\uFEFF' + JSON.stringify({ env: { [VAR]: '250000' } }))
    expect((await readClaudeWindowSettings(userDir, project)).env).toEqual({ [VAR]: '250000' })
  })

  it('counts an empty file as holding nothing', async () => {
    put(userFile(), '')
    put(projectFile(), '  \n ')
    expect(await readClaudeWindowSettings(userDir, project)).toEqual(NOTHING)
  })

  it('counts a file it cannot use as holding nothing, and still reads the others', async () => {
    put(userFile(), '{ not json')
    put(projectFile(), '["env"]')
    put(localFile(), { env: { [VAR]: '250000' } })
    expect(await readClaudeWindowSettings(userDir, project)).toEqual({ env: { [VAR]: '250000' }, savedWindow: false })
    put(localFile(), 'null')
    expect(await readClaudeWindowSettings(userDir, project)).toEqual(NOTHING)
    put(localFile(), '"just a string"')
    expect(await readClaudeWindowSettings(userDir, project)).toEqual(NOTHING)
  })

  it('does not read what is not a plain file: a folder with the file\'s name', async () => {
    fs.mkdirSync(userFile())
    put(projectFile(), { env: { [VAR]: '250000' } })
    expect((await readClaudeWindowSettings(userDir, project)).env).toEqual({ [VAR]: '250000' })
    fs.rmSync(projectFile())
    expect(await readClaudeWindowSettings(userDir, project)).toEqual(NOTHING)
  })

  it('does not read a file larger than the limit, so a launch never decodes something huge', async () => {
    const pad = 'x'.repeat(SETTINGS_FILE_MAX_BYTES)
    put(userFile(), JSON.stringify({ env: { [VAR]: '250000' }, pad }))
    expect(fs.statSync(userFile()).size).toBeGreaterThan(SETTINGS_FILE_MAX_BYTES)
    // Not decoded, and not taken for a file that holds nothing: it is one whose window this cannot see (see below).
    expect(await readClaudeWindowSettings(userDir, project)).toEqual({ env: null, savedWindow: false, unreadable: true })
    // Just under the limit is read.
    const room = SETTINGS_FILE_MAX_BYTES - JSON.stringify({ env: { [VAR]: '250000' }, pad: '' }).length - 16
    put(userFile(), JSON.stringify({ env: { [VAR]: '250000' }, pad: 'x'.repeat(room) }))
    expect(fs.statSync(userFile()).size).toBeLessThanOrEqual(SETTINGS_FILE_MAX_BYTES)
    expect((await readClaudeWindowSettings(userDir, project)).env).toEqual({ [VAR]: '250000' })
  })

  // The test above builds its files from the constant, so it would pass for any limit. This draws the line in bytes: a
  // file may be one mebibyte and not a byte more, which is what stops a launch decoding something huge on the main thread.
  it('draws the limit at one mebibyte exactly: a file of 1,048,576 bytes is read and one of 1,048,577 is not', async () => {
    expect(SETTINGS_FILE_MAX_BYTES).toBe(1024 * 1024)
    const base = JSON.stringify({ env: { [VAR]: '250000' }, pad: '' }).length
    put(userFile(), JSON.stringify({ env: { [VAR]: '250000' }, pad: 'x'.repeat(1_048_576 - base) }))
    expect(fs.statSync(userFile()).size).toBe(1_048_576)
    expect((await readClaudeWindowSettings(userDir, project)).env).toEqual({ [VAR]: '250000' })
    put(userFile(), JSON.stringify({ env: { [VAR]: '250000' }, pad: 'x'.repeat(1_048_577 - base) }))
    expect(fs.statSync(userFile()).size).toBe(1_048_577)
    expect(await readClaudeWindowSettings(userDir, project)).toEqual({ env: null, savedWindow: false, unreadable: true })
  })

  it('reads only the three named files: a neighbour with a similar name is never looked at', async () => {
    put(path.join(userDir, 'settings.backup.json'), { env: { [VAR]: '250000' } })
    put(path.join(userDir, 'settings.local.json'), { env: { [VAR]: '250000' } })
    put(path.join(project, '.claude', 'settings.team.json'), { env: { [VAR]: '250000' } })
    put(path.join(project, 'settings.json'), { env: { [VAR]: '250000' } })
    put(path.join(project, '..', 'settings.json'), { env: { [VAR]: '250000' } })
    expect(await readClaudeWindowSettings(userDir, project)).toEqual(NOTHING)
  })

  it('never throws, whatever it is handed', async () => {
    await expect(readClaudeWindowSettings(undefined as never, null as never)).resolves.toEqual(NOTHING)
    await expect(readClaudeWindowSettings(42 as never, {} as never)).resolves.toEqual(NOTHING)
    await expect(readClaudeWindowSettings(userDir, project, 42 as never)).resolves.toEqual(NOTHING)
  })

  // spawnTerminal opens the shell in the home folder when the folder it was asked for is gone (a restored workspace or a past
  // session whose folder was deleted), and Claude Code reads the project files of the folder it runs in. A window saved in
  // the home folder's .claude/settings.local.json is the user's own there, and the reader used to look only in the folder
  // asked for, so the variable was set over it.
  describe('when the folder the terminal was asked to open in is gone', () => {
    let home: string
    let gone: string
    beforeEach(() => {
      home = path.join(root, 'home')
      gone = path.join(root, 'deleted-workspace')
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    })
    const homeLocal = (): string => path.join(home, '.claude', 'settings.local.json')
    const homeShared = (): string => path.join(home, '.claude', 'settings.json')

    it('looks in the home folder instead, which is where the terminal opens', async () => {
      put(homeLocal(), { autoCompactWindow: 200000 })
      expect(await readClaudeWindowSettings(userDir, gone, home)).toEqual({ env: null, savedWindow: true })
      fs.rmSync(homeLocal())
      put(homeShared(), { env: { [VAR]: '250000' } })
      expect(await readClaudeWindowSettings(userDir, gone, home)).toEqual({ env: { [VAR]: '250000' }, savedWindow: false })
    })

    it('does not look there when the folder is there, with or without a .claude folder in it', async () => {
      put(homeLocal(), { autoCompactWindow: 200000 })
      expect(await readClaudeWindowSettings(userDir, project, home)).toEqual(NOTHING)
      const bare = path.join(root, 'bare')
      fs.mkdirSync(bare)
      expect(await readClaudeWindowSettings(userDir, bare, home)).toEqual(NOTHING)
    })

    it('keeps what the folder asked for would have said, and adds the home folder\'s to it', async () => {
      put(userFile(), { env: { [VAR]: '250000' } })
      put(homeLocal(), { autoCompactWindow: 200000 })
      expect(await readClaudeWindowSettings(userDir, gone, home)).toEqual({ env: { [VAR]: '250000' }, savedWindow: true })
    })

    it('stops the cap, where it would otherwise have been set over a window of the user\'s own', async () => {
      const decide = (dir: string): Promise<Record<string, string>> =>
        resolveShapingEnv({ contextCap: 300000 }, {}, () => readClaudeWindowSettings(userDir, dir, home))
      put(homeLocal(), { autoCompactWindow: 200000 })
      expect(await decide(gone)).toEqual({})
      expect(await decide(project)).toEqual({ [VAR]: '300000' })
    })

    it('leaves a path that is not absolute as it was: it names no folder to look for, so it sends nothing to the home folder', async () => {
      put(homeLocal(), { autoCompactWindow: 200000 })
      expect(await readClaudeWindowSettings(userDir, 'relative/gone', home)).toEqual(NOTHING)
      expect(await readClaudeWindowSettings(userDir, '', home)).toEqual(NOTHING)
      expect(await readClaudeWindowSettings(userDir, undefined, home)).toEqual(NOTHING)
    })

    it('reads nothing more when there is no home to look in', async () => {
      put(homeLocal(), { autoCompactWindow: 200000 })
      expect(await readClaudeWindowSettings(userDir, gone, '')).toEqual(NOTHING)
      expect(await readClaudeWindowSettings(userDir, gone, 'relative/home')).toEqual(NOTHING)
    })

    it('takes the home folder from the scratch home a test run is pointed at, never the developer\'s own, when none is handed in', async () => {
      const before = process.env.TERMPOLIS_TEST_AGENT_HOME
      process.env.TERMPOLIS_TEST_AGENT_HOME = home
      try {
        put(homeLocal(), { autoCompactWindow: 200000 })
        expect(await readClaudeWindowSettings(userDir, gone)).toEqual({ env: null, savedWindow: true })
        // Set and blank is no home at all, not the real one.
        process.env.TERMPOLIS_TEST_AGENT_HOME = '  '
        expect(await readClaudeWindowSettings(userDir, gone)).toEqual(NOTHING)
      } finally {
        if (before === undefined) delete process.env.TERMPOLIS_TEST_AGENT_HOME
        else process.env.TERMPOLIS_TEST_AGENT_HOME = before
      }
    })
  })

  // A file larger than SETTINGS_FILE_MAX_BYTES is one this does not decode, and Claude Code would: it can hold a window
  // of the user's own that nothing here can see. It used to read as a file that holds nothing, so the variable was set
  // over it; it reads as a window that cannot be seen, as a locked file does, and the variable is left unset.
  it('counts a settings file too large to read as holding a window it cannot see, and sets nothing over it', async () => {
    const big = JSON.stringify({ autoCompactWindow: 200000 }).padEnd(SETTINGS_FILE_MAX_BYTES + 1, ' ')
    expect(Buffer.byteLength(big)).toBe(SETTINGS_FILE_MAX_BYTES + 1)
    put(localFile(), big)
    expect(await readClaudeWindowSettings(userDir, project)).toEqual({ env: null, savedWindow: false, unreadable: true })
    expect(await resolveShapingEnv({ contextCap: 300000 }, {}, () => readClaudeWindowSettings(userDir, project))).toEqual({})
    // The same file at the limit is read, and the window in it is seen as the window it is.
    put(localFile(), JSON.stringify({ autoCompactWindow: 200000 }).padEnd(SETTINGS_FILE_MAX_BYTES, ' '))
    expect(await readClaudeWindowSettings(userDir, project)).toEqual({ env: null, savedWindow: true })
    expect(await resolveShapingEnv({ contextCap: 300000 }, {}, () => readClaudeWindowSettings(userDir, project))).toEqual({})
    // And with no window in a file that is over the limit, the variable still stays unset: it cannot be known to hold none.
    put(localFile(), '{}'.padEnd(SETTINGS_FILE_MAX_BYTES + 1, ' '))
    expect(await resolveShapingEnv({ contextCap: 300000 }, {}, () => readClaudeWindowSettings(userDir, project))).toEqual({})
    // Where a file of the same size at the limit holds none, it is set.
    put(localFile(), '{}'.padEnd(SETTINGS_FILE_MAX_BYTES, ' '))
    expect(await resolveShapingEnv({ contextCap: 300000 }, {}, () => readClaudeWindowSettings(userDir, project))).toEqual({ [VAR]: '300000' })
  })

  it('feeds the builder: a window in any of the files stops the cap, and an unrelated file does not', async () => {
    const settings = { contextCap: 300000 }
    const decide = async (): Promise<Record<string, string>> => {
      const seen = await readClaudeWindowSettings(userDir, project)
      return buildShapingEnv(settings, {}, () => seen.env, () => seen.savedWindow)
    }
    expect(await decide()).toEqual({ [VAR]: '300000' })
    put(userFile(), { env: { API_TIMEOUT_MS: '1200000' }, permissions: { allow: [] } })
    expect(await decide()).toEqual({ [VAR]: '300000' })
    put(projectFile(), { env: { [VAR.toLowerCase()]: '250000' } })
    expect(await decide()).toEqual({})
    fs.rmSync(projectFile())
    put(localFile(), { autoCompactWindow: 400000 })
    expect(await decide()).toEqual({})
  })
})

describe('the module', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'headroom', 'shapingEnvReader.ts'), 'utf8')

  it('reads through the asynchronous file calls only, so a launch never blocks the main process on a disk', () => {
    expect(src).not.toMatch(/\b(readFileSync|statSync|existsSync|openSync|readdirSync)\b/)
    expect(src).toMatch(/from 'fs\/promises'/)
  })

  it('writes nothing', () => {
    expect(src).not.toMatch(/\b(writeFile|appendFile|unlink|rename|mkdir|rm|copyFile|chmod|truncate)\b/)
  })

  it('knows the three files by name and no others', () => {
    expect([...src.matchAll(/'(settings(?:\.local)?\.json)'/g)].map((m) => m[1]).sort()).toEqual(['settings.json', 'settings.json', 'settings.local.json'])
  })
})
