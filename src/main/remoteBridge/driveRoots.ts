import { promises as fsp } from 'fs'

/**
 * The drive roots the phone's folder picker offers at home: `C:\`, `D:\`, ... on
 * Windows, and `/` everywhere else, where every volume is a folder under it.
 *
 * Found in-process, with one `stat` per letter -- never by running `wmic`,
 * `fsutil` or PowerShell. A subprocess that enumerates volumes is exactly what
 * endpoint security watches for, and it would cost a process spawn per open.
 *
 * Each letter gets DRIVE_PROBE_TIMEOUT_MS. A mapped drive whose server is gone
 * does not fail, it HANGS, for as long as the OS's own network timeout, and a
 * picker that waited it out would take that long to open. Two things keep a
 * dead drive from costing that more than once:
 *  - An ask still out is never asked again; whoever wants that letter waits on
 *    the same one. Each hung `stat` holds one of libuv's four threadpool threads
 *    until the OS gives up, and re-asking on every open would hold them all --
 *    and with them every other file read and DNS lookup in the bridge.
 *  - A letter that timed out is skipped, without waiting, for
 *    DRIVE_TIMEOUT_MEMORY_MS -- unless its answer arrives after all (a NAS
 *    spinning up). Then the timeout is forgotten at once and the next open
 *    offers the drive, rather than hiding a drive that is plainly there.
 *
 * An empty card reader or DVD drive, or a locked volume, fails its `stat` at once
 * and is simply not offered.
 */

/** How long one drive letter may take to answer before the picker opens without it. */
export const DRIVE_PROBE_TIMEOUT_MS = 1_500

/** How long a letter that timed out is skipped rather than waited on again. */
export const DRIVE_TIMEOUT_MEMORY_MS = 60_000

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** The one filesystem call a probe makes. A test seam: vi.mock('fs') cannot
 *  reach the bridge, because vitest externalises Node builtins. */
export type DriveStat = (root: string) => Promise<{ isDirectory(): boolean }>

export interface DriveProberOptions {
  stat?: DriveStat
  platform?: NodeJS.Platform
}

/** `work`, or `fallback` once `ms` pass first. The work itself is not cancelled
 *  -- nothing can cancel a `stat` -- it is only no longer waited for. */
export function settleWithin<T, F>(work: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

const TIMED_OUT: unique symbol = Symbol('timed out')

export class DriveProber {
  private readonly stat: DriveStat
  private readonly platform: NodeJS.Platform
  /** Asks still out, by root -- hung ones included, until the OS gives up. */
  private readonly asking = new Map<string, Promise<boolean>>()
  /** When each root last timed out, while that is still being remembered. */
  private readonly timedOutAt = new Map<string, number>()

  constructor(options: DriveProberOptions = {}) {
    this.stat = options.stat ?? ((root) => fsp.stat(root))
    this.platform = options.platform ?? process.platform
  }

  /** The roots that answered as folders, in letter order. Never rejects. */
  async roots(): Promise<string[]> {
    if (this.platform !== 'win32') return ['/']
    // All letters at once: the picker waits for the slowest drive, not the sum.
    const found = await Promise.all(Array.from(DRIVE_LETTERS, (letter) => this.probe(`${letter}:\\`)))
    return found.filter((root): root is string => root !== null)
  }

  private async probe(root: string): Promise<string | null> {
    const since = this.timedOutAt.get(root)
    if (since !== undefined && Date.now() - since < DRIVE_TIMEOUT_MEMORY_MS) return null
    const answer = await settleWithin(this.ask(root), DRIVE_PROBE_TIMEOUT_MS, TIMED_OUT)
    if (answer === TIMED_OUT) {
      this.timedOutAt.set(root, Date.now())
      return null
    }
    return answer ? root : null
  }

  /** The ask already out for `root`, or a new one. Settles true only for a folder:
   *  a stat that fails -- or throws, or answers with something that is not one --
   *  is a drive that is not there. */
  private ask(root: string): Promise<boolean> {
    const out = this.asking.get(root)
    if (out !== undefined) return out
    const asked = (async () => (await this.stat(root)).isDirectory())().catch(() => false)
    this.asking.set(root, asked)
    void asked.then((present) => {
      this.asking.delete(root)
      // A late YES ends the memory; a late no keeps it -- asking a drive that
      // took the OS's whole timeout to fail would only hang again.
      if (present) this.timedOutAt.delete(root)
    })
    return asked
  }
}

/** One prober for the bridge's lifetime, so asks still out and remembered
 *  timeouts carry from one open of the picker to the next. */
const bridgeProber = new DriveProber()

/** This desktop's drive roots, as the picker offers them at home. */
export function listDriveRoots(): Promise<string[]> {
  return bridgeProber.roots()
}
