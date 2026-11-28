// Lumopolis pane notes that follow from the world itself, about the files it maps. A folder walk that stopped at its
// cap (main/world/folderWalk.ts) leaves the doc carrying filesCapped, the files the world maps; nested repositories cut
// at the cap they share (main/repoFileList.ts) leave it carrying nestedCapped, that cap; names that are not valid
// UTF-8 leave it carrying filesUnreadable, the source files skipped for it; a listing of more files than a map reads
// (main/world/readCap.ts) leaves it carrying filesRead and filesListed; a first map drawn from the listing while the
// files are still being read is provisional; a stored world written by a newer Termpolis, opened read-only, is
// savedByNewer. The pane says them all, in one note; a first map says only that. How many top-level dot-folders the
// world leaves out as tooling (toolingFolders, look spec §9.1) is said only beside a note that files are left out or
// cut: that is the world's rule, not a cut of its own.

const CAPPED_START = 'Showing the first '
const NESTED_START = 'The repositories inside this folder hold more than '
const UNREADABLE = /^[\d,]+ files? (?:was|were) skipped because (?:its|their) names? can't be read\./
const READ_CAPPED = /^All [\d,]+ files are shown, but only [\d,]+ were read for the lines between them\./
const PROVISIONAL = 'Still reading the files: '
// PENDING SIGN-OFF by David (WP3 report): the line he proposed for a world a newer Termpolis saved. main's
// WORLD_SAVED_BY_NEWER (world/worldStore.ts) says the same when an annotate over such a world is refused.
const SAVED_BY_NEWER = 'This world was saved by a newer Termpolis, so this version shows a copy and leaves the saved one as it is. Update Termpolis to save changes to it.'

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

/** The note for a world that read only some of its files: how many it shows, and how many were read. */
export function readCappedNotice(listed: number, read: number): string {
  return `All ${count(listed)} files are shown, but only ${count(read)} were read for the lines between them.`
}

/** The line for the top-level dot-folders the world leaves out as tooling, said after another files note. */
export function toolingNotice(folders: number): string {
  return folders === 1 ? '1 top-level dot-folder is left out as tooling.' : `${count(folders)} top-level dot-folders are left out as tooling.`
}

/** The note for a stored world written by a newer Termpolis, which this version opens read-only. */
export function savedByNewerNotice(): string {
  return SAVED_BY_NEWER
}

/** The note for a first map drawn from the file listing while the files are still being read. */
export function provisionalNotice(): string {
  return `${PROVISIONAL}lines and details fill in when they are done.`
}

interface FilesNoteDoc {
  filesCapped?: number
  nestedCapped?: number
  filesUnreadable?: number
  filesRead?: number
  filesListed?: number
  toolingFolders?: number
  provisional?: boolean
  savedByNewer?: boolean
}

/** The world's files note, or null when it has nothing to say. */
export function filesNotice(doc: FilesNoteDoc | null): string | null {
  // A first map says only that it is still reading: how many files were read is known once the complete world is.
  if (doc && doc.provisional === true) return provisionalNotice()
  const parts: string[] = []
  if (doc && doc.savedByNewer === true) parts.push(savedByNewerNotice())
  const before = parts.length
  if (doc && doc.filesCapped !== undefined && doc.filesCapped > 0) parts.push(cappedNotice(doc.filesCapped))
  if (doc && doc.nestedCapped !== undefined && doc.nestedCapped > 0) parts.push(nestedCappedNotice(doc.nestedCapped))
  if (doc && doc.filesUnreadable !== undefined && doc.filesUnreadable > 0) parts.push(unreadableNotice(doc.filesUnreadable))
  if (doc && doc.filesRead !== undefined && doc.filesListed !== undefined && doc.filesListed > doc.filesRead) parts.push(readCappedNotice(doc.filesListed, doc.filesRead))
  if (doc && parts.length > before && doc.toolingFolders !== undefined && doc.toolingFolders > 0) parts.push(toolingNotice(doc.toolingFolders))
  return parts.length > 0 ? parts.join(' ') : null
}

/** Whether a notice is a files note (this world's or an earlier one's), not anything else the pane said. */
export function isFilesNotice(text: string): boolean {
  return text.startsWith(SAVED_BY_NEWER) || text.startsWith(PROVISIONAL) || text.startsWith(CAPPED_START) || text.startsWith(NESTED_START) || UNREADABLE.test(text) || READ_CAPPED.test(text)
}

/**
 * The notice slot while nothing else holds it: the world's files note fills it when it is empty or holds a files note;
 * any other notice stays; a files note the world no longer has goes.
 */
export function nextFilesNotice(note: string | null, current: string | null): string | null {
  if (current !== null && !isFilesNotice(current)) return current
  return note
}
