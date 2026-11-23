import { describe, expect, it } from 'vitest'
import { cappedNotice, filesNotice, isFilesNotice, nestedCappedNotice, nextFilesNotice, provisionalNotice, readCappedNotice, unreadableNotice } from '../../../src/renderer/src/components/World/worldNotes'

describe('worldNotes: what the pane says about the files a world maps', () => {
  it('WP4a: a listing read in part says every file is shown and how many were read; a first map says it is still reading', () => {
    expect(readCappedNotice(50000, 20000)).toBe('All 50,000 files are shown, but only 20,000 were read for the lines between them.')
    expect(provisionalNotice()).toBe('Still reading the files: lines and details fill in when they are done.')
    expect(filesNotice({ filesRead: 20000, filesListed: 50000 })).toBe(readCappedNotice(50000, 20000))
    // Every file read (or a count that does not say fewer were read): nothing to say.
    expect(filesNotice({ filesRead: 20000, filesListed: 20000 })).toBeNull()
    expect(filesNotice({ filesRead: 20000 })).toBeNull()
    expect(filesNotice({ filesListed: 50000 })).toBeNull()
    expect(filesNotice({ provisional: true })).toBe(provisionalNotice())
    expect(filesNotice({ provisional: false } as never)).toBeNull()
    expect(filesNotice({ provisional: true, filesUnreadable: 1, filesRead: 2, filesListed: 3 })).toBe(
      `${provisionalNotice()} ${unreadableNotice(1)} ${readCappedNotice(3, 2)}`
    )
    expect(isFilesNotice(readCappedNotice(50000, 20000))).toBe(true)
    expect(isFilesNotice(provisionalNotice())).toBe(true)
    expect(isFilesNotice(`${provisionalNotice()} ${readCappedNotice(3, 2)}`)).toBe(true)
    // The full world's note replaces the first map's, and a full world with nothing to say clears it.
    expect(nextFilesNotice(readCappedNotice(3, 2), provisionalNotice())).toBe(readCappedNotice(3, 2))
    expect(nextFilesNotice(null, provisionalNotice())).toBeNull()
  })

  it('the capped note says how many files the world shows, with a thousands separator', () => {
    expect(cappedNotice(20000)).toBe('Showing the first 20,000 files in this folder.')
    expect(cappedNotice(7)).toBe('Showing the first 7 files in this folder.')
  })

  it('the nested note says the repositories inside the folder were cut, not the folder itself', () => {
    expect(nestedCappedNotice(20000)).toBe("The repositories inside this folder hold more than 20,000 files, so some of their files aren't shown.")
  })

  it('the unreadable note counts the files skipped for a name that cannot be read, singular and plural', () => {
    expect(unreadableNotice(1)).toBe("1 file was skipped because its name can't be read.")
    expect(unreadableNotice(3)).toBe("3 files were skipped because their names can't be read.")
    expect(unreadableNotice(1200)).toBe("1,200 files were skipped because their names can't be read.")
  })

  it('a world carries both, either or neither', () => {
    expect(filesNotice(null)).toBeNull()
    expect(filesNotice({})).toBeNull()
    expect(filesNotice({ filesCapped: 0, filesUnreadable: 0 })).toBeNull()
    expect(filesNotice({ filesCapped: 20000 })).toBe('Showing the first 20,000 files in this folder.')
    expect(filesNotice({ filesUnreadable: 2 })).toBe("2 files were skipped because their names can't be read.")
    expect(filesNotice({ filesCapped: 5, filesUnreadable: 1 })).toBe("Showing the first 5 files in this folder. 1 file was skipped because its name can't be read.")
    expect(filesNotice({ nestedCapped: 0 })).toBeNull()
    expect(filesNotice({ nestedCapped: 20000 })).toBe(nestedCappedNotice(20000))
    expect(filesNotice({ nestedCapped: 20000, filesUnreadable: 1 })).toBe(`${nestedCappedNotice(20000)} ${unreadableNotice(1)}`)
  })

  it('tells its own notes from every other notice', () => {
    expect(isFilesNotice(cappedNotice(3))).toBe(true)
    expect(isFilesNotice(unreadableNotice(1))).toBe(true)
    expect(isFilesNotice(unreadableNotice(4))).toBe(true)
    expect(isFilesNotice(nestedCappedNotice(20000))).toBe(true)
    expect(isFilesNotice(`${nestedCappedNotice(20000)} ${unreadableNotice(2)}`)).toBe(true)
    expect(isFilesNotice('The repositories inside this folder are fine.')).toBe(false)
    expect(isFilesNotice('Re-layout failed: x')).toBe(false)
    expect(isFilesNotice('Open a world to export it.')).toBe(false)
  })

  it('fills an empty slot or replaces its own old note; leaves any other notice; a stale note goes', () => {
    const note = cappedNotice(20000)
    expect(nextFilesNotice(note, null)).toBe(note)
    expect(nextFilesNotice(note, cappedNotice(5))).toBe(note)
    expect(nextFilesNotice(note, 'Re-layout failed: x')).toBe('Re-layout failed: x')
    expect(nextFilesNotice(null, cappedNotice(5))).toBeNull()
    expect(nextFilesNotice(null, unreadableNotice(2))).toBeNull()
    expect(nextFilesNotice(null, 'Re-layout failed: x')).toBe('Re-layout failed: x')
    expect(nextFilesNotice(null, null)).toBeNull()
  })
})
