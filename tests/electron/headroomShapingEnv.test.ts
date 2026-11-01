import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  CONTEXT_WINDOW_VAR, CONTEXT_CAP_MIN, CONTEXT_CAP_MAX, CONTEXT_CAP_CHOICES,
  isContextCap, isContextCapSetting, buildShapingEnv, pickWindowSettings, mergeWindowSettings,
  windowOwner, resolveShapingEnv, composeLaunchEnv, UNREADABLE,
  type ClaudeWindowSettings,
} from '../../src/main/headroom/shapingEnv'

/**
 * R3 of the 1.55.0 compression work: the one launch variable that makes Claude Code compact a long
 * conversation earlier, and the rules for when Termpolis may set it. Every line of
 * the research's R3 criteria 1 and 2 is a test here; the setting, the file reads and the two spawn sites
 * have their own suites.
 */

const VAR = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'

describe('the launch variable (R3 criterion 1)', () => {
  it('is Claude Code\'s own name for the window, set to a plain token count', () => {
    expect(CONTEXT_WINDOW_VAR).toBe(VAR)
    expect(buildShapingEnv({ contextCap: 300000 }, {})).toEqual({ [VAR]: '300000' })
  })

  it('writes every window Settings offers, and both ends of the documented range, as plain digits', () => {
    // A suffix such as 500k needs Claude Code 2.1.304; plain digits work on every version that has the variable.
    for (const cap of [500000, 400000, 300000, 200000, CONTEXT_CAP_MIN, CONTEXT_CAP_MAX, 250000, 123456]) {
      const out = buildShapingEnv({ contextCap: cap }, {})
      expect(out, String(cap)).toEqual({ [VAR]: String(cap) })
      expect(out[VAR], String(cap)).toMatch(/^[1-9]\d{5,6}$/)
    }
  })

  it('knows the documented range: 100,000 to 1,000,000 tokens', () => {
    expect(CONTEXT_CAP_MIN).toBe(100_000)
    expect(CONTEXT_CAP_MAX).toBe(1_000_000)
  })

  it('adds nothing when the cap is off, missing, not a number, out of range or not an integer', () => {
    const bad: unknown[] = [
      0, undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
      99_999, 1, -1, -0, -300_000, 1_000_001, 2_000_000, 1e21, 150_000.5, 300_000.0000001,
      '300000', '300k', '', true, false, {}, [], [300000], BigInt(300000), () => 300000,
    ]
    for (const cap of bad) expect(buildShapingEnv({ contextCap: cap }, {}), String(typeof cap === 'bigint' ? `${cap}n` : cap)).toEqual({})
  })

  it('adds nothing for settings that are missing altogether', () => {
    expect(buildShapingEnv(undefined, {})).toEqual({})
    expect(buildShapingEnv(null, {})).toEqual({})
    expect(buildShapingEnv({}, {})).toEqual({})
  })

  it('touches nothing it was given and hands back a fresh object every time', () => {
    const settings = Object.freeze({ contextCap: 300000 })
    const env = Object.freeze({ PATH: '/bin', HOME: '/home/x' })
    const a = buildShapingEnv(settings, env)
    const b = buildShapingEnv(settings, env)
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    expect(Object.keys(a)).toEqual([VAR])
  })
})

describe('which values are a cap, and which are a setting', () => {
  it('a cap is an integer inside the documented range', () => {
    expect(isContextCap(100_000)).toBe(true)
    expect(isContextCap(1_000_000)).toBe(true)
    expect(isContextCap(300_000)).toBe(true)
    for (const v of [0, 99_999, 1_000_001, 1.5, Number.NaN, '300000', null, undefined]) expect(isContextCap(v), String(v)).toBe(false)
  })

  it('a setting is a cap, or 0 for Off', () => {
    expect(isContextCapSetting(0)).toBe(true)
    expect(isContextCapSetting(300_000)).toBe(true)
    for (const v of [-1, 50_000, 1_000_001, 0.5, Number.NaN, '0', null, undefined, false]) expect(isContextCapSetting(v), String(v)).toBe(false)
  })

  it('every window Settings offers is a setting, Off first, then the largest window down', () => {
    expect(CONTEXT_CAP_CHOICES).toEqual([0, 500_000, 400_000, 300_000, 200_000])
    for (const c of CONTEXT_CAP_CHOICES) expect(isContextCapSetting(c), String(c)).toBe(true)
  })
})

describe('a value the user already set is never overridden (R3 criterion 2)', () => {
  it('leaves alone a value in the environment Termpolis passes on, whatever it holds', () => {
    for (const held of ['250000', '1000000', '200k', '0', 'abc', '', ' ']) {
      expect(buildShapingEnv({ contextCap: 300000 }, { [VAR]: held }), JSON.stringify(held)).toEqual({})
    }
  })

  it('reads the name in any case, because Windows does', () => {
    for (const name of ['claude_code_auto_compact_window', 'Claude_Code_Auto_Compact_Window', 'CLAUDE_code_AUTO_compact_WINDOW']) {
      expect(buildShapingEnv({ contextCap: 300000 }, { [name]: '250000' }), name).toEqual({})
    }
  })

  it('does not count a key that holds nothing', () => {
    expect(buildShapingEnv({ contextCap: 300000 }, { [VAR]: undefined })).toEqual({ [VAR]: '300000' })
  })

  it('does not mistake another variable for it', () => {
    // CLAUDE_AUTOCOMPACT_PCT_OVERRIDE only lowers the trigger inside whatever the window is; the two work together.
    const env = { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50', CLAUDE_CODE_AUTO_COMPACT_WINDOW_EXTRA: '1', X_CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1', CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' }
    expect(buildShapingEnv({ contextCap: 300000 }, env)).toEqual({ [VAR]: '300000' })
  })

  it('leaves alone a value in the env block of Claude Code\'s settings, whatever it holds', () => {
    for (const held of ['250000', 250000, '', 'auto', true, 0]) {
      expect(buildShapingEnv({ contextCap: 300000 }, {}, () => ({ [VAR]: held })), JSON.stringify(held)).toEqual({})
    }
  })

  it('reads the name in any case in the settings block too', () => {
    expect(buildShapingEnv({ contextCap: 300000 }, {}, () => ({ claude_code_auto_compact_window: '250000' }))).toEqual({})
  })

  it('sets it when the settings block has other variables, or this one as null', () => {
    expect(buildShapingEnv({ contextCap: 300000 }, {}, () => ({ API_TIMEOUT_MS: '1200000', BASH_DEFAULT_TIMEOUT_MS: '300000' }))).toEqual({ [VAR]: '300000' })
    expect(buildShapingEnv({ contextCap: 300000 }, {}, () => ({ [VAR]: null }))).toEqual({ [VAR]: '300000' })
    expect(buildShapingEnv({ contextCap: 300000 }, {}, () => ({}))).toEqual({ [VAR]: '300000' })
  })

  it('counts a settings file that cannot be read, or is not an object, as not set', () => {
    for (const read of [() => null, () => undefined, () => 'a string', () => 7, () => ['a'], () => { throw new Error('EACCES') }]) {
      expect(buildShapingEnv({ contextCap: 300000 }, {}, read as never)).toEqual({ [VAR]: '300000' })
    }
  })

  it('leaves alone a window the user saved with /autocompact or in an autoCompactWindow setting', () => {
    // Anthropic: the variable "takes precedence over the command, the flag, and the autoCompactWindow setting",
    // so setting it would silently override a window chosen on purpose.
    expect(buildShapingEnv({ contextCap: 300000 }, {}, () => null, () => true)).toEqual({})
    expect(buildShapingEnv({ contextCap: 300000 }, {}, () => null, () => false)).toEqual({ [VAR]: '300000' })
    expect(buildShapingEnv({ contextCap: 300000 }, {}, () => null, () => { throw new Error('x') })).toEqual({ [VAR]: '300000' })
  })

  it('asks the settings only when there is something to protect, and the saved window last', () => {
    const readEnv = vi.fn(() => null)
    const readSaved = vi.fn(() => false)
    // Off, invalid: nothing is read.
    buildShapingEnv({ contextCap: 0 }, {}, readEnv, readSaved)
    buildShapingEnv({ contextCap: 12 }, {}, readEnv, readSaved)
    // The environment already holds it: the settings are not consulted.
    buildShapingEnv({ contextCap: 300000 }, { [VAR]: '1' }, readEnv, readSaved)
    expect(readEnv).not.toHaveBeenCalled()
    expect(readSaved).not.toHaveBeenCalled()
    // The settings env block decides it: the saved window is not consulted.
    buildShapingEnv({ contextCap: 300000 }, {}, () => ({ [VAR]: '1' }), readSaved)
    expect(readSaved).not.toHaveBeenCalled()
    // Otherwise both are asked, once.
    buildShapingEnv({ contextCap: 300000 }, {}, readEnv, readSaved)
    expect(readEnv).toHaveBeenCalledTimes(1)
    expect(readSaved).toHaveBeenCalledTimes(1)
  })

  it('says whose value it is: the environment first, then the settings env block, then a saved window', () => {
    expect(windowOwner({ [VAR]: '1' }, () => ({ [VAR]: '2' }), () => true)).toBe('environment')
    expect(windowOwner({}, () => ({ [VAR]: '2' }), () => true)).toBe('settings-env')
    expect(windowOwner({}, () => null, () => true)).toBe('saved-window')
    expect(windowOwner({}, () => null, () => false)).toBeNull()
    expect(windowOwner({})).toBeNull()
  })
})

describe('what is kept of a Claude Code settings file', () => {
  it('keeps the env block and whether a window is saved, and nothing else', () => {
    const parsed = {
      env: { A: '1' },
      permissions: { allow: ['Bash(ls)'] },
      hooks: { SessionStart: [{ command: 'x' }] },
      apiKeyHelper: 'a-helper',
      model: 'opus',
      autoCompactWindow: 200000,
    }
    const kept = pickWindowSettings(parsed)
    expect(Object.keys(kept).sort()).toEqual(['env', 'savedWindow'])
    // The env block can hold keys of the user's own: only the window variable's entry is kept.
    expect(kept).toEqual({ env: {}, savedWindow: true })
    expect(pickWindowSettings({ env: { A: '1', [VAR]: '250000', [VAR.toLowerCase()]: '1', B: '2' } }).env).toEqual({ [VAR]: '250000', [VAR.toLowerCase()]: '1' })
    expect(pickWindowSettings({ env: { [VAR]: null } }).env).toEqual({ [VAR]: null }) // kept as it is: a later null still replaces an earlier value
  })

  it('sees a window saved at the top level, in any form but nothing', () => {
    for (const held of [200000, '200k', 'auto', 0, false, '']) expect(pickWindowSettings({ autoCompactWindow: held }).savedWindow, JSON.stringify(held)).toBe(true)
    for (const held of [null, undefined]) expect(pickWindowSettings({ autoCompactWindow: held }).savedWindow, String(held)).toBe(false)
    expect(pickWindowSettings({}).savedWindow).toBe(false)
  })

  it('sees a window saved for one model by /autocompact', () => {
    expect(pickWindowSettings({ modelSettings: { 'claude-opus-5-5': { effortLevel: 'high', autoCompactWindow: 500000 } } }).savedWindow).toBe(true)
    expect(pickWindowSettings({ modelSettings: { a: { effortLevel: 'high' }, b: { autoCompactWindow: 'auto' } } }).savedWindow).toBe(true)
  })

  it('does not see a window where there is none', () => {
    expect(pickWindowSettings({ modelSettings: { a: { effortLevel: 'high' } } }).savedWindow).toBe(false)
    expect(pickWindowSettings({ modelSettings: { a: { autoCompactWindow: null } } }).savedWindow).toBe(false)
    expect(pickWindowSettings({ modelSettings: { a: 'high', b: null, c: 7, d: ['x'] } }).savedWindow).toBe(false)
    expect(pickWindowSettings({ modelSettings: 'x' }).savedWindow).toBe(false)
    expect(pickWindowSettings({ modelSettings: ['x'] }).savedWindow).toBe(false)
    expect(pickWindowSettings({ modelSettings: {} }).savedWindow).toBe(false)
  })

  it('reads an env that is not an object as no env', () => {
    for (const env of ['x', 7, null, ['a'], true]) expect(pickWindowSettings({ env }).env, JSON.stringify(env)).toBeNull()
    expect(pickWindowSettings({}).env).toBeNull()
  })

  it('reads a file that is not an object as holding nothing', () => {
    for (const parsed of [null, undefined, 'x', 7, ['env'], true]) {
      expect(pickWindowSettings(parsed), JSON.stringify(parsed)).toEqual({ env: null, savedWindow: false })
    }
  })

  it('puts the files together the way Claude Code reads them: later over earlier, a saved window from any', () => {
    const a: ClaudeWindowSettings = { env: { X: '1', Y: 'a' }, savedWindow: false }
    const b: ClaudeWindowSettings = { env: { Y: 'b' }, savedWindow: true }
    const c: ClaudeWindowSettings = { env: null, savedWindow: false }
    expect(mergeWindowSettings([a, b, c])).toEqual({ env: { X: '1', Y: 'b' }, savedWindow: true })
    expect(mergeWindowSettings([c, c])).toEqual({ env: null, savedWindow: false })
    expect(mergeWindowSettings([])).toEqual({ env: null, savedWindow: false })
    expect(a.env).toEqual({ X: '1', Y: 'a' }) // not mutated
  })
})

describe('resolving it for a launch', () => {
  afterEach(() => { vi.useRealTimers() })

  const read = (value: ClaudeWindowSettings | null | undefined) => vi.fn(async () => value)

  it('does no reading at all for anyone who has not turned it on', async () => {
    const r = read({ env: null, savedWindow: false })
    expect(await resolveShapingEnv({ contextCap: 0 }, {}, r)).toEqual({})
    expect(await resolveShapingEnv({ contextCap: 7 }, {}, r)).toEqual({})
    expect(await resolveShapingEnv(undefined, {}, r)).toEqual({})
    expect(r).not.toHaveBeenCalled()
  })

  it('does no reading when the environment already holds a value', async () => {
    const r = read({ env: null, savedWindow: false })
    expect(await resolveShapingEnv({ contextCap: 300000 }, { [VAR]: '1' }, r)).toEqual({})
    expect(r).not.toHaveBeenCalled()
  })

  it('sets it when the settings hold nothing', async () => {
    const r = read({ env: { OTHER: '1' }, savedWindow: false })
    expect(await resolveShapingEnv({ contextCap: 300000 }, {}, r)).toEqual({ [VAR]: '300000' })
    expect(r).toHaveBeenCalledTimes(1)
  })

  it('sets it when there is nothing to read with', async () => {
    expect(await resolveShapingEnv({ contextCap: 300000 }, {})).toEqual({ [VAR]: '300000' })
  })

  it('leaves it alone when the settings env block holds a value, or a window is saved', async () => {
    expect(await resolveShapingEnv({ contextCap: 300000 }, {}, read({ env: { [VAR]: '250000' }, savedWindow: false }))).toEqual({})
    expect(await resolveShapingEnv({ contextCap: 300000 }, {}, read({ env: null, savedWindow: true }))).toEqual({})
  })

  it('counts settings that were read and held nothing as not set: nothing at all, or null', async () => {
    expect(await resolveShapingEnv({ contextCap: 300000 }, {}, read(null))).toEqual({ [VAR]: '300000' })
    expect(await resolveShapingEnv({ contextCap: 300000 }, {}, read(undefined))).toEqual({ [VAR]: '300000' })
  })

  it('counts a read that was not made as a window it cannot see, and leaves the variable unset: a rejection, a throw, a file marked unreadable', async () => {
    expect(await resolveShapingEnv({ contextCap: 300000 }, {}, async () => { throw new Error('EACCES') })).toEqual({})
    expect(await resolveShapingEnv({ contextCap: 300000 }, {}, (() => { throw new Error('sync') }) as never)).toEqual({})
    expect(await resolveShapingEnv({ contextCap: 300000 }, {}, read({ env: null, savedWindow: false, unreadable: true }))).toEqual({})
    // and an unreadable flag that is anything but true is not one
    expect(await resolveShapingEnv({ contextCap: 300000 }, {}, read({ env: null, savedWindow: false, unreadable: false } as never))).toEqual({ [VAR]: '300000' })
  })

  it('puts the unreadable flag through a merge of files: one unreadable file among readable ones', () => {
    const merged = mergeWindowSettings([{ env: null, savedWindow: false }, UNREADABLE, { env: { [VAR]: '1' }, savedWindow: false }])
    expect(merged).toEqual({ env: { [VAR]: '1' }, savedWindow: false, unreadable: true })
    expect(mergeWindowSettings([{ env: null, savedWindow: false }])).toEqual({ env: null, savedWindow: false }) // no flag key when nothing was unreadable
    expect(Object.isFrozen(UNREADABLE)).toBe(true)
  })

  it('does not wait forever for a read that hangs, and leaves no timer behind', async () => {
    vi.useFakeTimers()
    const hung = vi.fn(() => new Promise<ClaudeWindowSettings>(() => { /* never settles */ }))
    const pending = resolveShapingEnv({ contextCap: 300000 }, {}, hung)
    let settled = false
    void pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    // A read that never answered says nothing about the files: the variable is left unset, not set over a window that may be there.
    expect(await pending).toEqual({})
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears its timer when the read finishes first', async () => {
    vi.useFakeTimers()
    const out = await resolveShapingEnv({ contextCap: 300000 }, {}, read({ env: null, savedWindow: false }))
    expect(out).toEqual({ [VAR]: '300000' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('takes its own deadline when given one', async () => {
    vi.useFakeTimers()
    const hung = () => new Promise<ClaudeWindowSettings>(() => { /* never */ })
    const pending = resolveShapingEnv({ contextCap: 300000 }, {}, hung, 50)
    await vi.advanceTimersByTimeAsync(50)
    expect(await pending).toEqual({})
  })
})

describe('composing the env a Claude launch gets (R3 criterion 3: independent of the proxy)', () => {
  const PROXY = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:41999', TERMPOLIS_HEADROOM_PROXY: 'http://127.0.0.1:41999' }
  const SHAPING = { [VAR]: '300000' }

  it('hands over both, when both exist', () => {
    expect(composeLaunchEnv(PROXY, SHAPING)).toEqual({ ...PROXY, ...SHAPING })
  })

  it('keeps the window when the proxy is down: no proxy env is no reason to drop it', () => {
    expect(composeLaunchEnv(null, SHAPING)).toEqual(SHAPING)
    expect(composeLaunchEnv(undefined, SHAPING)).toEqual(SHAPING)
  })

  it('hands over the proxy env exactly as it was when there is no window', () => {
    expect(composeLaunchEnv(PROXY, {})).toEqual(PROXY)
  })

  it('hands over nothing, not an empty object, when there is neither', () => {
    // An empty object would reach the PTY as an env; "nothing" is what every launch without either gets today.
    expect(composeLaunchEnv(null, {})).toBeUndefined()
    expect(composeLaunchEnv(undefined, {})).toBeUndefined()
  })

  it('does not change what it was given', () => {
    const proxy = Object.freeze({ ...PROXY })
    const shaping = Object.freeze({ ...SHAPING })
    expect(() => composeLaunchEnv(proxy, shaping)).not.toThrow()
    expect(proxy).toEqual(PROXY)
  })
})

describe('the module itself', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'headroom', 'shapingEnv.ts'), 'utf8')

  it('is pure: it imports nothing from the file system, Electron or a process', () => {
    const imports = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(imports.filter((i) => /^(node:)?(fs|fs\/promises|child_process|electron|net|http|https|os|path)$/.test(i))).toEqual([])
  })

  it('names the variable once, as Anthropic documents it', () => {
    expect(src.match(/CLAUDE_CODE_AUTO_COMPACT_WINDOW/g)?.length ?? 0).toBeGreaterThan(0)
    expect(src).not.toMatch(/CLAUDE_CODE_AUTO_COMPACT_WINDOW\s*=\s*['"`]\s*\d+\s*[kKmM]/)
  })
})
