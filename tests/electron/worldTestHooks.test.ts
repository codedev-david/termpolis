// The Lumopolis e2e hooks: a file whose text is the folder the folder picker answers, and one whose text is the path
// the export's save dialog answers. Like every other TERMPOLIS_TEST_* hook they do nothing outside a test run
// (NODE_ENV=test), whatever the env var says.
import { describe, expect, it, vi } from 'vitest'
import { testPickedFolder, testSavePath } from '../../src/main/world/testHooks'

describe('testPickedFolder', () => {
  it('in a test run, answers the trimmed text of the pick file; empty text is a cancel (null)', async () => {
    const read = vi.fn(async () => '  C:/fixture/project \n')
    expect(await testPickedFolder({ NODE_ENV: 'test', TERMPOLIS_TEST_WORLD_PICK_FILE: 'C:/ud/pick.txt' }, read)).toBe('C:/fixture/project')
    expect(read).toHaveBeenCalledWith('C:/ud/pick.txt')
    expect(await testPickedFolder({ NODE_ENV: 'test', TERMPOLIS_TEST_WORLD_PICK_FILE: 'p' }, async () => ' \n')).toBeNull()
  })

  it('outside a test run the env var is inert: undefined (use the real dialog) and the file is never read', async () => {
    const read = vi.fn(async () => 'C:/anything')
    for (const NODE_ENV of [undefined, 'production', 'development', '']) {
      expect(await testPickedFolder({ NODE_ENV, TERMPOLIS_TEST_WORLD_PICK_FILE: 'C:/ud/pick.txt' }, read)).toBeUndefined()
    }
    expect(await testPickedFolder({ NODE_ENV: 'test' }, read)).toBeUndefined()
    expect(await testPickedFolder({ NODE_ENV: 'test', TERMPOLIS_TEST_WORLD_PICK_FILE: '' }, read)).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })
})

describe('testSavePath', () => {
  it('in a test run, answers the trimmed text of the save file; empty text is a cancel (null)', async () => {
    const read = vi.fn(async () => '  C:/out/Shop - Lumopolis.html \n')
    expect(await testSavePath({ NODE_ENV: 'test', TERMPOLIS_TEST_WORLD_SAVE_FILE: 'C:/ud/save.txt' }, read)).toBe('C:/out/Shop - Lumopolis.html')
    expect(read).toHaveBeenCalledWith('C:/ud/save.txt')
    expect(await testSavePath({ NODE_ENV: 'test', TERMPOLIS_TEST_WORLD_SAVE_FILE: 's' }, async () => ' \n')).toBeNull()
  })

  it('outside a test run the env var is inert: undefined (use the real dialog) and the file is never read', async () => {
    const read = vi.fn(async () => 'C:/anything.html')
    for (const NODE_ENV of [undefined, 'production', 'development', '']) {
      expect(await testSavePath({ NODE_ENV, TERMPOLIS_TEST_WORLD_SAVE_FILE: 'C:/ud/save.txt' }, read)).toBeUndefined()
    }
    expect(await testSavePath({ NODE_ENV: 'test' }, read)).toBeUndefined()
    expect(await testSavePath({ NODE_ENV: 'test', TERMPOLIS_TEST_WORLD_SAVE_FILE: '' }, read)).toBeUndefined()
    // the folder picker's file never answers the save dialog
    expect(await testSavePath({ NODE_ENV: 'test', TERMPOLIS_TEST_WORLD_PICK_FILE: 'C:/ud/pick.txt' }, read)).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })
})
