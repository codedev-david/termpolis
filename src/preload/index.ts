import { contextBridge, ipcRenderer } from 'electron'
import type { TermpolisAPI, ShellType } from '../renderer/src/types'

const api: TermpolisAPI = {
  createTerminal: (id, shellType, cwd) =>
    ipcRenderer.invoke('terminal:create', { id, shellType, cwd }),

  killTerminal: (id) =>
    ipcRenderer.invoke('terminal:kill', { id }),

  writeToTerminal: (id, data) =>
    ipcRenderer.send('terminal:write', { id, data }),

  resizeTerminal: (id, cols, rows) =>
    ipcRenderer.send('terminal:resize', { id, cols, rows }),

  onTerminalData: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, id: string, data: string) => cb(id, data)
    ipcRenderer.on('terminal:data', handler)
    return () => ipcRenderer.removeListener('terminal:data', handler)
  },

  getAvailableShells: () =>
    ipcRenderer.invoke('shell:available'),

  readConfigFile: (filePath) =>
    ipcRenderer.invoke('config:read', { filePath }),

  writeConfigFile: (filePath, content) =>
    ipcRenderer.invoke('config:write', { filePath, content }),

  appendHistory: (terminalId, terminalName, command) =>
    ipcRenderer.send('history:append', { terminalId, terminalName, command }),

  searchHistory: (query) =>
    ipcRenderer.invoke('history:search', { query }),

  getHomedir: () =>
    ipcRenderer.invoke('fs:homedir'),

  loadSession: () =>
    ipcRenderer.invoke('session:load'),

  saveSession: (data) =>
    ipcRenderer.send('session:save', data),
}

contextBridge.exposeInMainWorld('termpolis', api)
