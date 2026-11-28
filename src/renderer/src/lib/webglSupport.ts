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
 * The answer is kept for the page and the probe runs once. Each probe is a context made on the
 * main thread plus a dozen synchronous round trips to the GPU process, and with the GPU busy
 * (software GL drawing the map, macOS CI) one probe froze the page for 2.5 to 4.6 s: every
 * terminal pane probed at mount, so opening an agent's terminal (Build it) stalled the page
 * right after its dialog closed. A context lost anywhere in the page can mean the GPU process
 * restarted, perhaps in software, so a lost context drops the answer and the next pane asks
 * again. An answer got with no context at all (no WebGL2, getContext throwing) is not kept.
 */
let known: boolean | null = null
let lossWatched = false

/** Drop the kept answer: the next call probes again. */
export function forgetHardwareWebgl(): void {
  known = null
}

export function hasHardwareWebgl(): boolean {
  if (known !== null) return known
  try {
    if (typeof document === 'undefined') return false
    if (!lossWatched) {
      // webglcontextlost does not bubble; a capture listener on the document still sees it for
      // every canvas in the page (the probe's own canvas is never in the page).
      document.addEventListener('webglcontextlost', forgetHardwareWebgl, true)
      lossWatched = true
    }
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null
    if (!gl) return false
    try {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info')
      const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : ''
      // SwiftShader / llvmpipe / softpipe / ANGLE-software / Microsoft Basic Render are the
      // software rasterizers where the async crash happens. An unknown renderer (host with
      // no debug extension) counts as hardware, which is the behaviour that shipped.
      known = !/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(renderer)
      return known
    } finally {
      // Hand the context straight back rather than waiting for GC.
      try { gl.getExtension('WEBGL_lose_context')?.loseContext() } catch { /* nothing to release */ }
    }
  } catch {
    return false
  }
}

/**
 * Ask once at the page's start, when it is first idle (within a second), while the GPU has nothing else to draw.
 * Keeping the answer does nothing for the page's first pane, and with no terminal open (the Lumopolis home first,
 * then Build it) that first pane is the agent's, mounted while the map draws in software: its probe froze the page
 * for seconds (BUILDFLAKE). Every pane after the start finds the answer kept.
 */
export function warmHardwareWebgl(): void {
  const ask = (): void => { hasHardwareWebgl() }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(ask, { timeout: 1000 })
  else setTimeout(ask, 0)
}
