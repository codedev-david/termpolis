// The Commit Shield's scanner, kept where a hook can always find it (I1, holdb-review).
//
// A hook names the scanner by its full path, and runs with Termpolis closed. The scanner a packaged build ships sits in
// the app's own folder, which is not always there once that launch has exited: an AppImage's is a /tmp/.mount_* folder
// that goes away with it, a snap's names its revision (snapd keeps only the last few), and a macOS app run from
// Downloads is translocated to a random folder. A hook naming any of those fails open later, without a word. So a
// packaged build copies the scanner into its userData folder (~/.config/termpolis on Linux, the snap included, since
// index.ts moves userData back there), and the hook names that copy. Each launch refreshes a copy that is there, so the
// rules a hook scans with follow the app's updates.

import { join } from 'path'

/** Every file the scanner loads: termpolis-githook.cjs and each file it requires, all from its own folder.
 *  tests/electron/shieldScanner.test.ts reads the requires and fails when this list misses one. */
export const SHIELD_SCANNER_FILES: readonly string[] = ['termpolis-githook.cjs', 'secretRules.cjs', 'binPath.cjs', 'dataDir.cjs']

/** The folder under userData that holds the copy. */
export const SHIELD_SCANNER_DIR = 'commit-shield'

export interface ScannerCopyDeps {
  /** A file's text, or null when it can't be read. */
  read: (p: string) => string | null
  /** Writes a file, making its folder. */
  write: (p: string, data: string) => void
  rename: (from: string, to: string) => void
}

/**
 * Copy the scanner from `srcDir` into `destDir` and answer the copy's entry file, or null when a file could not be read
 * or written (the caller then names the shipped scanner, as before). A file that is already the same is left alone, and
 * a changed one is written beside it and renamed over it, so a hook running now never reads half a file. The files it
 * requires go first and the entry file last, so a hook started midway runs the old scanner whole or the new one whole,
 * as far as its entry file decides.
 */
export function keepScannerCopy(srcDir: string, destDir: string, deps: ScannerCopyDeps): string | null {
  try {
    for (const name of [...SHIELD_SCANNER_FILES].reverse()) {
      const text = deps.read(join(srcDir, name))
      if (text === null) return null
      const to = join(destDir, name)
      if (deps.read(to) === text) continue
      deps.write(`${to}.tmp`, text)
      deps.rename(`${to}.tmp`, to)
    }
    return join(destDir, SHIELD_SCANNER_FILES[0])
  } catch {
    return null
  }
}

/** A launch's refresh: brings a copy that is there up to the shipped scanner, and makes none (only Protect does). Only a
 *  packaged build has a shipped scanner (a dev build's hooks name the source file), and the folders are asked for only
 *  then. True when the copy is current; it never throws, as it runs in the middle of the app's start. */
export function refreshScannerCopy(packaged: boolean, srcDir: () => string, destDir: () => string, deps: ScannerCopyDeps): boolean {
  if (!packaged) return false
  try {
    const dest = destDir()
    if (deps.read(join(dest, SHIELD_SCANNER_FILES[0])) === null) return false
    return keepScannerCopy(srcDir(), dest, deps) !== null
  } catch {
    return false
  }
}
