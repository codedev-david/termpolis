// What every export-page spec shares: opening an exported file in the project's browser (or in Electron) with every
// request logged and every request but the page's own file refused, the init scripts a spec can ask for, the Ask box,
// and a pixel check of the city read from a screenshot (a small PNG decoder: the page's CSP is under test, so nothing
// is decoded inside the page).
import { test as base, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test'
import { _electron as electron, chromium, firefox, webkit, type ElectronApplication } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import { quitApp } from '../helpers/launch'
import { QUESTIONS_JSON } from './paths'

export const ASK_FAILED = "Smart Ask couldn't start in this browser; using keyword search."
export const ASK_LOADING = 'Smart Ask is getting ready… keyword search works now.'
/** boot.ts's OLD_BROWSER: the page in a browser without DecompressionStream. */
export const OLD_BROWSER = 'This browser is too old to open this Lumopolis page. Open it in Chrome or Edge 80 or later, Firefox 113 or later, or Safari 16.4 or later.'
export type AskState = 'keyword' | 'loading' | 'smart' | 'failed'

/**
 * The projects whose browser reports no request event for a file:// load: their request log can't prove itself
 * live on the page's own file, so page.page.ts's canary (a copy of the page that makes one non-file request)
 * proves it instead. Every other project proves it on each open: the log must hold the page's own file.
 */
export const SELF_LOAD_UNSEEN = new Set(['firefox'])

export interface OpenOptions {
  /** getContext('webgl'|'webgl2'|'experimental-webgl') answers null, as in a browser without WebGL. */
  noWebGL?: boolean
  /** WebAssembly.instantiate rejects, as in a browser that cannot run the ORT wasm. */
  wasmFails?: boolean
  /** No DecompressionStream, as in Safari before 16.4 or Firefox before 113. */
  noDecompression?: boolean
  /** WebAssembly.instantiate waits until the spec calls releaseWasm(), so smart Ask stays 'loading' meanwhile. */
  holdWasm?: boolean
  /** Playwright's clock is installed before the page loads (time runs as usual), so the spec can pause it. */
  clock?: boolean
  /** The page records when each step of its start happens, for phaseReport (smart.page.ts's readiness budget). */
  phases?: boolean
  /**
   * Electron's page gets the config's viewport, from before it loads, as Playwright gives it to every browser
   * project. Electron's window is a real one, as big as the screen lets it be: a Windows runner's 1024x768 screen
   * leaves it 1008x681, where the page lays out for a narrow window (no strip kept for the Ask box, which covers the
   * right of the city), so a spec that measures the wide layout's free area (cityClip) needs this.
   */
  configViewport?: boolean
}

export interface Opened {
  page: Page
  /** Every request URL the context saw, the page's own included. */
  requests: string[]
  /** Every error thrown in the page, from before it loaded on. */
  errors: string[]
  /** The requests that were neither the page's own file nor a data: or blob: URL. */
  foreign(): string[]
  /** Every CSP violation the page reported (directive and blocked URI). */
  violations(): Promise<string[]>
  releaseWasm(): Promise<void>
}

const NO_WEBGL = `(() => {
  const get = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    return /webgl/i.test(String(type)) ? null : get.call(this, type, ...rest)
  }
})()`
const WASM_FAILS = `(() => {
  const fail = () => Promise.reject(new Error('WebAssembly is off in this test'))
  WebAssembly.instantiate = fail
  WebAssembly.instantiateStreaming = fail
  WebAssembly.compile = fail
  WebAssembly.compileStreaming = fail
})()`
const NO_DECOMPRESSION = `(() => {
  delete window.DecompressionStream
  if (typeof window.DecompressionStream === 'function') Object.defineProperty(window, 'DecompressionStream', { value: undefined, configurable: true })
})()`
const HOLD_WASM = `(() => {
  let release
  const held = new Promise((resolve) => { release = resolve })
  Object.defineProperty(window, '__releaseWasm', { value: () => release(), configurable: true })
  const instantiate = WebAssembly.instantiate.bind(WebAssembly)
  WebAssembly.instantiate = (...args) => held.then(() => instantiate(...args))
})()`
/**
 * Times each step of the page's start on its own clock (performance.now), without changing what the page does: the
 * base64 decode of every block (atob: the city's blocks before the first paint, then vocab, ORT wasm and model),
 * the ORT wasm's compile (WebAssembly.instantiate), the 3D canvas's arrival, and the main thread's long tasks
 * (Chromium only). phaseReport reads them back with the navigation and paint timings.
 */
const PHASES = `(() => {
  const now = () => performance.now()
  const rec = { atob: [], wasm: [], canvasAt: null, longTasks: [] }
  Object.defineProperty(window, '__wxPhases', { value: rec, configurable: true })
  const atob0 = window.atob.bind(window)
  window.atob = (text) => {
    const start = now()
    const out = atob0(text)
    rec.atob.push({ start, end: now(), bytes: out.length })
    return out
  }
  const inst = WebAssembly.instantiate.bind(WebAssembly)
  WebAssembly.instantiate = (...args) => {
    const start = now()
    return inst(...args).then((r) => { rec.wasm.push({ start, end: now() }); return r })
  }
  new MutationObserver((list, obs) => {
    if (document.querySelector('canvas')) { rec.canvasAt = now(); obs.disconnect() }
  }).observe(document, { childList: true, subtree: true })
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) rec.longTasks.push({ start: e.startTime, ms: e.duration }) })
      .observe({ type: 'longtask', buffered: true })
  } catch { /* no long-task timing in this browser */ }
})()`
const WATCH_CSP = `(() => {
  const seen = []
  Object.defineProperty(window, '__cspViolations', { value: seen, configurable: true })
  document.addEventListener('securitypolicyviolation', (e) => { seen.push(e.effectiveDirective + ' ' + e.blockedURI) })
})()`

/** How long one tracing.stop may take before the teardown gives up on that trace and goes on to close. */
const STOP_TIMEOUT_MS = 15_000

/** `work`, or a rejection naming `what` once `ms` have passed; the timer never holds the process open. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle in ${ms / 1000} s`)), ms)
    timer.unref()
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

const same = (a: string, b: string): boolean => decodeURIComponent(a).toLowerCase() === decodeURIComponent(b).toLowerCase()

/** The browser a project names; Electron is opened by the fixture itself. */
async function launchBrowser(info: TestInfo): Promise<{ context: BrowserContext; close(): Promise<void> }> {
  const use = info.project.use
  const type = use.browserName === 'firefox' ? firefox : use.browserName === 'webkit' ? webkit : chromium
  const browser = await type.launch({ ...(use.channel ? { channel: use.channel } : {}) })
  const context = await browser.newContext({ viewport: use.viewport ?? { width: 1280, height: 800 } })
  return { context, close: () => browser.close() }
}

async function launchElectron(): Promise<{ app: ElectronApplication; page: Page; close(): Promise<void> }> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-export-page-'))
  const app = await electron.launch({
    args: [path.resolve('e2e/export-page/electronHost.cjs'), `--user-data-dir=${userData}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
  })
  const page = await app.firstWindow()
  return {
    app,
    page,
    close: async () => {
      try {
        await quitApp(app)
      } finally {
        fs.rmSync(userData, { recursive: true, force: true })
      }
    },
  }
}

/**
 * Emulates a `width` by `height` viewport at the window's own device scale factor. The CDP session stays attached
 * (Chromium drops a session's emulation when it detaches) and closes with the page; the override outlives the
 * page's navigations.
 */
async function emulateViewport(page: Page, { width, height }: { width: number; height: number }): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false })
  // Within a pixel: the window's own display scaling leaves a rounding pixel under emulation (1281 at 114%).
  const near = (): Promise<string> => page.evaluate(({ w, h }) => (Math.abs(innerWidth - w) <= 1 && Math.abs(innerHeight - h) <= 1 ? 'ok' : `${innerWidth}x${innerHeight}`), { w: width, h: height })
  await expect.poll(near, { message: `the Electron page at the config viewport, ${width}x${height}`, timeout: 10_000 }).toBe('ok')
}

type Fixtures = { open: (file: string, opts?: OpenOptions) => Promise<Opened> }

/**
 * `open(file, opts)`: the exported file in this project's browser, every request logged and the context offline (in
 * WebKit, every request but the page's own file and its data: and blob: URLs aborted), so nothing leaves the machine. One browser (or Electron) per test, closed after it. Each test then checks `foreign()` is empty.
 */
export const test = base.extend<Fixtures>({
  // Playwright reads a fixture's first parameter as an object pattern, and this one needs no other fixture.
  // eslint-disable-next-line no-empty-pattern
  open: async ({}, use, info) => {
    const closers: Array<() => Promise<void>> = []
    // These browsers are launched here, not by Playwright Test, so its trace option never reaches them:
    // each context is traced from the start, and the trace is kept only when the test did not go as expected.
    const traced: BrowserContext[] = []
    await use(async (file, opts = {}) => {
      const own = pathToFileURL(file).href
      let context: BrowserContext
      let page: Page | null = null
      if (info.project.name === 'electron') {
        const e = await launchElectron()
        closers.push(e.close)
        context = e.app.context()
        page = e.page
      } else {
        const b = await launchBrowser(info)
        closers.push(b.close)
        context = b.context
      }
      // Snapshots stay on: a failed smart.page test's trace measured 0.5-4.4 MB across the four projects.
      await context.tracing.start({ screenshots: true, snapshots: true })
      traced.push(context)
      const requests: string[] = []
      const allowed = (url: string): boolean => same(url, own) || url.startsWith('data:') || url.startsWith('blob:')
      context.on('request', (r) => { requests.push(r.url()) })
      // Offline, not a route: the browser fails every network request before any lookup, so nothing leaves the
      // machine, and the page's own file:// load and its data: and blob: URLs are left alone. Any route makes
      // Playwright pause every request in the browser, the page's own 37 MB smart.html included, and on the Windows
      // runner that held its delivery for up to 6.8 s (export-page soak 45592749570: Electron's file arrived in
      // 147-227 ms over 36 loads without a route and in a median 460 ms, twice over 6 s, over 36 with one), which
      // smart.page.ts read as Ask ready over its 6 s budget. WebKit alone keeps the route: offline, it fails the
      // file:// navigation itself ("WebKit encountered an internal error"), its route held the file no longer than no
      // route did there (medians 141-148 ms either way), and it is not held to that budget.
      if (info.project.use.browserName === 'webkit') {
        await context.route('**/*', (route) => (allowed(route.request().url()) ? route.continue() : route.abort()))
      } else {
        await context.setOffline(true)
      }
      await context.addInitScript(WATCH_CSP)
      if (opts.noWebGL) await context.addInitScript(NO_WEBGL)
      if (opts.wasmFails) await context.addInitScript(WASM_FAILS)
      if (opts.noDecompression) await context.addInitScript(NO_DECOMPRESSION)
      if (opts.holdWasm) await context.addInitScript(HOLD_WASM)
      if (opts.phases) await context.addInitScript(PHASES)
      if (opts.clock) await context.clock.install()
      if (page === null) page = await context.newPage()
      const p = page
      if (opts.configViewport && info.project.name === 'electron') await emulateViewport(p, info.project.use.viewport ?? { width: 1280, height: 800 })
      const errors: string[] = []
      p.on('pageerror', (e) => { errors.push(String(e)) })
      await p.goto(own, { waitUntil: 'load', timeout: 60_000 })
      // The positive control: an empty foreign() means something only if the log sees requests at all, and the
      // page's own file is the one request every load makes (where the browser reports it; else the canary test).
      if (!SELF_LOAD_UNSEEN.has(info.project.name)) {
        expect(requests.some((u) => same(u, own)), `the request log saw the page itself (${JSON.stringify(requests.slice(0, 5))})`).toBe(true)
      }
      return {
        page: p,
        requests,
        errors,
        foreign: () => requests.filter((u) => !allowed(u)),
        violations: () => p.evaluate(() => [...((window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [])]),
        releaseWasm: () => p.evaluate(() => (window as unknown as { __releaseWasm(): void }).__releaseWasm()),
      }
    })
    const keep = info.status !== info.expectedStatus
    try {
      for (const [i, context] of traced.entries()) {
        const name = i === 0 ? 'trace' : `trace-${i}`
        try {
          if (!keep) { await within(context.tracing.stop(), STOP_TIMEOUT_MS, 'tracing.stop'); continue }
          const file = info.outputPath(`${name}.zip`)
          await within(context.tracing.stop({ path: file }), STOP_TIMEOUT_MS, 'tracing.stop')
          // Pushed, not info.attach(): attach copies the file into attachments/, and a trace can be tens of MB.
          info.attachments.push({ name, path: file, contentType: 'application/zip' })
        } catch (e) {
          // A trace that cannot be saved (a stalled stop, a browser or Electron that died mid-test) never fails
          // the teardown, but the report says it is missing.
          info.annotations.push({ type: 'trace', description: `${name} not saved: ${e instanceof Error ? e.message : String(e)}` })
        }
      }
    } finally {
      for (const close of closers.reverse()) await close().catch(() => undefined)
    }
  },
})
export { expect }

/** The page's Ask state now. */
export const askState = (page: Page): Promise<AskState> => page.evaluate(() => (window as unknown as { __worldExport: { state(): AskState } }).__worldExport.state())

/** What window.__worldExport.ready settled to, and when (ms since the page's navigation began). */
export const askReady = (page: Page, timeout = 60_000): Promise<{ state: AskState; at: number }> =>
  page.evaluate((ms) => Promise.race([
    (window as unknown as { __worldExport: { ready: Promise<AskState> } }).__worldExport.ready.then((state) => ({ state, at: performance.now() })),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Ask was not ready after ${ms} ms`)), ms)),
  ]), timeout)

/**
 * Where the page's time to Ask-ready went, as one line of milliseconds on the page's clock (opened with `phases`):
 * HTML parsed (the page carries its blocks inline), DOMContentLoaded, load, first paint, the 3D canvas; the blocks
 * decoded before the paint and the three smart Ask decodes after it (each "at+ms:KB"); the ORT wasm compile; from it
 * to ready (the model's session plus one embed); long tasks before ready (their total, then the first eight as
 * "at+ms"); and a fixed CPU probe run after ready,
 * which compares runners (the same work on a slower machine takes longer). wasmMs is the ORT wasm's instantiate on
 * its own (null if the page never compiled it).
 */
export async function phaseReport(page: Page, readyAt: number): Promise<{ line: string; wasmMs: number | null }> {
  return page.evaluate((ready) => {
    const r = (window as unknown as { __wxPhases: { atob: Array<{ start: number; end: number; bytes: number }>; wasm: Array<{ start: number; end: number }>; canvasAt: number | null; longTasks: Array<{ start: number; ms: number }> } }).__wxPhases
    const n = (x: number | null | undefined): string => (x === null || x === undefined ? '-' : String(Math.round(x)))
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime
    const blocks = r.atob.map((b) => `${n(b.start)}+${n(b.end - b.start)}:${Math.round(b.bytes / 1024)}KB`).join(' ')
    const w = r.wasm[r.wasm.length - 1]
    const before = r.longTasks.filter((t) => t.start < ready)
    const t0 = performance.now()
    let x = 0
    for (let i = 0; i < 20_000_000; i++) x = (x + i * 7) % 1_000_003
    const probe = performance.now() - t0
    const line = [
      `parsed ${n(nav?.domInteractive)}`, `dcl ${n(nav?.domContentLoadedEventEnd)}`, `load ${n(nav?.loadEventEnd)}`,
      `fcp ${n(fcp)}`, `canvas ${n(r.canvasAt)}`, `decodes [${blocks}]`,
      `wasm ${w ? `${n(w.start)}+${n(w.end - w.start)}` : '-'}`, `wasm->ready ${w ? n(ready - w.end) : '-'}`, `ready ${n(ready)}`,
      `longtasks ${before.length ? `${n(before.reduce((a, t) => a + t.ms, 0))}ms [${before.slice(0, 8).map((t) => `${n(t.start)}+${n(t.ms)}`).join(' ')}]` : '-'}`,
      `cpu-probe ${n(probe)}${x < 0 ? '' : ''}`,
    ].join(' | ')
    return { line, wasmMs: w ? w.end - w.start : null }
  }, readyAt)
}

/** Asks a question (typed, then Enter) and returns the result ids in order, once the list shows. */
export async function ask(page: Page, q: string): Promise<string[]> {
  const input = page.locator('.wx-ask-input')
  await input.fill(q)
  // The previous question's list must not be read as this one's answer.
  await page.evaluate(() => { const r = document.querySelector('.wx-ask-results'); if (r) r.textContent = '' })
  await input.press('Enter')
  const picks = page.locator('.wx-ask-results button.wx-ask-pick')
  await expect(picks.first()).toBeVisible({ timeout: 15_000 })
  return picks.evaluateAll((els) => els.map((e) => e.getAttribute('data-id') ?? ''))
}

export interface Question { q: string; labelled: string[] }
export const questions = (): Question[] => JSON.parse(fs.readFileSync(QUESTIONS_JSON, 'utf8')) as Question[]

/** RGBA pixels of a PNG (8-bit, non-interlaced, truecolour with or without alpha: what every browser's screenshot is). */
export function decodePng(png: Buffer): { width: number; height: number; rgba: Uint8Array } {
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const depth = png[24]
  const colour = png[25]
  if (depth !== 8 || (colour !== 2 && colour !== 6) || png[28] !== 0) throw new Error(`unsupported PNG: depth ${depth}, colour ${colour}, interlace ${png[28]}`)
  const idat: Buffer[] = []
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len))
    at += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = colour === 6 ? 4 : 3
  const stride = width * bpp
  const out = new Uint8Array(width * height * 4)
  const prev = new Uint8Array(stride)
  const cur = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[i] = v & 0xff
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      out[o] = cur[x * bpp]
      out[o + 1] = cur[x * bpp + 1]
      out[o + 2] = cur[x * bpp + 2]
      out[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255
    }
    prev.set(cur)
  }
  return { width, height, rgba: out }
}

/** How much of a screenshot is not the page's background (Holotable's #010409), and how many distinct colours it holds. */
export function paint(png: Buffer): { lit: number; colours: number } {
  const { rgba } = decodePng(png)
  let lit = 0
  const seen = new Set<number>()
  const n = rgba.length / 4
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4]
    const g = rgba[i * 4 + 1]
    const b = rgba[i * 4 + 2]
    if (Math.abs(r - 1) + Math.abs(g - 4) + Math.abs(b - 9) > 24) lit++
    seen.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3))
  }
  return { lit: lit / n, colours: seen.size }
}

/** The middle of the 3D view, clear of the card (left), the Ask box (right) and the toolbar (bottom). */
export async function cityClip(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('.wx-view').boundingBox()
  if (!box) throw new Error('no 3D view on the page')
  return { x: box.x + 370, y: box.y + 60, width: Math.max(100, box.width - 370 - 350), height: Math.max(100, box.height - 60 - 90) }
}

/**
 * Watches the city's frames through its canvas's WebGL context, the one the page drew with (getContext hands back the
 * same object): each frame drawn clears the canvas, so `clear` counts frames, and drawn in software each frame ends
 * with a fence that the page waits on before it draws the next (threeRenderer's lastDrawn), so the newest fence not
 * yet deleted is kept. Nothing the page does changes: the wrappers call the context's own methods. False without a
 * WebGL context (the 2D map).
 */
export async function watchFrames(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.querySelector('.wx-view canvas') as HTMLCanvasElement | null
    const gl = canvas && ((canvas.getContext('webgl2') as WebGL2RenderingContext | null) ?? (canvas.getContext('webgl') as WebGL2RenderingContext | null))
    if (!gl) return false
    const seen: { gl: WebGL2RenderingContext; frames: number; fence: WebGLSync | null } = { gl, frames: 0, fence: null }
    ;(window as unknown as { __frames: typeof seen }).__frames = seen
    const clear = gl.clear.bind(gl)
    gl.clear = (mask: number): void => { seen.frames++; clear(mask) }
    if (typeof gl.fenceSync === 'function') {
      const fenceSync = gl.fenceSync.bind(gl)
      const deleteSync = gl.deleteSync.bind(gl)
      gl.fenceSync = (condition: number, flags: number): WebGLSync | null => (seen.fence = fenceSync(condition, flags))
      gl.deleteSync = (sync: WebGLSync | null): void => { if (sync === seen.fence) seen.fence = null; deleteSync(sync) }
    }
    return true
  })
}


/**
 * Waits, in real time, until the GPU has finished the last frame the page drew: its fence is signalled (or there is
 * none: drawn on a GPU, no frame waits on one). Drawn in software the page draws no frame while the last is still
 * being drawn, however far its clock is moved, so a step of the stopped clock taken sooner draws nothing: on a CI
 * runner every step of the flight below came within a few milliseconds of the last, and the camera never moved.
 * Each look is a task of its own, so the context can update the fence's state between looks.
 */
export async function gpuIdle(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const { gl, fence } = (window as unknown as { __frames: { gl: WebGL2RenderingContext; fence: WebGLSync | null } }).__frames
    return fence === null || gl.isContextLost() || gl.getSyncParameter(fence, gl.SYNC_STATUS) === gl.SIGNALED
  }), { message: 'the GPU finished the last frame the page drew', timeout: 60_000, intervals: [5, 10, 20, 50, 100] }).toBe(true)
}
