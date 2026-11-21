// Lumopolis git safety, shared by the clone dialog (live feedback) and the world host (the gate that
// counts): only https://, ssh:// and git@ URLs, nothing that could read as a git option, and branch
// names of plain characters. Pure and ES2020.

export const BAD_URL_MESSAGE = "That doesn't look like a git URL (https://, ssh:// or git@ only)."
export const BAD_REF_MESSAGE = "That branch name isn't valid."

const URL_RE = /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/
const REF_RE = /^[A-Za-z0-9._/-]+$/
const CONTROL_RE = /[\u0000-\u001f\u007f]/
// A host that starts with '-' reaches ssh as an option (ssh://-oProxyCommand=..., git@-o...), so it is
// refused even though git itself also guards it. Matches the host position after any user@ part.
const DASH_HOST_RE = /^(?:(?:https|ssh):\/\/(?:[^\s/@]*@)?|git@)-/

export function validateGitUrl(url: string): { ok: true } | { ok: false; reason: string } {
  if (typeof url !== 'string' || !URL_RE.test(url) || CONTROL_RE.test(url) || DASH_HOST_RE.test(url)) return { ok: false, reason: BAD_URL_MESSAGE }
  return { ok: true }
}

// The user-info part of an https URL (https://name:secret@host/...): what a private-repository URL
// carries to sign in. It reaches git for the clone, and nowhere else. It runs to the last @ before the
// host part ends (at a /, ? or #), so what is left starts at the host and a second strip changes nothing.
const HTTPS_USERINFO_RE = /^(https:\/\/)[^\s/?#]*@/i

/** The URL with any https user-info removed, as it may be stored or shown; anything else unchanged. */
export function stripUrlUserinfo(url: string): string {
  return url.replace(HTTPS_USERINFO_RE, '$1')
}

/** A branch, tag or commit name git can take as a value, never as an option (no leading '-', no '..'). */
export function validGitRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_RE.test(ref) && !ref.startsWith('-') && !ref.includes('..')
}
