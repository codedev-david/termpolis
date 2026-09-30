// Where the macOS app is running from, and whether it can update itself there.
//
// Squirrel.Mac can only replace a bundle on a volume it can write to. From the mounted .dmg, or
// from ~/Downloads under Gatekeeper's App Translocation (the read-only copy macOS runs a
// quarantined app from), it refuses — but only AFTER electron-updater has downloaded the whole
// update, so every 4-hourly check fetched the full download just to be refused again, and every
// refusal reached Sentry (#21/#22). One access() call up front answers the same question for free.
//
// The fix is the user's to make: run Termpolis from /Applications. So the updater offers, once, to
// move it there (Electron's app.moveToApplicationsFolder), and otherwise shows one plain hint.
//
// No `electron` import: the Electron calls arrive as injected functions from autoUpdater.ts, so
// every path here runs under plain unit tests on any OS.

import { constants as fsConstants, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { access } from 'fs/promises'
import { dirname, posix } from 'path'
import { scrubUpdaterText } from './updaterErrors'

/** Why this copy can't update itself where it is. */
export type UpdateBlocker = 'disk-image' | 'translocated' | 'read-only' | 'no-permission'

// Gatekeeper runs a quarantined app that was never moved from a read-only nullfs mount:
// /private/var/folders/…/AppTranslocation/<UUID>/d/Termpolis.app.
const TRANSLOCATION_SEGMENT = '/AppTranslocation/'

/** The `.app` bundle a macOS executable lives in (`…/Termpolis.app/Contents/MacOS/Termpolis`), or null. */
export function bundlePathFromExe(exePath: string): string | null {
  const match = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(exePath)
  return match ? match[1] : null
}

/** Resolves when `dir` is writable; rejects with the errno (EROFS, EACCES, …) when it isn't. */
export type WriteProbe = (dir: string) => Promise<void>

const probeWritable: WriteProbe = (dir) => access(dir, fsConstants.W_OK)

/**
 * Why Squirrel won't be able to install an update over this bundle, or null when it can — or when
 * this isn't a macOS bundle at all. Probes the bundle's PARENT: an install replaces the whole
 * bundle, so that is what must be writable. A writable external drive under /Volumes is fine; only
 * the errno decides. Anything the probe can't explain is not a blocker: updates are never switched
 * off on a guess.
 */
export async function detectUpdateBlocker(opts: {
  platform: NodeJS.Platform
  exePath: string
  probe?: WriteProbe
}): Promise<UpdateBlocker | null> {
  if (opts.platform !== 'darwin') return null
  const bundle = bundlePathFromExe(opts.exePath)
  if (!bundle) return null
  if (bundle.includes(TRANSLOCATION_SEGMENT)) return 'translocated'
  const probe = opts.probe ?? probeWritable
  try {
    await probe(posix.dirname(bundle))
    return null
  } catch (err) {
    const code = (err as { code?: unknown } | null | undefined)?.code
    if (code === 'EROFS') return readOnlyBlockerFor(bundle)
    if (code === 'EACCES' || code === 'EPERM') return 'no-permission'
    return null
  }
}

/**
 * Which read-only place a bundle is in, as far as its path tells. Also what the updater goes on
 * when Squirrel has already refused: its error says only "read-only volume". A read-only disk under
 * /Volumes is almost always the disk image Termpolis shipped on.
 */
export function readOnlyBlockerFor(bundle: string | null): UpdateBlocker {
  if (bundle?.includes(TRANSLOCATION_SEGMENT)) return 'translocated'
  if (bundle?.startsWith('/Volumes/')) return 'disk-image'
  return 'read-only'
}

const BLOCKER_HINTS: Record<UpdateBlocker, string> = {
  'disk-image':
    "Termpolis is running from a read-only disk (most likely the disk image it came on), so it can't update itself. Drag Termpolis into your Applications folder and open it from there to get updates.",
  translocated:
    "macOS is running Termpolis from a temporary read-only copy, so it can't update itself. Move Termpolis into your Applications folder and open it from there to get updates.",
  'read-only':
    "Termpolis is on a read-only disk, so it can't update itself. Move Termpolis into your Applications folder and open it from there to get updates.",
  // Also a standard (non-admin) account's /Applications, so this can't tell the user to move it there.
  'no-permission':
    "Termpolis can't update itself because your account can't make changes to the folder it's in. Ask an administrator to install updates, or move Termpolis to a folder you own.",
}

/** The one line the user sees instead of a failed update every 4 hours. */
export function updateBlockerHint(blocker: UpdateBlocker): string {
  return BLOCKER_HINTS[blocker]
}

/** What the updater remembers across launches (`<userData>/updater-prefs.json`). */
export interface UpdaterPrefs {
  /** How the one-time Move to Applications offer ended. Once set, the offer is never made again. */
  moveOffer?: 'declined' | 'moved' | 'failed'
}

const MOVE_OFFER_OUTCOMES: ReadonlySet<string> = new Set(['declined', 'moved', 'failed'])

/** The saved prefs. A missing, corrupt or unrecognised file is simply no prefs. */
export function readUpdaterPrefs(file: string): UpdaterPrefs {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { moveOffer?: unknown } | null
    const moveOffer = parsed?.moveOffer
    return typeof moveOffer === 'string' && MOVE_OFFER_OUTCOMES.has(moveOffer)
      ? { moveOffer: moveOffer as UpdaterPrefs['moveOffer'] }
      : {}
  } catch {
    return {}
  }
}

/** Saves the prefs; false when the disk won't take them (the offer then comes back next launch). */
export function writeUpdaterPrefs(file: string, prefs: UpdaterPrefs): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(prefs, null, 2))
    return true
  } catch {
    return false
  }
}

/** The offer is made on macOS, outside Applications, and only until it has been answered once. */
export function shouldOfferMoveToApplications(opts: {
  platform: NodeJS.Platform
  inApplicationsFolder: boolean
  prefs: UpdaterPrefs
}): boolean {
  return opts.platform === 'darwin' && !opts.inApplicationsFolder && !opts.prefs.moveOffer
}

/** The part of Electron's MessageBoxOptions these dialogs use. */
export interface UpdaterDialog {
  type: 'question' | 'warning'
  buttons: string[]
  defaultId?: number
  cancelId?: number
  message: string
  detail: string
}

export const MOVE_OFFER_DIALOG: UpdaterDialog = {
  type: 'question',
  buttons: ['Move to Applications', 'Not now'],
  defaultId: 0,
  cancelId: 1,
  message: 'Move Termpolis to your Applications folder?',
  detail:
    "Termpolis keeps itself up to date when it runs from your Applications folder. Moving it restarts Termpolis and closes any open terminals. If you choose Not now, you won't be asked again — you can drag it there yourself at any time.",
}

export const MOVE_FAILED_DIALOG: UpdaterDialog = {
  type: 'warning',
  buttons: ['OK'],
  message: "Termpolis couldn't move itself to your Applications folder.",
  detail: 'To get automatic updates, quit Termpolis, drag it into your Applications folder, and open it from there.',
}

export type MoveOfferOutcome = 'not-offered' | 'declined' | 'moved' | 'failed'

export interface MoveOfferDeps {
  platform: NodeJS.Platform
  /** Where UpdaterPrefs are kept. */
  prefsPath: string
  /** app.isInApplicationsFolder — absent where Electron doesn't have it (anything but macOS). */
  isInApplicationsFolder?: () => boolean
  /**
   * app.moveToApplicationsFolder: true once moved (and this process is already quitting), false when
   * the user cancels the administrator password prompt, and it throws when the copy fails.
   */
  moveToApplicationsFolder: () => boolean
  showMessageBox: (dialog: UpdaterDialog) => Promise<{ response: number }>
  /**
   * Arms (true) and disarms (false) the main window's close-guard bypass. A move that works quits
   * the app from inside moveToApplicationsFolder, and the "AI agents are running" guard would
   * otherwise cancel that quit — leaving this copy running with its bundle moved out from under it.
   */
  setQuitBypass: (armed: boolean) => void
  log?: (message: string) => void
}

/**
 * The one-time offer to move Termpolis into /Applications, where it can update itself (macOS).
 * Every answer is saved, so it is made once: "Not now" is never asked again, and neither is a move
 * that failed — the user has been told how to do it by hand.
 */
export async function offerMoveToApplications(deps: MoveOfferDeps): Promise<MoveOfferOutcome> {
  const { platform, prefsPath, isInApplicationsFolder } = deps
  if (platform !== 'darwin' || !isInApplicationsFolder) return 'not-offered'
  let inApplicationsFolder: boolean
  try {
    inApplicationsFolder = isInApplicationsFolder()
  } catch {
    return 'not-offered'
  }
  const prefs = readUpdaterPrefs(prefsPath)
  if (!shouldOfferMoveToApplications({ platform, inApplicationsFolder, prefs })) return 'not-offered'

  let response: number
  try {
    ;({ response } = await deps.showMessageBox(MOVE_OFFER_DIALOG))
  } catch {
    return 'not-offered' // no dialog, so no answer: ask again next launch
  }
  if (response !== MOVE_OFFER_DIALOG.defaultId) {
    writeUpdaterPrefs(prefsPath, { ...prefs, moveOffer: 'declined' })
    return 'declined'
  }

  // Saved BEFORE the move: a move that works quits this process from inside the call.
  writeUpdaterPrefs(prefsPath, { ...prefs, moveOffer: 'moved' })
  deps.setQuitBypass(true)
  let moved: boolean
  try {
    moved = deps.moveToApplicationsFolder()
  } catch (err) {
    // Copying the app, or trashing an older copy already in Applications, failed. Nothing moved,
    // so the quit the bypass was armed for isn't coming: the close guard goes back to guarding.
    deps.setQuitBypass(false)
    writeUpdaterPrefs(prefsPath, { ...prefs, moveOffer: 'failed' })
    deps.log?.(`[updater] Move to Applications failed: ${scrubUpdaterText(errorText(err))}`)
    await deps.showMessageBox(MOVE_FAILED_DIALOG).catch(() => {})
    return 'failed'
  }
  if (moved) return 'moved'
  // false: the user cancelled the administrator password prompt — as good as "Not now".
  deps.setQuitBypass(false)
  writeUpdaterPrefs(prefsPath, { ...prefs, moveOffer: 'declined' })
  return 'declined'
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
