import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

vi.mock('fs')

const { readConfigFile, writeConfigFile } = await import('../../src/main/configFileManager')

describe('readConfigFile', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns file contents when file exists', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue('export PATH=$PATH:/usr/local/bin' as any)
    expect(readConfigFile('/home/user/.bashrc')).toBe('export PATH=$PATH:/usr/local/bin')
  })

  it('returns empty string when file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    expect(readConfigFile('/home/user/.bashrc')).toBe('')
  })
})

describe('writeConfigFile', () => {
  it('writes content to path', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    writeConfigFile('/home/user/.bashrc', 'export EDITOR=vim')
    expect(writeFileSync).toHaveBeenCalledWith('/home/user/.bashrc', 'export EDITOR=vim', 'utf-8')
  })

  it('creates parent directories if missing', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    writeConfigFile('/home/user/.bashrc', '')
    expect(mkdirSync).toHaveBeenCalled()
  })
})
