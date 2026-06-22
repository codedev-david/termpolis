// Attaches the fastest WORKING xterm renderer, with a graceful fallback ladder:
// WebGL → Canvas → DOM.
//
// Background: xterm 5.x defaults to the DOM renderer, which is the slowest —
// it mutates DOM nodes per cell, so heavy redraws (and the first paint of a
// freshly-mounted terminal) can lag. The WebGL renderer is the fastest but
// needs a live WebGL2 context; if the GPU/driver can't provide one — or the
// context is lost at runtime — it must NOT strand the user on a blank canvas.
// Canvas is a fast, GPU-independent middle tier; the built-in DOM renderer is
// the always-works floor.
//
// We use the version-MATCHED unscoped addons (xterm-addon-webgl /
// xterm-addon-canvas, the 5.3-era releases) rather than the newer scoped
// @xterm/addon-webgl, because the renderer addon hooks xterm's private render
// internals and a core/addon version skew is exactly what blanks the screen.
//
// All addon construction is injected so the ladder is unit-testable without a
// real GPU.

import type { Terminal } from 'xterm'

/** Which renderer xterm ended up using (fastest first). */
export type RendererKind = 'webgl' | 'canvas' | 'dom'

/** Minimal shape of any loadable renderer addon (xterm's ITerminalAddon). */
export interface LoadableRendererAddon {
  dispose(): void
}

/** The WebGL addon additionally lets us react to GPU context loss. */
export interface WebglLikeAddon extends LoadableRendererAddon {
  onContextLoss(handler: (e: unknown) => void): void
}

export interface SetupRendererDeps {
  /** Construct the WebGL addon (fastest tier). Omit to skip WebGL. */
  createWebgl?: () => WebglLikeAddon
  /** Construct the Canvas addon (fast, GPU-independent fallback). Omit to skip. */
  createCanvas?: () => LoadableRendererAddon
  /** Force-skip the GPU (WebGL) tier — e.g. hardware acceleration is disabled. */
  disableGpu?: boolean
  /** Notified when a tier fails and we fall back (for logging/telemetry/tests). */
  onFallback?: (tier: RendererKind, error: unknown) => void
}

/**
 * Attach the fastest working renderer to `term`. `term.open()` MUST have been
 * called first — renderer addons require DOM attachment to acquire a context.
 * Returns the tier actually in use.
 *
 * Each tier's `loadAddon` runs the addon's `activate()`, which throws if the
 * required context can't be created (e.g. WebGL2 unavailable) — that throw is
 * what triggers the fallback. Nothing here re-throws: the DOM renderer is
 * always a valid floor, so terminal creation can never fail because of this.
 */
export function setupTerminalRenderer(term: Terminal, deps: SetupRendererDeps = {}): RendererKind {
  const { createWebgl, createCanvas, disableGpu, onFallback } = deps

  if (!disableGpu && createWebgl) {
    try {
      const webgl = createWebgl()
      // If the GL context is lost at runtime, dispose so xterm reverts to the
      // DOM renderer instead of freezing on a dead canvas.
      webgl.onContextLoss(() => {
        try {
          webgl.dispose()
        } catch {
          /* already disposed */
        }
      })
      term.loadAddon(webgl as never)
      return 'webgl'
    } catch (err) {
      onFallback?.('webgl', err)
    }
  }

  if (createCanvas) {
    try {
      const canvas = createCanvas()
      term.loadAddon(canvas as never)
      return 'canvas'
    } catch (err) {
      onFallback?.('canvas', err)
    }
  }

  return 'dom'
}
