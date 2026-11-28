/**
 * True only when a real, hardware-accelerated WebGL2 context is available. Gates xterm's
 * WebGL renderer: under software GL (headless CI, VMs, old/blocked drivers) the addon
 * initializes but then throws ASYNCHRONOUSLY (undefined render dimensions / `_isDisposed`
 * on teardown) — a crash that escapes the synchronous guard around loadAddon — so we never
 * load it there and keep the robust DOM renderer. Returns false in non-DOM environments.
 *
 * The probe context is explicitly released before returning. A browser allows only a small
 * number of live WebGL contexts (Chromium's limit is around 16) and silently evicts the
 * oldest when the cap is hit. This ran once per terminal pane, so a probe context merely
 * dropped on the floor — alive until GC gets to it — meant opening and closing terminals
 * could push the contexts that real terminals were rendering with out of the cap. Those
 * panes then fall back to the DOM renderer mid-session, which reads as typing going
 * choppy, with nothing logged to explain it.
 *
 * BUILDFLAKE: a probe is a context made plus a dozen synchronous round trips to the GPU
 * process, and with the GPU busy (software GL drawing the map, macOS CI) one probe on the
 * main thread froze the page for 2.5 to 4.6 s. Every terminal pane probed at mount, so
 * opening Build it's agent terminal stalled the page right after its dialog closed. So:
 * - the answer is kept for the page, and a context lost anywhere in the page (the GPU
 *   process may have restarted, perhaps in software) drops it; an answer got with no
 *   context at all (no WebGL2, getContext throwing) is not kept;
 * - the app asks in a worker (webglProbe.worker.ts, given by main.tsx), off the main thread,
 *   once at start; a pane that mounts before the answer stays on the DOM renderer and takes
 *   its WebGL lease when the answer comes. Only with no worker given (tests) does the page
 *   ask on its own thread.
 */
let known: boolean | null = null
let lossWatched = false
let ProbeWorker: (new () => Worker) | null = null
let asking: Promise<boolean> | null = null
let generation = 0

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i

/**
 * The renderer a fresh context names: '' when the host hides it (no debug extension, which
 * counts as hardware: the behaviour that shipped), null when there is no context at all.
 * The context is handed straight back rather than left for GC.
 */
export function probeRenderer(getGl: () => WebGL2RenderingContext | null): string | null {
  try {
    const gl = getGl()
    if (!gl) return null
    try {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info')
      return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : ''
    } finally {
      try { gl.getExtension('WEBGL_lose_context')?.loseContext() } catch { /* nothing to release */ }
    }
  } catch {
    return null
  }
}

/** SwiftShader / llvmpipe / softpipe / ANGLE-software / Microsoft Basic Render: where the addon crashes. */
const isHardware = (renderer: string): boolean => !SOFTWARE.test(renderer)

/** Drop the kept answer (and any in flight): the next ask probes again. */
export function forgetHardwareWebgl(): void {
  known = null
  asking = null
  generation++
}

function watchLoss(): void {
  if (lossWatched) return
  // webglcontextlost does not bubble; a capture listener on the document still sees it for
  // every canvas in the page (a probe's own canvas is never in the page).
  document.addEventListener('webglcontextlost', forgetHardwareWebgl, true)
  lossWatched = true
}

/** Ask on this thread. Only for a page with no probe worker (tests); the app asks in the worker. */
export function hasHardwareWebgl(): boolean {
  if (known !== null) return known
  if (typeof document === 'undefined') return false
  watchLoss()
  const renderer = probeRenderer(() => document.createElement('canvas').getContext('webgl2') as WebGL2RenderingContext | null)
  if (renderer === null) return false
  known = isHardware(renderer)
  return known
}

/**
 * The answer as a pane mounts: kept, or asked here when there is no worker; null while the
 * worker is still asking (askHardwareWebgl gives it when it comes).
 */
export function hardwareWebglNow(): boolean | null {
  if (known !== null) return known
  if (!ProbeWorker) return hasHardwareWebgl()
  void askHardwareWebgl()
  return null
}

/** The answer, from the worker when one was given. One ask at a time for the page. */
export function askHardwareWebgl(): Promise<boolean> {
  if (known !== null) return Promise.resolve(known)
  if (!ProbeWorker) return Promise.resolve(hasHardwareWebgl())
  if (asking) return asking
  watchLoss()
  const Ctor = ProbeWorker
  const mine = generation
  const answer = new Promise<string | null>((resolve) => {
    let w: Worker | null = null
    const done = (renderer: string | null): void => {
      try { w?.terminate() } catch { /* already gone */ }
      resolve(renderer)
    }
    try {
      w = new Ctor()
      w.onmessage = (e: MessageEvent) => done(typeof e.data === 'string' ? e.data : null)
      w.onerror = () => done(null)
    } catch {
      done(null)
    }
  }).then((renderer) => {
    const ok = renderer !== null && isHardware(renderer)
    // An answer asked before a forget is given to its caller but not kept.
    if (mine === generation) {
      asking = null
      if (renderer !== null) known = ok
    }
    return ok
  })
  asking = answer
  return answer
}

/**
 * Give the page its probe worker and ask at once, at start, while the GPU has little else to
 * do: every pane after that finds the answer kept.
 */
export function warmHardwareWebgl(Worker: new () => Worker): void {
  ProbeWorker = Worker
  void askHardwareWebgl()
}

/** Tests: back to a page with no probe worker and no answer. */
export function resetHardwareWebglForTests(): void {
  ProbeWorker = null
  forgetHardwareWebgl()
}
