import { promises as fsp, realpath as realpathCallback } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { promisify } from 'util'

import { DRIVE_PROBE_TIMEOUT_MS, listDriveRoots, settleWithin } from './driveRoots'
import { MAX_PAYLOAD_BYTES } from './outputChunker'
import type { DirectoryEntry, DirectoryListing } from './protocol'

/**
 * Lists a desktop folder for the phone's remote picker.
 *
 * The picker opens at the desktop home, and home is also where it offers the
 * desktop's drives -- `C:\`, `D:\`, ... on Windows, `/` elsewhere -- ahead of
 * home's own folders. That is the way off the drive the user's profile lives
 * on. From there any real folder is listed with its real parent, except that up
 * from a drive root is home again: dirname of a root is the root, and a ".."
 * that reloaded the same level would strand the user there.
 *
 * It used to be fenced to home. That fence never limited where a terminal could
 * start -- `createTerminal` and `launchAgent` have always taken any folder -- it
 * only hid the folders people needed: everything on a second drive (issue #35).
 * The `createTerminal` grant and the pairing are the gate, as they are for the
 * launch itself.
 *
 * What it does still refuse is a network or device path. On Windows, merely
 * opening `\\host\share` makes the OS connect to that host and offer it the
 * signed-in user's NTLM hash, so a phone able to name one could harvest it. The
 * check runs before the first filesystem call; a link that resolves to one is not
 * offered; and the dispatcher refuses one as a launch folder.
 *
 * This is bridge-local filesystem access, NOT an MCP tool -- the agent-facing
 * tool-description budget is nearly full, and the phone is the only caller. Every
 * path offered is real (links resolved), so a phone that echoes them back -- to
 * descend or to launch -- names folders the desktop itself found. A request that
 * does not exist, cannot be read, or is refused falls back to home rather than
 * erroring: the picker must always render SOMETHING selectable, and home always
 * carries the drives.
 */

/** The most rows one listing carries. C:\Windows\WinSxS holds ~23,000 folders,
 *  five megabytes of listing, and the relay refuses any frame over one: the phone
 *  would get an error and no way past it. The first 2,000 by name are more than
 *  anyone scrolls a phone through. */
export const MAX_PICKER_ENTRIES = 2_000

/** Bytes relayClient's envelope adds around a listing -- it sends
 *  `{"kind":"ok","id":<id>,"data":<listing>}` -- counted at the widest id. */
const ENVELOPE_BYTES =
  Buffer.byteLength(JSON.stringify({ kind: 'ok', id: Number.MAX_SAFE_INTEGER, data: null })) - 'null'.length

/** How long resolving one link in a folder may take before the folder is listed
 *  without it. A link to a dead network drive hangs exactly as the drive does,
 *  and one such link must not hold the whole level -- least of all home, the one
 *  level the user cannot get around. */
const LINK_TIMEOUT_MS = DRIVE_PROBE_TIMEOUT_MS

/** What the picker reads of a directory entry. `fs.Dirent` satisfies it. */
export interface PickerDirent {
  readonly name: string
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/** The three filesystem calls the picker makes, so a test can see -- and stand in
 *  for -- every path it touches. vi.mock('fs') cannot: vitest externalises Node
 *  builtins. */
export interface PickerFs {
  realpath(path: string): Promise<string>
  stat(path: string): Promise<{ isDirectory(): boolean }>
  readdir(path: string): Promise<PickerDirent[]>
}

/** Test seams. Nothing in production passes any of them. */
export interface PickerDeps {
  fs?: PickerFs
  /** The drive roots home offers; the bridge's own DriveProber by default. */
  driveRoots?: () => Promise<string[]>
  /** Decides whether paths that differ only in case are one folder. */
  platform?: NodeJS.Platform
}

/** The JS realpath, deliberately not `fs.promises.realpath`. The native one asks
 *  Windows for each path's final name, which turns a mapped drive `Z:\` into
 *  `\\server\share` -- a network path, which would then be refused -- and a SUBST
 *  drive into the folder behind it. The JS one only follows links, so a drive
 *  stays the drive the user sees in Explorer. */
const realpathJs = promisify(realpathCallback)

const NODE_FS: PickerFs = {
  realpath: (path) => realpathJs(path),
  stat: (path) => fsp.stat(path),
  readdir: (path) => fsp.readdir(path, { withFileTypes: true }),
}

const collator = new Intl.Collator()
const byName = (a: DirectoryEntry, b: DirectoryEntry): number => collator.compare(a.name, b.name)

/**
 * True for a path that leaves this machine or names a device: `\\server\share`,
 * `//server/share`, and the Win32 `\\?\` and `\\.\` namespaces, which can spell a
 * share too (`\\?\UNC\server\share`). Two leading separators of either kind is
 * the whole test, the same one linkedJobs applies to a linked job's folder. The
 * picker never offers a path spelled that way, on any platform, so refusing one
 * costs nothing.
 */
export function isNetworkOrDevicePath(path: string): boolean {
  return /^[\\/]{2}/.test(path)
}

/** Lists `rawPath`, or home -- with the drives -- when it is absent or refused. */
export async function listDirectory(rawPath?: string, deps: PickerDeps = {}): Promise<DirectoryListing> {
  const fs = deps.fs ?? NODE_FS
  const platform = deps.platform ?? process.platform
  const home = await canonicalHome(fs)
  const target = await resolveTarget(fs, home, rawPath)

  if (folderKey(target, platform) === folderKey(home, platform)) {
    // The drives are asked alongside the read of home, not before it, so a slow
    // drive costs the listing its own timeout and nothing on top.
    const [roots, found] = await Promise.all([driveRootsFor(deps), readFolders(fs, home)])
    return assemble(home, null, roots, found, platform)
  }
  return assemble(target, parentOf(target, home), [], await readFolders(fs, target), platform)
}

/** The canonical desktop home. realpath so a symlinked home (e.g. macOS `/var` ->
 *  `/private/var`) compares equal to the paths readdir hands back; if that fails
 *  for any reason, the raw home still works as the picker's starting point. */
async function canonicalHome(fs: PickerFs): Promise<string> {
  const home = homedir()
  try {
    return await fs.realpath(home)
  } catch {
    return home
  }
}

/** The real folder a request names, or home when it is absent, not text, a
 *  network or device path, missing, unreadable, or not a folder. */
async function resolveTarget(fs: PickerFs, home: string, rawPath: unknown): Promise<string> {
  // `path` crosses the wire unvalidated: the relay checks only the request kind.
  if (typeof rawPath !== 'string' || rawPath.length === 0) return home
  // On the phone's own string, before resolve() and before any filesystem call.
  // Nothing about a share may be touched -- not even to find out it is one.
  if (isNetworkOrDevicePath(rawPath)) return home
  try {
    const real = await fs.realpath(resolve(home, rawPath))
    // A local link can still lead to a share. It is not listed: the picker never
    // offers a network path, and the dispatcher would refuse one to launch in.
    if (!isNetworkOrDevicePath(real) && (await fs.stat(real)).isDirectory()) return real
  } catch {
    // ENOENT, permission, an ejected drive, a broken link -- home instead.
  }
  return home
}

/** Up one level -- except from a filesystem root, where dirname is the root
 *  itself; up from a drive is home, where the drives are listed. */
function parentOf(target: string, home: string): string {
  const up = dirname(target)
  return up === target ? home : up
}

/** The drive rows for home. A prober that fails outright costs the drives, never
 *  the listing: home is still listed, and still selectable. */
async function driveRootsFor(deps: PickerDeps): Promise<string[]> {
  try {
    return await (deps.driveRoots ?? listDriveRoots)()
  } catch {
    return []
  }
}

/** A folder's children: plain folders as they are, links followed. */
interface Found {
  plain: DirectoryEntry[]
  links: DirectoryEntry[]
}

/** The subfolders of `target`. A plain folder costs no syscall: its dirent says
 *  it is one, and under a real `target` its joined path IS its real path. A link
 *  (symlink, junction, or any other reparse point Windows reports as one) is
 *  followed to its real path, and offered only if that is a local folder. A
 *  folder that cannot be read yields none rather than throwing -- the level
 *  above it stays browsable. */
async function readFolders(fs: PickerFs, target: string): Promise<Found> {
  let dirents: PickerDirent[]
  try {
    dirents = await fs.readdir(target)
  } catch {
    return { plain: [], links: [] }
  }
  const plain = dirents
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, path: join(target, d.name) }))
  const followed = await Promise.all(
    dirents
      .filter((d) => !d.isDirectory() && d.isSymbolicLink())
      .map(async (d) => {
        const real = await settleWithin(followLink(fs, join(target, d.name)), LINK_TIMEOUT_MS, null)
        return real === null ? null : { name: d.name, path: real }
      }),
  )
  return { plain, links: followed.filter((e): e is DirectoryEntry => e !== null) }
}

/** Where a link leads, if that is a local folder; null for anything else. */
async function followLink(fs: PickerFs, at: string): Promise<string | null> {
  try {
    const real = await fs.realpath(at)
    if (isNetworkOrDevicePath(real)) return null
    return (await fs.stat(real)).isDirectory() ? real : null
  } catch {
    // Dangling, unreadable, or a loop -- not offered.
    return null
  }
}

/**
 * One listing, every path in it once.
 *
 * The phone keys its rows by `path` (FlatList keyExtractor), so a path twice is a
 * duplicate key -- and Windows puts one in every profile: `My Documents` is a
 * junction onto `Documents`. Only a drive row or a link can repeat a path, so
 * only they are checked. The listing's own folder claims its path first (a link
 * back to it would only reload the level), then the drive rows, then every plain
 * folder, and only then the links -- so a link onto a sibling is the row dropped,
 * whichever of the two sorts first.
 */
function assemble(
  path: string,
  parent: string | null,
  roots: string[],
  found: Found,
  platform: NodeJS.Platform,
): DirectoryListing {
  const claimed = new Set<string>([folderKey(path, platform)])
  const unclaimed = (entry: DirectoryEntry): boolean => {
    const key = folderKey(entry.path, platform)
    if (claimed.has(key)) return false
    claimed.add(key)
    return true
  }
  // Drive rows are named by their own path -- `D:\` is what a Windows user looks
  // for -- and lead the list in letter order, ahead of the alphabetical folders.
  const drives = roots.map((root) => ({ name: root, path: root })).filter(unclaimed)
  // Every plain folder is kept: each is its own directory entry, sitting below
  // the listing and so never a drive root or the listing itself. Folding case
  // here would wrongly merge `Foo` and `foo` in a case-sensitive directory.
  for (const entry of found.plain) claimed.add(folderKey(entry.path, platform))
  const links = [...found.links].sort(byName).filter(unclaimed)
  return fit({ path, parent, entries: [...drives, ...[...found.plain, ...links].sort(byName)] })
}

/** Windows paths are case-insensitive; elsewhere `Foo` and `foo` are two folders. */
function folderKey(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? path.toLowerCase() : path
}

/**
 * The listing cut to what one relay frame carries: at most MAX_PICKER_ENTRIES
 * rows, and never more bytes than relayClient will send -- past that it swaps the
 * whole answer for "response too large for the relay", and the phone is stuck.
 * Counted in the bytes JSON actually produces, so a Windows path's escaped
 * backslashes are paid for, not just its characters. Rows are kept in order, so
 * the cut always falls at the end.
 */
function fit(listing: DirectoryListing): DirectoryListing {
  let bytes = ENVELOPE_BYTES + Buffer.byteLength(JSON.stringify({ ...listing, entries: [] }))
  const entries: DirectoryEntry[] = []
  for (const entry of listing.entries) {
    if (entries.length === MAX_PICKER_ENTRIES) break
    // A comma before every row but the first.
    const cost = Buffer.byteLength(JSON.stringify(entry)) + (entries.length === 0 ? 0 : 1)
    if (bytes + cost > MAX_PAYLOAD_BYTES) break
    bytes += cost
    entries.push(entry)
  }
  return { ...listing, entries }
}
