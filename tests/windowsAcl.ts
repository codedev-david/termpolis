/**
 * Reading a Windows file's ACL the way the lockdown tests need it. Shared by
 * tests/electron/secureFile.integration.test.ts and e2e/workspace-trust.spec.ts, so the property
 * they hold the app to is written once.
 *
 * The listing (`icacls <path>`) alone is a poor witness. Piped, icacls writes the OEM code page,
 * so a non-ASCII account name does not survive a UTF-8 decode; and its group names are localized,
 * so an English-only check passes on a German Windows without testing anything. The SDDL that
 * `icacls /save` exports names principals by SID and carries the DACL's own flags, so it reads the
 * same on every machine.
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export function aclListing(path: string): string {
  return execFileSync('icacls', [path], { encoding: 'utf-8', shell: false, windowsHide: true })
}

/** The file's DACL as SDDL, e.g. "D:PAI(A;;FA;;;SY)". `icacls /save` is a read-only export:
 *  UTF-16LE, the file's name on line 1 and its SDDL on line 2. */
export function daclSddl(path: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tp-acl-'))
  try {
    const out = join(dir, 'acl')
    execFileSync('icacls', [path, '/save', out], { stdio: 'pipe', shell: false, windowsHide: true })
    return readFileSync(out).toString('utf16le').replace(/^\uFEFF/, '').split(/\r?\n/)[1] ?? ''
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Each ACE's trustee (a SID, or an alias such as SY or LS) and its flags (OI, CI, ID...). */
export function daclAces(sddl: string): { trustee: string; flags: string[] }[] {
  return [...sddl.matchAll(/\(([^)]*)\)/g)].map(([, ace]) => {
    const fields = ace.split(';')
    return { trustee: fields[5] ?? '', flags: fields[1].match(/../g) ?? [] }
  })
}

/** `user` holding full control, as the listing shows it. A run of non-ASCII letters matches
 *  loosely: through the OEM code page "José" can come back as "Jos" plus a replacement mark. */
export function fullControlPattern(user: string): RegExp {
  const name = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\u0080-\uffff]+/g, '[^\\s:\\\\]+')
  return new RegExp(`[\\s\\\\]${name}:\\(F\\)`, 'i')
}

// Everyone, BUILTIN\Users and Authenticated Users, by their SDDL aliases.
const BROAD_AUDIENCE = new Set(['WD', 'BU', 'AU'])

/**
 * What stops `path` from counting as locked to `user`, or [] when nothing does:
 *  - the lockdown ran: the DACL is protected ("D:P"). icacls /inheritance:r always sets that, and a
 *    file Windows has just created never has it. Nothing else tells a locked file from one born in
 *    a folder that passes nothing down, whose ACEs are all explicit too: there every other check
 *    below passes with no lockdown at all;
 *  - nothing is inherited: no ACE carries ID. Read from the SDDL, not the listing: where a DACL lacks
 *    the auto-inherited flag (AI), icacls lists an ID ACE without "(I)";
 *  - no broad audience: no Everyone, BUILTIN\Users or Authenticated Users ACE;
 *  - the user holds full control.
 *
 * SYSTEM and Administrators MAY remain, because the app's one icacls call leaves the ACEs it counts
 * as explicit alone, by design: both can read every file on the machine anyway, and a Termpolis
 * child process stripping them at every boot is the permission change endpoint monitors flag. A
 * file born in a folder that passes nothing inheritable gets them from the creating token's default
 * DACL. On a GitHub Windows runner, TEMP's DACL lacks AI: a file made under it inherits SYSTEM,
 * Administrators and the user as ID ACEs, which icacls neither lists as "(I)" nor drops with
 * /inheritance:r. It keeps them as explicit ACEs.
 */
export function lockdownProblems(path: string, user: string): string[] {
  const sddl = daclSddl(path)
  const aces = daclAces(sddl)
  const listing = aclListing(path)
  const problems: string[] = []
  if (!sddl.startsWith('D:P')) problems.push(`the DACL is not protected, so the lockdown never ran: ${sddl}`)
  if (aces.some((a) => a.flags.includes('ID'))) problems.push(`an inherited ACE survived: ${sddl}`)
  if (aces.some((a) => BROAD_AUDIENCE.has(a.trustee))) problems.push(`a broad audience can read it: ${sddl}`)
  if (!fullControlPattern(user).test(listing)) problems.push(`${user} does not hold full control:\n${listing}`)
  return problems
}
