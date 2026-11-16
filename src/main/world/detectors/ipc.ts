import { collect, type Boundary } from './common'

// ipcMain.* registers a channel (provide); ipcRenderer.* calls one (consume).
const PROVIDE = /\bipcMain\.(?:handle|handleOnce|on|once)\(\s*['"`]([^'"`]+)['"`]/
const CONSUME = /\bipcRenderer\.(?:invoke|send|sendSync)\(\s*['"`]([^'"`]+)['"`]/
// The preload bridge: contextBridge.exposeInMainWorld('api', ...) provides `window.api` to the page,
// and a page reading `window.api` consumes it. The key is `window.<name>` so a bridge never pairs
// with a channel. Reads of names nothing exposes (window.location, ...) are dropped by groupProject.
const BRIDGE_PROVIDE = /\bcontextBridge\.exposeInMainWorld\(\s*['"`]([A-Za-z_$][\w$]*)['"`]/
const BRIDGE_CONSUME = /(?<![\w$.])window\.([A-Za-z_$][\w$]*)/

/** Prefix of a preload-bridge ipc key. */
export const BRIDGE_PREFIX = 'window.'

export function detectIpc(file: string, text: string): Boundary[] {
  return [
    ...collect(file, text, PROVIDE, (m) => ({ kind: 'ipc', key: m[1], side: 'provide' })),
    ...collect(file, text, CONSUME, (m) => ({ kind: 'ipc', key: m[1], side: 'consume' })),
    ...collect(file, text, BRIDGE_PROVIDE, (m) => ({ kind: 'ipc', key: BRIDGE_PREFIX + m[1], side: 'provide' })),
    ...firstPerKey(collect(file, text, BRIDGE_CONSUME, (m) => ({ kind: 'ipc', key: BRIDGE_PREFIX + m[1], side: 'consume' })))
  ]
}

/** One boundary per key (its first line): a page reads its bridge hundreds of times. */
function firstPerKey(list: Boundary[]): Boundary[] {
  const seen = new Set<string>()
  return list.filter((b) => !seen.has(b.key) && seen.add(b.key))
}
