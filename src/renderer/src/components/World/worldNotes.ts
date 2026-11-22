// Lumopolis pane notes that follow from the world itself, about the files it maps. A listing that stopped at its cap
// (a folder walk, main/world/folderWalk.ts, or nested repositories, main/repoFileList.ts) leaves the doc carrying
// filesCapped, the files the world maps; names that are not valid UTF-8 leave it carrying filesUnreadable, the source
// files skipped for it. The pane says both, in one note.

const CAPPED_START = 'Showing the first '
const UNREADABLE = /^[\d,]+ files? (?:was|were) skipped because (?:its|their) names? can't be read\./

const count = (n: number): string => n.toLocaleString('en-US')

/** The note for a world whose listing stopped at its cap: how many files it shows. */
export function cappedNotice(files: number): string {
  return `${CAPPED_START}${count(files)} files in this folder.`
}

/** The note for files skipped because their names can't be read. */
export function unreadableNotice(files: number): string {
  return files === 1 ? "1 file was skipped because its name can't be read." : `${count(files)} files were skipped because their names can't be read.`
}

/** The world's files note, or null when it has nothing to say. */
export function filesNotice(doc: { filesCapped?: number; filesUnreadable?: number } | null): string | null {
  const parts: string[] = []
  if (doc && doc.filesCapped !== undefined && doc.filesCapped > 0) parts.push(cappedNotice(doc.filesCapped))
  if (doc && doc.filesUnreadable !== undefined && doc.filesUnreadable > 0) parts.push(unreadableNotice(doc.filesUnreadable))
  return parts.length > 0 ? parts.join(' ') : null
}

/** Whether a notice is a files note (this world's or an earlier one's), not anything else the pane said. */
export function isFilesNotice(text: string): boolean {
  return text.startsWith(CAPPED_START) || UNREADABLE.test(text)
}

/**
 * The notice slot while nothing else holds it: the world's files note fills it when it is empty or holds a files note;
 * any other notice stays; a files note the world no longer has goes.
 */
export function nextFilesNotice(note: string | null, current: string | null): string | null {
  if (current !== null && !isFilesNotice(current)) return current
  return note
}
