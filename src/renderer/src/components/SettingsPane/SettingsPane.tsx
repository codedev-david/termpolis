import { useState, useEffect } from 'react'
import Editor from '@monaco-editor/react'
import { useTerminalStore } from '../../store/terminalStore'
import type { ShellInfo, ShellType } from '../../types'
import { KeybindingsSettings } from './KeybindingsSettings'
import { AgentRatingsSettings } from './AgentRatingsSettings'

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
  const [telemetryOptIn, setTelemetryOptIn] = useState(() => {
    try { return localStorage.getItem('termpolis.telemetry.optIn') === '1' } catch { return false }
  })
  const [appVersion, setAppVersion] = useState<string>('')
  const [updateStatus, setUpdateStatus] = useState<string>('')
  const [updateChecking, setUpdateChecking] = useState(false)

  const handleCheckForUpdates = async () => {
    const updater = (window as any).updater
    if (!updater?.check) {
      setUpdateStatus('Updater unavailable in this build (dev mode?).')
      return
    }
    setUpdateChecking(true)
    setUpdateStatus('Checking…')
    try {
      const res = await updater.check()
      if (!res?.success) {
        setUpdateStatus(`Failed: ${res?.error || 'unknown error'}`)
      }
      // Success: the onState subscription below will report what happened.
    } catch (e) {
      setUpdateStatus(`Failed: ${(e as Error).message || String(e)}`)
    } finally {
      setUpdateChecking(false)
    }
  }

  const toggleTelemetry = () => {
    const next = !telemetryOptIn
    setTelemetryOptIn(next)
    try { localStorage.setItem('termpolis.telemetry.optIn', next ? '1' : '0') } catch {}
    // Mirror to main so Sentry init, updater pings, and feature events
    // all see the new state without a relaunch. Best-effort — preload may
    // not have hot-reloaded in dev.
    try { window.termpolis.setTelemetryOptIn?.(next) } catch {}
  }

  useEffect(() => {
    window.termpolis.getAppVersion?.().then(res => {
      if (res?.success && res.data) setAppVersion(res.data.version)
    }).catch(() => {})
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
    const updater = (window as any).updater
    if (!updater?.onState) return
    const unsub = updater.onState((s: { status: string; version?: string; error?: string }) => {
      if (!s) return
      switch (s.status) {
        case 'checking':
          setUpdateStatus('Checking…')
          break
        case 'available':
          setUpdateStatus(`Update available${s.version ? ` (v${s.version})` : ''} — downloading…`)
          break
        case 'downloading':
          setUpdateStatus(`Downloading update${s.version ? ` v${s.version}` : ''}…`)
          break
        case 'downloaded':
          setUpdateStatus(`Update v${s.version} ready — restart Termpolis to install.`)
          break
        case 'not-available':
          setUpdateStatus('You are on the latest version.')
          break
        case 'error':
          setUpdateStatus(`Update error: ${s.error || 'unknown'}`)
          break
      }
    })
    return () => { try { unsub?.() } catch {} }
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
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Settings</h1>
        <div className="flex items-center gap-3">
          {appVersion && (
            <span
              data-testid="settings-app-version"
              className="text-xs text-[#9ca3af]"
              title="Installed Termpolis version. Auto-update is on by default."
            >
              v{appVersion}
            </span>
          )}
          <button
            data-testid="settings-check-updates"
            onClick={handleCheckForUpdates}
            disabled={updateChecking}
            className="text-xs px-2 py-1 rounded bg-[#2d2d2d] hover:bg-[#3c3c3c] border border-[#3c3c3c] disabled:opacity-60"
            title="Force a check against the GitHub releases feed"
          >
            {updateChecking ? 'Checking…' : 'Check for updates'}
          </button>
        </div>
      </div>
      {updateStatus && (
        <div
          data-testid="settings-update-status"
          className="text-xs text-[#9ca3af] -mt-3"
        >
          {updateStatus}
        </div>
      )}
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
      <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
        <button
          onClick={toggleTelemetry}
          aria-label="Toggle crash reporting"
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 ${
            telemetryOptIn ? 'bg-[#0078d4]' : 'bg-[#555]'
          }`}
        >
          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
            telemetryOptIn ? 'translate-x-4.5' : 'translate-x-0.5'
          }`} />
        </button>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Send anonymous crash reports</span>
          <span className="text-xs text-[#9ca3af] leading-relaxed">
            Error stack traces and the app version only. No terminal contents, file paths, or
            personal data. Takes effect on next launch.
          </span>
        </div>
      </div>
      <KeybindingsSettings />
      <AgentRatingsSettings />
      <div className="flex flex-col gap-2" style={{ minHeight: 400 }}>
        <label className="text-sm font-medium">Shell Config Files</label>
        <div className="flex gap-1 border-b border-[#3c3c3c] pb-1">
          {configFiles.map(f => (
            <button
              key={f.path}
              onClick={() => setActiveFile(f.path)}
              className={`text-sm px-3 py-1 rounded-t ${activeFile === f.path ? 'bg-[#2d2d2d] text-white' : 'text-[#9ca3af] hover:text-white'}`}
            >{f.label}</button>
          ))}
        </div>
        <div className="border border-[#3c3c3c] rounded overflow-hidden" style={{ height: 300 }}>
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
