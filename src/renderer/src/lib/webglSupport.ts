/**
 * True only when a real, hardware-accelerated WebGL2 context is available. Gates xterm's
 * WebGL renderer: under software GL (headless CI, VMs, old/blocked drivers) the addon
 * initializes but then throws ASYNCHRONOUSLY (undefined render dimensions / `_isDisposed`
 * on teardown) — a crash that escapes the synchronous guard around loadAddon — so we never
 * load it there and keep the robust DOM renderer. Returns false in non-DOM environments.
 *
 * The probe context is explicitly released before returning. A browser allows only a small
 * number of live WebGL contexts (Chromium's limit is around 16) and silently evicts the
 * oldest when the cap is hit. This runs once per terminal pane, so a probe context merely
 * dropped on the floor — alive until GC gets to it — meant opening and closing terminals
 * could push the contexts that real terminals were rendering with out of the cap. Those
 * panes then fall back to the DOM renderer mid-session, which reads as typing going
 * choppy, with nothing logged to explain it.
 */
export function hasHardwareWebgl(): boolean {
  try {
    if (typeof document === 'undefined') return false
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null
    if (!gl) return false
    try {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info')
      const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : ''
      // SwiftShader / llvmpipe / softpipe / ANGLE-software / Microsoft Basic Render are the
      // software rasterizers where the async crash happens. An unknown renderer (host with
      // no debug extension) counts as hardware, which is the behaviour that shipped.
      return !/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(renderer)
    } finally {
      // Hand the context straight back rather than waiting for GC.
      try { gl.getExtension('WEBGL_lose_context')?.loseContext() } catch { /* nothing to release */ }
    }
  } catch {
    return false
  }
}
