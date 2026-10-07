// sudoAskpass.ts
//
// Lets an AI agent in a Termpolis terminal run a command as administrator, with the user's say-so.
//
// An agent runs its commands without a terminal to type a password into, so plain sudo fails:
// sudo-rs (Ubuntu's sudo since 25.10) reads a password only from a terminal unless it is given -A,
// and macOS's sudo does the same unless DISPLAY is set. With -A, sudo runs the program named by
// SUDO_ASKPASS and reads the password from its output. Termpolis points SUDO_ASKPASS at the helper
// below, which shows the user the command that is about to run and asks for the password in a
// dialog, and tells its agents to use `sudo -A`.
//
// The helper prints the password, so it refuses to run unless its parent is sudo running as root:
// an agent that simply runs it gets nothing. That is not a defense against a hostile program
// running as the user. Such a program can point SUDO_ASKPASS at a wrapper of its own, which sudo
// starts and which hands the real helper an output it reads, or it can show a lookalike dialog.
// What protects the user is the dialog itself: it shows the whole command about to run, and the
// user decides whether to type the password.

import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

/** Told to every agent Termpolis launches where the helper is installed. Shell-safe on purpose:
 *  Codex receives it inside a quoted command-line argument (isShellSafeInstruction). */
export const SUDO_AGENT_HINT =
  'To run a command as administrator, use sudo -A: Termpolis shows the user a password dialog.'

export const ASKPASS_DIR = 'askpass'
export const ASKPASS_FILE = 'sudo-askpass'

/** POSIX sh, so it runs wherever sudo does. Linux tries zenity, kdialog, then the ssh-askpass
 *  family; macOS uses osascript, which every Mac has. */
export const ASKPASS_SCRIPT = `#!/bin/sh
# Termpolis: the password dialog for sudo -A (SUDO_ASKPASS).
# Termpolis rewrites this file every time it starts; edits to it are not kept.
refuse() {
  echo "termpolis-askpass: only sudo may ask for your password here" >&2
  exit 1
}
ppid=$PPID
case "$(uname -s)" in
  Linux)
    os=linux
    parent=$(cat "/proc/$ppid/comm" 2>/dev/null)
    euid=$(awk '/^Uid:/ { print $3 }' "/proc/$ppid/status" 2>/dev/null)
    cmdline=$(tr '\\000' ' ' < "/proc/$ppid/cmdline" 2>/dev/null)
    ;;
  Darwin)
    os=mac
    parent=$(ps -o comm= -p "$ppid" 2>/dev/null)
    parent=\${parent##*/}
    euid=$(ps -o uid= -p "$ppid" 2>/dev/null | tr -d ' ')
    cmdline=$(ps -o args= -p "$ppid" 2>/dev/null)
    ;;
  *) refuse ;;
esac
case "$parent" in
  sudo|sudo-rs) ;;
  *) refuse ;;
esac
[ "$euid" = 0 ] || refuse
# Control characters, newlines among them, become spaces so a command can't lay out the dialog's
# text; so do non-ASCII bytes, so it can't reorder it either. Nothing is cut: a command too long
# to show whole is refused, never shown in part.
cmdline=$(printf '%s' "$cmdline" | LC_ALL=C tr -c '[:print:]' '[ *]')
if [ "\${#cmdline}" -gt 1000 ]; then
  echo "termpolis-askpass: this command is too long to show in full, so Termpolis won't ask for your password for it." >&2
  echo "Run it yourself in a terminal, or split it into shorter commands." >&2
  exit 1
fi
title="Termpolis: administrator password"
text="A command in Termpolis wants to run as administrator:

$cmdline

Enter your password only if you expected this."
if [ "$os" = mac ]; then
  exec osascript \\
    -e 'on run argv' \\
    -e 'activate' \\
    -e 'set r to display dialog (item 1 of argv) with title (item 2 of argv) default answer "" with hidden answer with icon caution buttons {"Cancel", "OK"} default button "OK" giving up after 120' \\
    -e 'if gave up of r then error number -128' \\
    -e 'return text returned of r' \\
    -e 'end run' \\
    "$text" "$title"
fi
if command -v zenity >/dev/null 2>&1; then
  markup=$(printf '%s' "$text" | sed -e 's/&/\\&amp;/g' -e 's/</\\&lt;/g' -e 's/>/\\&gt;/g')
  exec zenity --entry --hide-text --title="$title" --text="$markup" --timeout=120
fi
if command -v kdialog >/dev/null 2>&1; then
  exec kdialog --title "$title" --password "$text"
fi
for helper in ssh-askpass ksshaskpass lxqt-openssh-askpass /usr/lib/ssh/ssh-askpass \\
  /usr/libexec/openssh/ssh-askpass /usr/lib/openssh/gnome-ssh-askpass /usr/libexec/openssh/gnome-ssh-askpass; do
  case "$helper" in
    /*) [ -x "$helper" ] && exec "$helper" "$text" ;;
    *) command -v "$helper" >/dev/null 2>&1 && exec "$helper" "$text" ;;
  esac
done
echo "termpolis-askpass: no password dialog is installed (zenity, kdialog or ssh-askpass)." >&2
echo "Run the command yourself in a Termpolis terminal instead." >&2
exit 1
`

let installedPath: string | null = null

/** Where sudo -A finds the helper in this session, or null where there is none. */
export function sudoAskpassPath(): string | null {
  return installedPath
}

export interface AskpassFs {
  mkdir: (dir: string) => void
  write: (file: string, text: string) => void
  chmod: (file: string, mode: number) => void
  rename: (from: string, to: string) => void
}

const realFs: AskpassFs = {
  mkdir: (dir) => mkdirSync(dir, { recursive: true, mode: 0o700 }),
  write: (file, text) => writeFileSync(file, text, { mode: 0o700 }),
  chmod: (file, mode) => chmodSync(file, mode),
  rename: (from, to) => renameSync(from, to),
}

/**
 * Write the helper into userData and remember where it is. Linux and macOS only: Windows has no
 * sudo -A. Rewritten on every launch, so it is always this version's copy, and replaced by rename
 * so a sudo running at that moment never finds it half-written. Null when it can't be written:
 * Termpolis then leaves SUDO_ASKPASS alone and doesn't tell agents about it.
 */
export function installSudoAskpass(
  userDataPath: string,
  platform: NodeJS.Platform = process.platform,
  fs: AskpassFs = realFs,
): string | null {
  installedPath = null
  if (platform !== 'linux' && platform !== 'darwin') return null
  try {
    const dir = join(userDataPath, ASKPASS_DIR)
    fs.mkdir(dir)
    const file = join(dir, ASKPASS_FILE)
    const tmp = `${file}.tmp`
    fs.write(tmp, ASKPASS_SCRIPT)
    fs.chmod(tmp, 0o700) // write's mode applies only when it creates the file
    fs.rename(tmp, file)
    installedPath = file
  } catch {
    installedPath = null
  }
  return installedPath
}

/** SUDO_ASKPASS for a terminal's environment. A helper the user set up themselves is kept. */
export function sudoAskpassEnv(
  helper: string | null = installedPath,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return helper && !inherited.SUDO_ASKPASS ? { SUDO_ASKPASS: helper } : {}
}
