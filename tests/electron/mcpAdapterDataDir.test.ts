// The shared data-dir helper every standalone adapter now uses (dataDir.cjs). Its whole reason to
// exist is that four hand-rolled copies drifted — one used capital-T "Termpolis" (broken on
// case-sensitive Linux), three ignored $XDG_CONFIG_HOME (agents got zero MCP tools on Linux). This
// pins the ONE correct answer per platform so they can never drift again.
import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'module'
import { join } from 'path'

const require = createRequire(import.meta.url)
const dataDir = require(join(process.cwd(), 'src', 'mcp-adapter', 'dataDir.cjs')) as {
  termpolisDataDir: () => string
  dataFile: (name: string) => string
}

const origPlatform = process.platform
const origAppData = process.env.APPDATA
const origXdg = process.env.XDG_CONFIG_HOME
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p })
const norm = (s: string) => s.replace(/\\/g, '/')

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: origPlatform })
  if (origAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = origAppData
  if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg
})

describe('termpolisDataDir — matches app.getPath(userData), lowercase, XDG-aware', () => {
  it('win32 → %APPDATA%\\termpolis (lowercase)', () => {
    setPlatform('win32')
    process.env.APPDATA = 'C:\\Users\\x\\AppData\\Roaming'
    expect(norm(dataDir.termpolisDataDir())).toBe('C:/Users/x/AppData/Roaming/termpolis')
  })

  it('darwin → ~/Library/Application Support/termpolis (lowercase)', () => {
    setPlatform('darwin')
    expect(norm(dataDir.termpolisDataDir())).toContain('Library/Application Support/termpolis')
  })

  it('linux honours $XDG_CONFIG_HOME when set — the bug that gave agents zero tools', () => {
    setPlatform('linux')
    process.env.XDG_CONFIG_HOME = '/custom/cfg'
    expect(norm(dataDir.termpolisDataDir())).toBe('/custom/cfg/termpolis')
  })

  it('linux falls back to ~/.config/termpolis when XDG_CONFIG_HOME is unset', () => {
    setPlatform('linux')
    delete process.env.XDG_CONFIG_HOME
    expect(norm(dataDir.termpolisDataDir())).toContain('.config/termpolis')
  })

  it('never emits a capital-T "Termpolis" segment on any platform', () => {
    for (const p of ['win32', 'darwin', 'linux']) {
      setPlatform(p)
      expect(dataDir.termpolisDataDir()).not.toContain('Termpolis')
    }
  })

  it('dataFile joins a filename onto the data dir', () => {
    setPlatform('linux')
    process.env.XDG_CONFIG_HOME = '/cfg'
    expect(norm(dataDir.dataFile('mcp-token'))).toBe('/cfg/termpolis/mcp-token')
  })
})
