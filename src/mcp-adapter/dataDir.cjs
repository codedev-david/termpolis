// The ONE place that knows where Termpolis keeps its per-user data. Every adapter (stdio, cli,
// git-hook, memory-primer-hook) runs in a plain `node` process — no Electron, no app.getPath — so
// each used to hardcode this, and they DRIFTED, in ways that only bite on Linux and macOS:
//
//   * termpolis-githook.cjs used the capital-T spelling. The app calls app.setName('termpolis')
//     (lowercase) at startup, so app.getPath('userData') is ".../termpolis". On Windows (NTFS) and
//     macOS (APFS) that resolves case-insensitively, but Linux is case-SENSITIVE: the hook read
//     ~/.config/Termpolis/ai-security-settings.json, which does not exist, failed secure, and left
//     Commit Shield stuck ON with no way to turn it off.
//   * stdio-adapter / termpolis-cli / memory-primer-hook ignored $XDG_CONFIG_HOME. Electron honours
//     it, so a Linux user who sets it has the app write $XDG_CONFIG_HOME/termpolis while the adapter
//     read ~/.config/termpolis — no mcp-token — and every agent got ZERO Termpolis tools, silently.
//
// This mirrors Electron's own userData resolution, with the lowercase app name, on every platform.
const path = require('path')
const os = require('os')

/** Absolute path to Termpolis's per-user data directory, matching app.getPath('userData'). */
function termpolisDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'termpolis')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'termpolis')
  }
  // Linux/other: Electron honours XDG_CONFIG_HOME, defaulting to ~/.config.
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'termpolis')
}

/** A file inside the data dir, e.g. dataFile('mcp-token'). */
function dataFile(name) {
  return path.join(termpolisDataDir(), name)
}

module.exports = { termpolisDataDir, dataFile }
