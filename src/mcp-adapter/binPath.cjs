// Where git is, for the scripts that run in a plain `node` with Termpolis possibly closed (the Commit Shield hook).
//
// The same rules as src/main/binPath.ts, which the app and the world host use: those modules are TypeScript inside
// the bundle, and a script git starts cannot load them, so this is their synchronous twin (the hook is synchronous by
// design). tests/electron/binPathCjsSync.test.ts runs both on the same inputs and fails CI if they ever disagree.
// If that test fails: DO NOT loosen it. Make this file follow binPath.ts.
//
// Why it exists: a program started by its bare name (`git`) is looked for along PATH, and a PATH entry that is
// relative or empty names a folder inside the one the process runs in. The hook runs in the repository being
// committed, so a git planted in that repository would run instead of the real one (and, on Windows, older Node
// releases also looked in the current folder first). git is therefore started by the full path found here.
//
// The rules: only PATH folders fixed on disk count (relative entries, `.` and the current folder are skipped), then
// the known install locations; on Windows only `git.exe` (started without a shell, so a `.cmd` or `.bat` would need
// one); the file must be a regular file this process may run; a git inside the folder it would run in is refused.
// Nothing is started to look: only file checks.

const fs = require('fs')
const path = require('path')

/** A PATH folder that names one place whatever the current folder is: on Windows a drive path (`C:\…`) or a share
 *  (`\\server\…`), never `\tools` or `C:tools`, which hang off the current drive or folder. */
const FIXED_WIN_DIR = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/

/** binPath.ts commandOnPath, synchronously: the full path of `name` in the fixed PATH folders, or null. */
function commandOnPathSync(name, env, platform, runnable, cwd) {
  const win = platform === 'win32'
  const p = win ? path.win32 : path.posix
  const key = (dir) => {
    const n = p.normalize(dir).replace(/[\\/]+$/, '')
    return win ? n.toLowerCase() : n
  }
  const here = cwd === undefined ? null : key(cwd)
  const dirs = (env.PATH ?? env.Path ?? '').replace(/"/g, '').split(win ? ';' : ':')
  for (const dir of dirs) {
    if (!(win ? FIXED_WIN_DIR.test(dir) : p.isAbsolute(dir)) || key(dir) === here) continue
    const file = p.join(dir, win ? name + '.exe' : name)
    try {
      runnable(file)
      return file
    } catch {
      // not in this folder, or not a program this process may run
    }
  }
  return null
}

/** binPath.ts gitInstallCandidates: where git is installed when the PATH does not name it. */
function gitInstallCandidates(platform) {
  return platform === 'win32'
    ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe']
    : ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git', '/bin/git']
}

/** binPath.ts findGit, synchronously: the PATH folders first, then the install locations. Never the bare name. */
function findGitSync(env, platform, runnable, cwd) {
  const onPath = commandOnPathSync('git', env, platform, runnable, cwd)
  if (onPath !== null) return onPath
  for (const candidate of gitInstallCandidates(platform)) {
    try {
      runnable(candidate)
      return candidate
    } catch {
      // not installed here
    }
  }
  return null
}

/** binPath.ts insideFolder: whether `file` lies inside `root`, case-blind with either slash (can only refuse more). */
function insideFolder(file, root) {
  const n = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return n(file).startsWith(n(root) + '/')
}

/** binPath.ts binInside, synchronously: inside as written, or after following links. Unresolvable: as written. */
function binInsideSync(file, root, realpath) {
  if (insideFolder(file, root)) return true
  const real = (p) => {
    try { return realpath(p) } catch { return p }
  }
  return insideFolder(real(file), real(root))
}

/** binPath.ts assertRunnable on the real disk: throws unless `file` is a regular file this process may run. */
function assertRunnableFileSync(file) {
  if (!fs.statSync(file).isFile()) throw new Error('not a file')
  fs.accessSync(file, fs.constants.X_OK)
}

/** The full path of the git to run in `cwd`, or null: none installed, or the one found lies inside `cwd`. */
function gitFor(cwd, env, platform) {
  const bin = findGitSync(env || process.env, platform || process.platform, assertRunnableFileSync, cwd)
  if (bin === null || binInsideSync(bin, cwd, fs.realpathSync.native)) return null
  return bin
}

module.exports = {
  FIXED_WIN_DIR,
  commandOnPathSync,
  gitInstallCandidates,
  findGitSync,
  insideFolder,
  binInsideSync,
  assertRunnableFileSync,
  gitFor,
}
