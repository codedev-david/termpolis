/**
 * An element's box on screen, in the page's own pixels, whatever CSS zoom it sits under.
 *
 * Chromium from 128 on (standard CSS zoom) already measures getBoundingClientRect on screen and has
 * `currentCSSZoom`. An older Chromium measures a zoomed element, and everything inside it, in the
 * zoomed box's own pixels: its box is scaled back up here by the zoom it is under (its own and every
 * ancestor's), so the panels drawn bigger on a big monitor are kept clear of at their real size.
 */
export function screenRect(el: Element): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
  const r = el.getBoundingClientRect()
  let z = 1
  if (typeof (el as unknown as { currentCSSZoom?: unknown }).currentCSSZoom !== 'number') {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const own = parseFloat(getComputedStyle(e).zoom)
      if (own > 0) z *= own
    }
  }
  return { left: r.left * z, top: r.top * z, right: r.right * z, bottom: r.bottom * z, width: r.width * z, height: r.height * z }
}
