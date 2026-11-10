// v1.58.0: whether a Codex home's config.toml already chooses where Codex talks to.
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { configSetsRouting, codexHomeRoutes } from '../../src/main/codexLaunch'

describe('configSetsRouting', () => {
  it('finds a top-level endpoint, provider or profile', () => {
    expect(configSetsRouting('model = "gpt-5.5"\nopenai_base_url = "http://x"')).toBe(true)
    expect(configSetsRouting('model_provider = "azure"')).toBe(true)
    expect(configSetsRouting('  profile="work"')).toBe(true)
    expect(configSetsRouting('"chatgpt_base_url" = "https://y"')).toBe(true)
    expect(configSetsRouting("'model_provider'='x'\r\n")).toBe(true)
  })

  it('ignores the same keys under a table, comments and look-alikes', () => {
    expect(configSetsRouting('model = "gpt-5.5"\n[profiles.work]\nmodel_provider = "azure"\n[model_providers.azure]\nbase_url = "x"')).toBe(false)
    expect(configSetsRouting('# model_provider = "azure"\nmodel_reasoning_effort = "high"\nprofiles_dir = "x"')).toBe(false)
    expect(configSetsRouting('')).toBe(false)
  })
})

describe('codexHomeRoutes', () => {
  it('reads config.toml under the home', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexhome-'))
    try {
      expect(await codexHomeRoutes(dir)).toBe(false) // no config: Codex's defaults
      fs.writeFileSync(path.join(dir, 'config.toml'), 'model_provider = "ollama"\n')
      expect(await codexHomeRoutes(dir)).toBe(true)
      fs.writeFileSync(path.join(dir, 'config.toml'), 'model = "gpt-5.5"\n')
      expect(await codexHomeRoutes(dir)).toBe(false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('an unreadable config counts as routing, a missing one does not', async () => {
    expect(await codexHomeRoutes('/h', async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })).toBe(true)
    expect(await codexHomeRoutes('/h', async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) })).toBe(false)
    expect(await codexHomeRoutes('/h', async () => { throw null })).toBe(true)
    expect(await codexHomeRoutes('/h', async (p) => (p.endsWith('config.toml') ? 'profile = "x"' : ''))).toBe(true)
  })
})
