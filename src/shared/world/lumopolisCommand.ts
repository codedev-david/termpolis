// The `lumopolis` shell command's wire format, shared by main (which injects the command into each shell and
// checks what comes back) and the renderer (whose terminal parser catches the sequence).
//
// The command prints one private OSC sequence and nothing else:
//
//   ESC ] 7377 ; lumopolis ; <run nonce> ; <absolute folder> BEL
//
// 7377 is not a number any terminal or shell standard uses, so no other program means anything by it. The nonce
// is a random value main makes once per app run and hands to every shell it starts (LUMOPOLIS_NONCE_ENV): a file
// someone cats, or a web page an agent prints, cannot know it, so it cannot open Lumopolis on a folder of its
// choosing. The folder is everything after the third field, so a path may contain `;`.

/** The OSC number the terminal parser registers for. */
export const LUMOPOLIS_OSC = 7377

/** The first field of the payload: names the request. */
export const LUMOPOLIS_TAG = 'lumopolis'

/** The environment variable every Termpolis shell gets the run's nonce in. */
export const LUMOPOLIS_NONCE_ENV = 'TERMPOLIS_LUMOPOLIS_NONCE'

/** A payload longer than this is refused unread: no real folder path comes near it. */
export const LUMOPOLIS_MAX_PAYLOAD = 4096

/** The nonce's shape: 32 lowercase hex characters (16 random bytes). */
export const LUMOPOLIS_NONCE_RE = /^[0-9a-f]{32}$/

export interface LumopolisRequest {
  nonce: string
  /** The folder as the shell printed it: absolute in every shell's own dialect (MSYS, Windows, POSIX). */
  path: string
}

/**
 * Reads an OSC 7377 payload (the text after `7377;`). Null for anything that is not exactly a lumopolis request:
 * too long, another tag, a nonce of the wrong shape, an empty folder or one with control characters in it.
 */
export function parseLumopolisPayload(payload: unknown): LumopolisRequest | null {
  if (typeof payload !== 'string' || payload.length > LUMOPOLIS_MAX_PAYLOAD) return null
  const first = payload.indexOf(';')
  if (first < 0 || payload.slice(0, first) !== LUMOPOLIS_TAG) return null
  const second = payload.indexOf(';', first + 1)
  if (second < 0) return null
  const nonce = payload.slice(first + 1, second)
  const path = payload.slice(second + 1)
  if (!LUMOPOLIS_NONCE_RE.test(nonce)) return null
  if (path.trim() === '' || /[\u0000-\u001f\u007f]/.test(path)) return null
  return { nonce, path }
}

/** The sequence a shell prints for `path` (what the injected functions produce; the tests compare against it). */
export function lumopolisSequence(nonce: string, path: string): string {
  return `\x1b]${LUMOPOLIS_OSC};${LUMOPOLIS_TAG};${nonce};${path}\x07`
}

/** The one line a shell function prints for a folder that does not exist (before it emits anything). */
export const lumopolisNoSuchFolder = (path: string): string => `lumopolis: no such folder: ${path}`
