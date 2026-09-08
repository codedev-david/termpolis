import { hostname } from 'os'
import { sanitizeDeviceLabel } from './deviceLabel'

/**
 * What this machine calls itself, for the phone's desktop list.
 *
 * A phone may now be paired with several desktops at once, and the switcher on
 * it is a list of names. Asking the user to type one on the desktop before every
 * pairing would be a form in front of a QR code; taking the hostname gets
 * "DAVID-DESKTOP" and "ubuntu-vm" right without asking, and the phone can rename
 * either one afterwards.
 *
 * The read is injectable and guarded because `os.hostname()` is a syscall, and
 * on a container with no configured name it can fail. A pairing must not fall
 * over on the way to fetching a caption for it.
 */
export function localDesktopName(read: () => string = hostname): string {
  try {
    return sanitizeDeviceLabel(read())
  } catch {
    // Empty, not a house name: `sealPairingAck` omits the field entirely when
    // there is nothing to say, and the phone then names the desktop itself.
    return ''
  }
}
