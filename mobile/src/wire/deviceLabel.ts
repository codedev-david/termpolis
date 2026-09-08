/**
 * The one place a label is made safe, on the phone's side of the wire.
 *
 * A deliberate mirror of `src/main/remoteBridge/deviceLabel.ts`: the desktop
 * sanitises the name it announces and the phone sanitises the name it receives,
 * and if the two ever disagreed the result would be a row the desktop believes
 * is one thing and the phone draws as another. `remoteMobileInterop` holds the
 * two copies to the same answers.
 *
 * Two labels reach this app and neither is trustworthy on arrival: the name the
 * desktop sends in its pairing ack, which crosses the relay and so is the
 * sender's choice entirely, and the one the user types over it in the desktop
 * switcher. Both are written to the keystore and drawn in a list.
 */

/** Long enough for "David's Windows box (work)", short enough that one row
 *  cannot push the rest of the switcher off screen -- and short enough that
 *  MAX_PAIRINGS of them still fit comfortably in one SecureStore value. */
export const MAX_DEVICE_LABEL = 64

/** Everything at or below US (0x1f), plus DEL. Written as code points rather
 *  than as escapes in a character class so that this file contains no control
 *  character of its own to be mangled by an editor or a patch. */
const LAST_CONTROL = 0x1f
const DEL = 0x7f

/**
 * Strip, trim and cap a label.
 *
 * Control characters are dropped rather than escaped. React Native's `<Text>`
 * will not act on an escape sequence, so this is not quite the injection the
 * desktop's copy is guarding against -- but the same string is written to the
 * keystore and read back by a later version of this app, and a name carrying a
 * stray NUL is a name that will not survive that round trip intact.
 *
 * Returns `''` when nothing usable survives, rather than a house fallback: the
 * callers want different ones, and a function that picks cannot tell "the
 * desktop announced nothing" from "the user cleared the field".
 */
export function sanitizeDeviceLabel(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  return (
    [...text]
      // Iterated by code point, so an astral character survives whole rather
      // than being judged one surrogate at a time.
      // `charCodeAt` rather than `codePointAt`, because it returns a number for
      // every string and so needs no fallback for a case that cannot happen --
      // `[...text]` never yields an empty item. A surrogate pair is judged by its
      // high surrogate, which is far above the control range, exactly as the
      // desktop's string comparison judges it.
      .filter((c) => c.charCodeAt(0) > LAST_CONTROL && c.charCodeAt(0) !== DEL)
      .join('')
      .trim()
      .slice(0, MAX_DEVICE_LABEL)
      .trim()
  )
}
