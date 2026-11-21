import { join, resolve } from 'path'
import { fileURLToPath } from 'url'

/**
 * One-shot marker in userData: written when the updater quits the app to install an update (and
 * the installer starts it again), consumed by the next start, which then skips the intro. Every
 * other start plays it, the first start of a new major version included, since the version that
 * installed it never wrote a marker.
 */
export const UPDATE_RESTART_FILE = 'update-restart'

/**
 * How long a marker counts. An install that was cancelled or failed leaves one behind with no
 * restart coming; past this age the next start is one the user made, and plays. Ten minutes covers
 * a slow installer and a Linux administrator prompt.
 */
export const UPDATE_RESTART_MAX_AGE_MS = 10 * 60_000

export interface IntroGateDeps {
  userData: string
  env: NodeJS.ProcessEnv
  now(): number
  readFile(p: string): Promise<string>
  removeFile(p: string): Promise<void>
}

export interface IntroGate {
  /** Reads (and consumes) the marker, off the main thread. Idempotent: one read per process. */
  start(): Promise<void>
  /** Whether the intro may play. True at most once per process. */
  claim(): boolean
}

/** Whether a marker's text is a time within the freshness window. */
function freshMarker(text: string, now: number): boolean {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return false
  const age = now - Number(t)
  return age >= 0 && age <= UPDATE_RESTART_MAX_AGE_MS
}

async function decide(deps: IntroGateDeps): Promise<boolean> {
  const file = join(deps.userData, UPDATE_RESTART_FILE)
  let text: string
  try {
    text = await deps.readFile(file)
  } catch {
    // No marker, or one that can't be read: a start the user made. Fail open, so a read-only or
    // unreadable userData plays the intro rather than losing it for good.
    return true
  }
  // One-shot, whatever it says. A marker that can't be deleted (read-only userData) skips the intro
  // only until it ages out of the freshness window.
  void Promise.resolve().then(() => deps.removeFile(file)).catch(() => { /* ages out instead */ })
  return !freshMarker(text, deps.now())
}

/**
 * Decides once per process whether the launch intro may play. start() runs early in main, before
 * the window exists, so the answer is cached long before the preload asks for it through sendSync.
 * claim() never waits: asked before the answer is ready, it answers false (fail closed). A disk too
 * slow to read one small file in the time the window takes to load its page is no place for an
 * animation, and waiting would block the renderer on the main process.
 */
export function createIntroGate(deps: IntroGateDeps): IntroGate {
  let answer: boolean | null = null
  let started: Promise<void> | null = null
  let claimed = false
  return {
    start(): Promise<void> {
      if (started) return started
      started = (async () => {
        if (deps.env.NODE_ENV === 'test' && deps.env.TERMPOLIS_TEST_LAUNCH_INTRO !== '1') {
          answer = false
          return
        }
        answer = await decide(deps)
      })()
      return started
    },
    claim(): boolean {
      if (claimed) return false
      claimed = true
      return answer === true
    },
  }
}

type MarkerWrite = (p: string, text: string) => Promise<void> | void

function safeWrite(write: MarkerWrite, p: string, text: string): void {
  try {
    const r = write(p, text)
    if (r) r.catch(() => { /* no marker: the restart plays the intro, which is harmless */ })
  } catch { /* the update must go on whatever happens to the marker */ }
}

/** Marks the coming start as an update restart. Never throws into the update flow. */
export function markUpdateRestart(userData: string, write: MarkerWrite, now: () => number = Date.now): void {
  safeWrite(write, join(userData, UPDATE_RESTART_FILE), String(now()))
}

/** Takes the mark back when the restart isn't coming after all. An empty marker reads as "play". */
export function clearUpdateRestart(userData: string, write: MarkerWrite): void {
  safeWrite(write, join(userData, UPDATE_RESTART_FILE), '')
}

export interface RendererPage {
  /** ELECTRON_RENDERER_URL in dev; the window then loads only that. */
  devUrl?: string
  /** The packaged renderer's index.html, which the window loads with loadFile. */
  indexFile: string
  platform: NodeJS.Platform
}

function pagePath(pathname: string): string {
  return pathname.replace(/\/index\.html$/, '/').replace(/\/+$/, '')
}

/** Whether `url` is the renderer's own page: what the main window loads, and nothing else. */
export function isRendererPage(url: string, page: RendererPage): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (page.devUrl !== undefined) {
    let dev: URL
    try {
      dev = new URL(page.devUrl)
    } catch {
      return false
    }
    return u.origin === dev.origin && pagePath(u.pathname) === pagePath(dev.pathname)
  }
  if (u.protocol !== 'file:') return false
  let p: string
  try {
    p = resolve(fileURLToPath(u))
  } catch {
    return false
  }
  const want = resolve(page.indexFile)
  return page.platform === 'win32' ? p.toLowerCase() === want.toLowerCase() : p === want
}
