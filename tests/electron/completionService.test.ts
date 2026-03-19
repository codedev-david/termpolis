import { describe, it, expect, vi } from 'vitest'
import { readdirSync, statSync } from 'fs'

vi.mock('fs')
vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

const { listPathEntries, listPathCommands, listEnvVars } = await import('../../src/main/completionService')

describe('completionService', () => {
  it('listPathEntries returns files and dirs with isDir flag', () => {
    vi.mocked(readdirSync).mockReturnValue(['file.txt', 'subdir'] as any)
    vi.mocked(statSync).mockImplementation((p: any) => ({
      isDirectory: () => String(p).includes('subdir'),
    } as any))
    const result = listPathEntries('/some/path')
    expect(result).toContainEqual({ name: 'file.txt', isDir: false })
    expect(result).toContainEqual({ name: 'subdir', isDir: true })
  })

  it('listPathEntries returns empty array for non-existent dir', () => {
    vi.mocked(readdirSync).mockImplementation(() => { throw new Error('ENOENT') })
    expect(listPathEntries('/bad/path')).toEqual([])
  })

  it('listEnvVars returns process.env as record', () => {
    const result = listEnvVars()
    expect(typeof result).toBe('object')
    expect(result.PATH ?? result.Path).toBeTruthy()
  })
})
