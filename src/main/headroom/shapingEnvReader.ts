import { readFile, stat } from 'fs/promises'
import { isAbsolute, join } from 'path'
import { mergeWindowSettings, pickWindowSettings, type ClaudeWindowSettings } from './shapingEnv'

/**
 * Reads the Claude Code settings files that can hold a window of the user's own, so shapingEnv.ts can
 * leave it alone (R3 of the 1.55.0 compression work).
 *
 * Only when the user has turned the context cap on, and only when a Claude terminal is being created. It
 * looks at three files and no others: the user file (settings.json in Claude Code's config folder,
 * which CLAUDE_CONFIG_DIR moves) and the two project files in the folder the terminal opens in. Claude
 * Code reads the project's shared file from that folder and no other, and keeps the local one beside it
 * (on macOS and Linux a local file may instead sit at the root of a git repository above a folder the
 * terminal opens in; that one is not looked at).
 *
 * Of each file it keeps two things, the `env` block and whether a window is saved (autoCompactWindow, or
 * the per-model one /autocompact writes), and drops the rest at once; see pickWindowSettings. It reads
 * through the asynchronous file calls, never writes, and refuses anything that is not a plain file of
 * reasonable size, so a launch is not held up by a disk, a pipe or a file nobody should have made that big.
 * Any file it cannot use counts as holding nothing.
 */

/** A settings file is a few kilobytes. One larger than this is not one a launch should decode. */
export const SETTINGS_FILE_MAX_BYTES = 1024 * 1024

const usableDir = (dir: unknown): dir is string => typeof dir === 'string' && isAbsolute(dir)

/**
 * The files to look at, user scope first. A folder that is not an absolute path contributes nothing: a blank
 * home joined onto a file name would read relative to wherever Termpolis was started from.
 */
export function claudeWindowSettingsFiles(userDir: string, projectDir?: string): string[] {
  return [
    ...(usableDir(userDir) ? [join(userDir, 'settings.json')] : []),
    ...(usableDir(projectDir) ? [join(projectDir, '.claude', 'settings.json'), join(projectDir, '.claude', 'settings.local.json')] : []),
  ]
}

async function readOne(file: string): Promise<ClaudeWindowSettings | null> {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > SETTINGS_FILE_MAX_BYTES) return null
    // An empty file does not parse and so holds nothing, which is what it says.
    return pickWindowSettings(JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')))
  } catch {
    return null
  }
}

/** What the settings files in force say about the window. Never rejects. */
export async function readClaudeWindowSettings(userDir: string, projectDir?: string): Promise<ClaudeWindowSettings> {
  const parts = await Promise.all(claudeWindowSettingsFiles(userDir, projectDir).map(readOne))
  return mergeWindowSettings(parts.filter((part): part is ClaudeWindowSettings => part !== null))
}
