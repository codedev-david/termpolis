import { collect, type Boundary } from './common'

// ipcMain.* registers a channel (provide); ipcRenderer.* calls one (consume).
const PROVIDE = /\bipcMain\.(?:handle|handleOnce|on|once)\(\s*['"`]([^'"`]+)['"`]/
const CONSUME = /\bipcRenderer\.(?:invoke|send|sendSync)\(\s*['"`]([^'"`]+)['"`]/

export function detectIpc(file: string, text: string): Boundary[] {
  return [
    ...collect(file, text, PROVIDE, (m) => ({ kind: 'ipc', key: m[1], side: 'provide' })),
    ...collect(file, text, CONSUME, (m) => ({ kind: 'ipc', key: m[1], side: 'consume' }))
  ]
}
