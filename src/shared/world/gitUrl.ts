// Lumopolis git safety, shared by the clone dialog (live feedback) and the world host (the gate that
// counts): only https://, ssh:// and git@ URLs, nothing that could read as a git option, and branch
// names of plain characters. Pure and ES2020.

export const BAD_URL_MESSAGE = "That doesn't look like a git URL (https://, ssh:// or git@ only)."
export const BAD_REF_MESSAGE = "That branch name isn't valid."

const URL_RE = /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/
const REF_RE = /^[A-Za-z0-9._/-]+$/
const CONTROL_RE = /[\u0000-\u001f\u007f]/

export function validateGitUrl(url: string): { ok: true } | { ok: false; reason: string } {
  if (typeof url !== 'string' || !URL_RE.test(url) || CONTROL_RE.test(url)) return { ok: false, reason: BAD_URL_MESSAGE }
  return { ok: true }
}

/** A branch, tag or commit name git can take as a value, never as an option (no leading '-', no '..'). */
export function validGitRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_RE.test(ref) && !ref.startsWith('-') && !ref.includes('..')
}
