import React, { useState, useEffect } from 'react'
import Editor from '@monaco-editor/react'
import { useTerminalStore } from '../../store/terminalStore'
import type { ShellInfo, ShellType } from '../../types'
import { KeybindingsSettings } from './KeybindingsSettings'

function getConfigFiles(home: string): { label: string; path: string; lang: string }[] {
  const isWin = /^[A-Za-z]:\\/.test(home)
  const sep = isWin ? '\\' : '/'
  const files: { label: string; path: string; lang: string }[] = []

  if (isWin) {
    files.push(
      { label: 'PS7 Profile', path: `${home}${sep}Documents${sep}PowerShell${sep}Microsoft.PowerShell_profile.ps1`, lang: 'powershell' },
      { label: 'PS5 Profile', path: `${home}${sep}Documents${sep}WindowsPowerShell${sep}Microsoft.PowerShell_profile.ps1`, lang: 'powershell' },
    )
  }
  files.push(
    { label: '.bashrc', path: `${home}${sep}.bashrc`, lang: 'shell' },
    { label: '.bash_profile', path: `${home}${sep}.bash_profile`, lang: 'shell' },
    { label: '.zshrc', path: `${home}${sep}.zshrc`, lang: 'shell' },
  )
  return files
}

export function SettingsPane() {
  const { defaultShell, setDefaultShell, autocompleteEnabled, setAutocompleteEnabled } = useTerminalStore()
  const [shells, setShells] = useState<ShellInfo[]>([])
  const [configFiles, setConfigFiles] = useState<{ label: string; path: string; lang: string }[]>([])
  const [activeFile, setActiveFile] = useState('')
  const [fileContents, setFileContents] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState<Record<string, boolean>>({})

  useEffect(() => {
    window.termpolis.getAvailableShells().then(res => {
      if (res.success && res.data) setShells(res.data)
    })
    window.termpolis.getHomedir().then(res => {
      if (!res.success || !res.data) return
      const files = getConfigFiles(res.data)
      setConfigFiles(files)
      setActiveFile(files[0].path)
      files.forEach(f => {
        window.termpolis.readConfigFile(f.path).then(r => {
          setFileContents(prev => ({ ...prev, [f.path]: r.data ?? '' }))
        })
      })
    })
  }, [])

  const handleSave = async (filePath: string) => {
    setSaving(prev => ({ ...prev, [filePath]: true }))
    await window.termpolis.writeConfigFile(filePath, fileContents[filePath] ?? '')
    setSaving(prev => ({ ...prev, [filePath]: false }))
    setSaved(prev => ({ ...prev, [filePath]: true }))
    setTimeout(() => setSaved(prev => ({ ...prev, [filePath]: false })), 2000)
  }

  return (
    <div className="flex flex-col h-full p-6 gap-6 overflow-y-auto bg-[#1e1e1e]">
      <h1 className="text-lg font-semibold">Settings</h1>
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Default Shell</label>
        <select
          value={defaultShell}
          onChange={e => setDefaultShell(e.target.value as ShellType)}
          className="bg-[#2d2d2d] border border-[#3c3c3c] rounded px-2 py-1 text-sm w-48 focus:outline-none"
        >
          {shells.map(s => <option key={s.type} value={s.type}>{s.label}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium">Enable Autocomplete</label>
        <button
          onClick={() => setAutocompleteEnabled(!autocompleteEnabled)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            autocompleteEnabled ? 'bg-[#0078d4]' : 'bg-[#555]'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              autocompleteEnabled ? 'translate-x-4.5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
      <KeybindingsSettings />
      <div className="flex flex-col gap-2 flex-1 min-h-0">
        <div className="flex gap-1 border-b border-[#3c3c3c] pb-1">
          {configFiles.map(f => (
            <button
              key={f.path}
              onClick={() => setActiveFile(f.path)}
              className={`text-sm px-3 py-1 rounded-t ${activeFile === f.path ? 'bg-[#2d2d2d] text-white' : 'text-[#6b7280] hover:text-white'}`}
            >{f.label}</button>
          ))}
        </div>
        <div className="flex-1 min-h-0 border border-[#3c3c3c] rounded overflow-hidden">
          {activeFile && (
            <Editor
              height="100%"
              language={configFiles.find(f => f.path === activeFile)?.lang ?? 'shell'}
              theme="vs-dark"
              value={fileContents[activeFile] ?? ''}
              onChange={val => setFileContents(prev => ({ ...prev, [activeFile]: val ?? '' }))}
              options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false }}
            />
          )}
        </div>
        <div className="flex justify-end">
          <button
            onClick={() => handleSave(activeFile)}
            disabled={saving[activeFile] || !activeFile}
            className="px-4 py-1.5 text-sm rounded bg-[#0078d4] hover:bg-[#106ebe] text-white disabled:opacity-50"
          >{saved[activeFile] ? '✓ Saved' : saving[activeFile] ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}
