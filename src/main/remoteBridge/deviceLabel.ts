/**
 * The one place a device label is made safe.
 *
 * Two labels reach the device list and neither is trustworthy on arrival: the
 * one the desktop user types into Settings, and the one the phone sends in its
 * pairing hello. The second is the dangerous one -- it crosses the relay, so its
 * length and its bytes are entirely the sender's choice -- and it is the one
 * that ends up persisted in `remote-devices.json` and drawn beside a live
 * terminal.
 *
 * This lives under `remoteBridge/` rather than beside the IPC layer because the
 * bridge runs in a utilityProcess that cannot import anything Electron-shaped.
 * Both halves share it, so neither can drift into trusting its input.
 */

/** Long enough for "David's iPhone 16 Pro Max (work)", short enough that a
 *  device row cannot push the rest of the table off screen. */
export const MAX_DEVICE_LABEL = 64

/**
 * Strip, trim and cap a label.
 *
 * Control characters are dropped rather than escaped: the label is echoed into
 * the device list beside a live terminal, and an embedded escape sequence there
 * is a way to redraw a pane the label has no business touching.
 *
 * Returns `''` when nothing usable survives, rather than a house fallback --
 * the two call sites want different ones, and a function that picks for them
 * cannot tell "the user typed nothing" from "the user typed Phone".
 */
export function sanitizeDeviceLabel(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  return (
    [...text]
      // Compared as strings so an astral character survives whole: `[...text]`
      // yields the surrogate pair, and its high surrogate sorts well above the
      // control range.
      .filter((c) => c > '\u001f' && c !== '\u007f')
      .join('')
      .trim()
      .slice(0, MAX_DEVICE_LABEL)
      .trim()
  )
}
