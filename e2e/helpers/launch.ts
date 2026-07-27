/**
 * Shared Electron launch args for e2e specs.
 *
 * Why this exists: 34 of the 52 specs on disk had never been executed by CI, and when
 * the whole directory was finally run every single one of them died at
 * `electron.launch: Process failed to launch!` — not on a stale assertion, but because
 * they launched with `args: [path.resolve('out/main/index.js')]` and nothing else:
 *
 *   - Linux CI runners have no usable sandbox for Electron, so the process exits
 *     immediately without `--no-sandbox`. Every spec CI *did* run already passed it;
 *     the ones it didn't run never learned.
 *   - Without `--user-data-dir` a spec shares the single-instance lock with any other
 *     Termpolis on the box — a developer's running app, or the previous spec still
 *     shutting down — and the second instance quits on startup, which surfaces as the
 *     same opaque launch failure.
 *
 * Centralising it means a new spec inherits both fixes instead of rediscovering them.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Args for `electron.launch()`: the built main entry, a private user-data dir, and
 * `--no-sandbox` on Linux. `label` only shapes the temp dir name so a failed run is
 * traceable to the spec that made it.
 */
export function e2eLaunchArgs(label = 'e2e'): string[] {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `termpolis-${label}-`))
  return [
    path.resolve('out/main/index.js'),
    `--user-data-dir=${userDataDir}`,
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  ]
}
