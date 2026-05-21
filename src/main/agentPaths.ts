// Extra PATH discovery for AI-agent CLIs (claude/codex/gemini/qwen).
//
// Why this module exists:
//   Electron GUI launches on macOS inherit launchd's minimal PATH (no
//   .zshrc, no nvm.sh sourcing). Terminals spawned from Start Menu/Desktop
//   on Windows hit the same problem with %AppData%\npm. The result is that
//   `which gemini` returns nothing even though the user has it installed —
//   that was issue #8 ("Codex and Gemini CLI not recognized in NVM/custom
//   PATH environments on macOS").
//
// Strategy is layered:
//   1. A static list of well-known install dirs (Homebrew, ~/.local/bin,
//      Volta/asdf/n/yarn/npm-global/bun).
//   2. Dynamic enumeration of NVM's per-version dirs.
//   3. fnm enumeration when FNM_DIR is exported.
//   4. Fork the user's interactive shell once per process and grab its
//      PATH — picks up anything dotfiles add (custom bin dirs, asdf shims,
//      direnv, etc.) that the static list misses.
//
// Lives in its own file so the platform-specific branches can be tested
// with `Object.defineProperty(process, 'platform', ...)` without dragging
// the whole Electron main module through resetModules.

import { execSync } from 'child_process'
import { readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Interactive-shell PATH discovery forks a shell (~50–200ms), so cache the
// result for the lifetime of the process — PATH doesn't change at runtime.
let _cachedShellPath: string | null = null

// Test hook: lets each test exercise the fresh-cache code path without
// dragging the whole main module through resetModules.
export function __resetShellPathCacheForTests(): void {
  _cachedShellPath = null
}

// Fork the user's interactive shell and capture its PATH. Closes the gap
// from issue #8 on macOS where GUI-launched Electron has no nvm/asdf/etc.
// Windows shells don't have this problem (PATH is global), so we short-
// circuit there.
export function getInteractiveShellPath(): string {
  if (_cachedShellPath !== null) return _cachedShellPath
  if (process.platform === 'win32') {
    _cachedShellPath = ''
    return _cachedShellPath
  }
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    // -i sources rc files (.zshrc/.bashrc — nvm/asdf init lives here);
    // -l sources login files (.zprofile/.bash_profile).
    // The sentinel marker lets us strip banner output that interactive
    // shells sometimes print on -i.
    const out = execSync(`${shell} -ilc 'printf "TERMPOLIS_PATH_BEGIN:%s\\n" "$PATH"'`, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    })
    const m = out.match(/TERMPOLIS_PATH_BEGIN:(.*)/)
    _cachedShellPath = m ? m[1].trim() : ''
  } catch {
    _cachedShellPath = ''
  }
  return _cachedShellPath
}

// Static + dynamic install dirs for agent CLIs. Order matters — Homebrew
// first so brew-installed binaries win over older system copies, then
// user-local, then version managers.
export function getAgentExtraPaths(): string[] {
  const home = homedir()
  if (process.platform === 'win32') {
    return [
      join(home, 'AppData', 'Roaming', 'npm'),                      // npm global (claude, codex)
      join(home, 'AppData', 'Local', 'pnpm'),                       // pnpm global
      join(home, 'AppData', 'Local', 'Google', 'Cloud SDK', 'bin'), // gemini via gcloud
    ]
  }
  const paths: string[] = [
    '/opt/homebrew/bin',                // macOS Apple Silicon Homebrew
    '/usr/local/bin',                   // macOS Intel Homebrew / generic
    join(home, '.local', 'bin'),        // pip --user, cargo, generic
    join(home, '.volta', 'bin'),        // Volta
    join(home, '.asdf', 'shims'),       // asdf
    join(home, 'n', 'bin'),             // n
    join(home, '.yarn', 'bin'),         // yarn global
    join(home, '.npm-global', 'bin'),   // common `npm config set prefix` target
    join(home, '.bun', 'bin'),          // bun
  ]
  // NVM lives at ~/.nvm/versions/node/<v>/bin per installed Node version.
  // Gemini installed via `npm i -g` under NVM was the core of issue #8.
  try {
    const nvmRoot = process.env.NVM_DIR || join(home, '.nvm')
    const versionsDir = join(nvmRoot, 'versions', 'node')
    for (const ver of readdirSync(versionsDir)) {
      paths.push(join(versionsDir, ver, 'bin'))
    }
  } catch {
    // No NVM installed, or versions dir doesn't exist — just skip.
  }
  // fnm exports FNM_DIR with the install root; per-version dirs live under
  // node-versions/<v>/installation/bin. We can only see this when fnm has
  // exported into the shell that launched Electron.
  if (process.env.FNM_DIR) {
    try {
      const versionsDir = join(process.env.FNM_DIR, 'node-versions')
      for (const ver of readdirSync(versionsDir)) {
        paths.push(join(versionsDir, ver, 'installation', 'bin'))
      }
    } catch {
      // FNM_DIR set but layout doesn't match — skip.
    }
  }
  return paths
}

// Build a complete PATH for agent detection. Order: our known dirs first
// (deterministic), then the user's interactive-shell PATH (catches
// dotfile-driven additions), then the current process PATH last.
export function getExtendedPath(): string {
  const currentPath = process.env.PATH || ''
  const shellPath = getInteractiveShellPath()
  const sep = process.platform === 'win32' ? ';' : ':'
  return [...getAgentExtraPaths(), shellPath, currentPath].filter(Boolean).join(sep)
}
