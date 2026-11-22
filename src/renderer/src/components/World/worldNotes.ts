// Lumopolis pane notes that follow from the world itself, about the files it maps. A folder walk that stopped at its
// cap (main/world/folderWalk.ts) leaves the doc carrying filesCapped, the files the world maps; nested repositories cut
// at the cap they share (main/repoFileList.ts) leave it carrying nestedCapped, that cap; names that are not valid
// UTF-8 leave it carrying filesUnreadable, the source files skipped for it. The pane says them all, in one note.

const CAPPED_START = 'Showing the first '
const NESTED_START = 'The repositories inside this folder hold more than '
const UNREADABLE = /^[\d,]+ files? (?:was|were) skipped because (?:its|their) names? can't be read\./

const count = (n: number): string => n.toLocaleString('en-US')

/** The note for a world whose listing stopped at its cap: how many files it shows. */
export function cappedNotice(files: number): string {
  return `${CAPPED_START}${count(files)} files in this folder.`
}

/** The note for a world whose nested repositories were cut at the cap they share (the folder's own files never are). */
export function nestedCappedNotice(cap: number): string {
  return `${NESTED_START}${count(cap)} files, so some of their files aren't shown.`
}

/** The note for files skipped because their names can't be read. */
export function unreadableNotice(files: number): string {
  return files === 1 ? "1 file was skipped because its name can't be read." : `${count(files)} files were skipped because their names can't be read.`
}

/** The world's files note, or null when it has nothing to say. */
export function filesNotice(doc: { filesCapped?: number; nestedCapped?: number; filesUnreadable?: number } | null): string | null {
  const parts: string[] = []
  if (doc && doc.filesCapped !== undefined && doc.filesCapped > 0) parts.push(cappedNotice(doc.filesCapped))
  if (doc && doc.nestedCapped !== undefined && doc.nestedCapped > 0) parts.push(nestedCappedNotice(doc.nestedCapped))
  if (doc && doc.filesUnreadable !== undefined && doc.filesUnreadable > 0) parts.push(unreadableNotice(doc.filesUnreadable))
  return parts.length > 0 ? parts.join(' ') : null
}

/** Whether a notice is a files note (this world's or an earlier one's), not anything else the pane said. */
export function isFilesNotice(text: string): boolean {
  return text.startsWith(CAPPED_START) || text.startsWith(NESTED_START) || UNREADABLE.test(text)
}

/**
 * The notice slot while nothing else holds it: the world's files note fills it when it is empty or holds a files note;
 * any other notice stays; a files note the world no longer has goes.
 */
export function nextFilesNotice(note: string | null, current: string | null): string | null {
  if (current !== null && !isFilesNotice(current)) return current
  return note
}
