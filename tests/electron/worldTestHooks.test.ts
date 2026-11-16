// The Lumopolis folder picker's e2e hook: a file whose text is the folder to answer. Like every other
// TERMPOLIS_TEST_* hook it does nothing outside a test run (NODE_ENV=test), whatever the env var says.
import { describe, expect, it, vi } from 'vitest'
import { testPickedFolder } from '../../src/main/world/testHooks'

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
