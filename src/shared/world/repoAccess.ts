// How a person opens a private repository in Lumopolis, and the checks on a token they paste.
//
// A token is used for one run of git and then dropped: it reaches git through the environment of that
// one run and the askpass Termpolis ships (src/main/world/gitLogin.ts), never a command line, a file or
// a log. Everything git says back during such a run passes through `hideValue` before anyone sees it.

import { redactSecrets } from '../appLog'

/** What the renderer asks for. A `machine` request from a person is always interactive. */
export type RepoAccess = { mode: 'machine' } | { mode: 'token'; value: string }

/** What the registry keeps about how a repository was opened. Never the token itself. */
export type RepoLogin = 'machine' | 'token'

/** What an https clone that needed a sign-in hands back: the host to sign in to, and whether git has a login helper for it. */
export interface NeedsLogin {
  host: string
  helper: boolean
}

/** What main answers (as success) when opening or updating a repository needs a sign-in first:
 *  the host, whether git has a login helper for it, and the plain words to show. */
export type CloneNeedsLogin = { needsLogin: NeedsLogin & { message: string } }

export const TOKEN_FORMAT_MESSAGE = 'That token has a space or line break inside it. Copy it again and paste only the token.'
export const TOKEN_EMPTY_MESSAGE = 'Paste a token first.'
export const TOKEN_REJECTED_MESSAGE = "That token didn't open the repository. Check that it hasn't expired and can read this repository, then try again."
export const TOKEN_TOO_LONG_MESSAGE = 'That is longer than any token. Copy it again and paste only the token.'

/** Longer than any token a forge issues; a paste past this is a mistake, not a token. */
export const TOKEN_MAX_LENGTH = 4096

// Whitespace or a control character. Left inside a trimmed paste it means two things were copied.
const INSIDE = /[\s\x00-\x1f\x7f]/

/** Trim a pasted token and refuse one that cannot be a token. Anything that is not text counts as empty. */
export function normalizeToken(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return { ok: false, error: TOKEN_EMPTY_MESSAGE }
  if (INSIDE.test(value)) return { ok: false, error: TOKEN_FORMAT_MESSAGE }
  if (value.length > TOKEN_MAX_LENGTH) return { ok: false, error: TOKEN_TOO_LONG_MESSAGE }
  return { ok: true, value }
}

/** Replace every copy of `value` in `text` with `[hidden]` (literally, never as a pattern), then redact
 *  anything else shaped like a key, as the app log does. An empty value hides nothing. */
export function hideValue(text: string, value: string): string {
  const hidden = value ? text.split(value).join('[hidden]') : text
  return redactSecrets(hidden)
}
