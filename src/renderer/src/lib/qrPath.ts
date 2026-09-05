import qrcode from 'qrcode-generator'

/**
 * Encode a payload as a single SVG path over a square module grid.
 *
 * Built by hand rather than with the library's `createSvgTag` so no string ever
 * reaches `dangerouslySetInnerHTML`, and so the whole code renders as one node
 * instead of the ~1,000 `<rect>`s a naive module-per-element render produces.
 *
 * Returns null rather than throwing when the payload will not fit: a caller can
 * offer the raw text instead, which is a worse experience than scanning but a
 * far better one than a dialog that renders an empty box.
 */
export function buildQrPath(payload: string): { d: string; size: number } | null {
  try {
    // Type 0 = pick the smallest version that fits. Level M survives a phone
    // camera held at an angle without inflating the code the way Q or H would.
    const qr = qrcode(0, 'M')
    qr.addData(payload)
    qr.make()
    const size = qr.getModuleCount()
    let d = ''
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`
      }
    }
    return { d, size }
  } catch {
    // Only reachable once the payload outgrows QR version 40.
    return null
  }
}
