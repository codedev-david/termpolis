import { useState, useEffect } from 'react'
import Editor from '@monaco-editor/react'
import { useTerminalStore } from '../../store/terminalStore'
import type { ShellInfo, ShellType } from '../../types'
import { KeybindingsSettings } from './KeybindingsSettings'
import { AgentRatingsSettings } from './AgentRatingsSettings'
import { SecuritySettings } from './SecuritySettings'
import { VoiceSettings } from './VoiceSettings'
import { consumePendingSettingsTab, type SettingsTab } from '../../lib/settingsNav'
import { isAutoPrimerEnabled, setAutoPrimerEnabled } from '../../hooks/useAutoPrimer'
import { isSoloLearningEnabled, setSoloLearningEnabled } from '../../lib/sessionReflection'
import { isAutoReprimeOnCompactionEnabled, setAutoReprimeOnCompactionEnabled } from '../../lib/compactionReprime'
import { isAutoIndexEnabled, setAutoIndexEnabled } from '../../hooks/useAutoCodeIndex'
import {
  FONT_FAMILY_OPTIONS,
  clampFontSize,
  getTerminalDefaults,
  setTerminalDefaults,
  isAgentNameFromFolderEnabled,
  setAgentNameFromFolderEnabled,
} from '../../lib/terminalDefaults'
import { TERMINAL_THEMES, THEME_IDS, getTheme } from '../../themes/terminalThemes'

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
  const { defaultShell, setDefaultShell, allowAppMouseControl, setAllowAppMouseControl } = useTerminalStore()
  const [shells, setShells] = useState<ShellInfo[]>([])
  const [configFiles, setConfigFiles] = useState<{ label: string; path: string; lang: string }[]>([])
  const [activeFile, setActiveFile] = useState('')
  const [fileContents, setFileContents] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState<Record<string, boolean>>({})
  const [telemetryOptIn, setTelemetryOptIn] = useState(() => {
    try { return localStorage.getItem('termpolis.telemetry.optIn') === '1' } catch { return false }
  })
  const [autoPrimer, setAutoPrimer] = useState(() => isAutoPrimerEnabled())
  const [soloLearning, setSoloLearning] = useState(() => isSoloLearningEnabled())
  const [autoReprime, setAutoReprime] = useState(() => isAutoReprimeOnCompactionEnabled())
  const [autoIndex, setAutoIndex] = useState(() => isAutoIndexEnabled())
  const [termDefaults, setTermDefaults] = useState(() => getTerminalDefaults())
  const [agentNameFromFolder, setAgentNameFromFolder] = useState(() => isAgentNameFromFolderEnabled())
  const [appVersion, setAppVersion] = useState<string>('')
  const [updateStatus, setUpdateStatus] = useState<string>('')
  const [updateChecking, setUpdateChecking] = useState(false)
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => consumePendingSettingsTab() ?? 'general')

  useEffect(() => {
    const onOpenShortcuts = () => setActiveTab('keybindings')
    window.addEventListener('termpolis:openShortcuts', onOpenShortcuts)
    return () => window.removeEventListener('termpolis:openShortcuts', onOpenShortcuts)
  }, [])

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

      <div className="flex gap-1 border-b border-[#3c3c3c] -mt-2" data-testid="settings-tabs">
        {[
          { id: 'general', label: 'General' },
          { id: 'security', label: 'AI Security' },
          { id: 'voice', label: 'Voice' },
          { id: 'keybindings', label: 'Keybindings' },
          { id: 'agents', label: 'Agent Ratings' },
          { id: 'shell', label: 'Shell Config' },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id as typeof activeTab)}
            data-testid={`settings-tab-${t.id}`}
            className={`text-sm px-4 py-2 -mb-px border-b-2 ${
              activeTab === t.id
                ? 'border-[#0078d4] text-white'
                : 'border-transparent text-[#9ca3af] hover:text-white'
            }`}
          >
            {t.id === 'security' && <i className="fa-solid fa-shield-halved text-[10px] mr-1.5 text-[#7ee2a3]"></i>}
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'general' && (
        <>
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
          <div className="flex flex-col gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]" data-testid="settings-terminal-defaults">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Terminal Defaults</span>
              <span className="text-xs text-[#9ca3af] leading-relaxed">
                Applied to every new terminal — AI agents and regular shells alike. The New Terminal
                dialog and each terminal&rsquo;s edit menu can still override these for an individual
                terminal.
              </span>
            </div>
            <div className="flex flex-col gap-1 text-sm">
              Default Theme
              <div className="flex flex-wrap gap-2 mt-1">
                {THEME_IDS.map(id => {
                  const t = getTheme(id)
                  return (
                    <button
                      key={id}
                      data-testid={`settings-default-theme-${id}`}
                      onClick={() => setTermDefaults(setTerminalDefaults({ theme: id }))}
                      style={{
                        background: t.background as string,
                        color: t.foreground as string,
                        border: `2px solid ${termDefaults.theme === id ? '#0078d4' : 'transparent'}`,
                        borderRadius: 4,
                        padding: '2px 8px',
                        fontSize: 12,
                      }}
                    >
                      {TERMINAL_THEMES[id].name}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="flex gap-4 items-end">
              <div className="flex flex-col gap-1 text-sm">
                Default Font Size
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setTermDefaults(setTerminalDefaults({ fontSize: clampFontSize(termDefaults.fontSize - 1) }))}
                    className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm hover:bg-[#3c3c3c] leading-none"
                  >−</button>
                  <input
                    type="number"
                    min={8}
                    max={32}
                    data-testid="settings-default-font-size"
                    value={termDefaults.fontSize}
                    onChange={e => setTermDefaults(setTerminalDefaults({ fontSize: clampFontSize(Number(e.target.value)) }))}
                    className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none w-14 text-center"
                  />
                  <button
                    onClick={() => setTermDefaults(setTerminalDefaults({ fontSize: clampFontSize(termDefaults.fontSize + 1) }))}
                    className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm hover:bg-[#3c3c3c] leading-none"
                  >+</button>
                </div>
              </div>
              <label className="flex flex-col gap-1 text-sm flex-1">
                Default Font Family
                <select
                  data-testid="settings-default-font-family"
                  value={termDefaults.fontFamily}
                  onChange={e => setTermDefaults(setTerminalDefaults({ fontFamily: e.target.value }))}
                  className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-2 py-1 text-sm focus:outline-none"
                >
                  {FONT_FAMILY_OPTIONS.map(f => (
                    <option key={f.label} value={f.value}>{f.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div
              style={{
                background: getTheme(termDefaults.theme).background as string,
                color: getTheme(termDefaults.theme).foreground as string,
                fontFamily: termDefaults.fontFamily,
                fontSize: termDefaults.fontSize,
                padding: '6px 10px',
                borderRadius: 4,
                lineHeight: 1.5,
                border: '1px solid #3c3c3c',
              }}
            >
              <div>user@host:~/projects$ git status</div>
              <div>nothing to commit, working tree clean</div>
            </div>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                data-testid="settings-agent-name-from-folder"
                checked={agentNameFromFolder}
                onChange={e => { setAgentNameFromFolder(e.target.checked); setAgentNameFromFolderEnabled(e.target.checked) }}
                className="mt-0.5"
              />
              <span className="flex flex-col gap-0.5">
                <span>Name AI agent terminals after their launch folder</span>
                <span className="text-xs text-[#9ca3af] leading-relaxed">
                  When on, launching an agent into a folder names the terminal after that folder
                  (e.g. <code className="bg-[#3c3c3c] px-1 rounded">termpolis</code>) instead of the
                  agent name. Resumed and handoff terminals keep their descriptive names.
                </span>
              </span>
            </label>
          </div>
          <div className="flex items-start gap-3">
            <button
              onClick={() => setAllowAppMouseControl(!allowAppMouseControl)}
              aria-label="Toggle whether terminal apps may capture the mouse"
              aria-pressed={allowAppMouseControl}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors mt-0.5 ${
                allowAppMouseControl ? 'bg-[#0078d4]' : 'bg-[#555]'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                  allowAppMouseControl ? 'translate-x-4.5' : 'translate-x-0.5'
                }`}
              />
            </button>
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Let terminal apps control the mouse</span>
              <span className="text-xs text-[#9ca3af] leading-relaxed">
                Off (default) keeps the mouse free for selecting text — so click-drag and right-click
                Copy work in mouse-driven apps like Claude Code, vim and lazygit. Turn it on to let
                those apps capture the mouse for their own clickable UI (then hold{' '}
                <code className="bg-[#3c3c3c] px-1 rounded">Shift</code> to select text).
              </span>
            </span>
          </div>
          <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
            <button
              onClick={() => { const next = !autoPrimer; setAutoPrimer(next); setAutoPrimerEnabled(next) }}
              aria-label="Toggle auto context primer on agent launch"
              data-testid="settings-auto-primer-toggle"
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 ${
                autoPrimer ? 'bg-[#0078d4]' : 'bg-[#555]'
              }`}
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                autoPrimer ? 'translate-x-4.5' : 'translate-x-0.5'
              }`} />
            </button>
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Auto-recall context on agent launch</span>
              <span className="text-xs text-[#9ca3af] leading-relaxed">
                When an AI agent starts in a terminal, Termpolis seeds it with your saved memory —
                Claude Code via its system prompt (nothing typed into the terminal), other agents
                via a short one-line note pointing at the memory_primer MCP tool. The agent loads
                the most relevant memories for this project behind the scenes (current repo/directory
                first, then cross-project), holds them as background, and waits for your instruction
                instead of acting on them. Only fires when relevant memory exists.
              </span>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
            <button
              onClick={() => { const next = !soloLearning; setSoloLearning(next); setSoloLearningEnabled(next) }}
              aria-label="Toggle learning from solo agent sessions"
              data-testid="settings-solo-learning-toggle"
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 ${
                soloLearning ? 'bg-[#0078d4]' : 'bg-[#555]'
              }`}
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                soloLearning ? 'translate-x-4.5' : 'translate-x-0.5'
              }`} />
            </button>
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Learn from solo agent sessions</span>
              <span className="text-xs text-[#9ca3af] leading-relaxed">
                Grow the memory brain from individual agent terminals — not just swarms. When an agent
                session (Claude, Codex, or Gemini) pauses or closes, Termpolis reflects on what happened
                and distils reusable lessons and self-competence into the shared brain, so the fleet gets
                smarter from your everyday solo work. Runs locally in the background.
              </span>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
            <button
              onClick={() => { const next = !autoReprime; setAutoReprime(next); setAutoReprimeOnCompactionEnabled(next) }}
              aria-label="Toggle auto re-prime after conversation compaction"
              data-testid="settings-auto-reprime-toggle"
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 ${
                autoReprime ? 'bg-[#0078d4]' : 'bg-[#555]'
              }`}
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                autoReprime ? 'translate-x-4.5' : 'translate-x-0.5'
              }`} />
            </button>
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Re-recall context after compaction</span>
              <span className="text-xs text-[#9ca3af] leading-relaxed">
                When Claude compacts its conversation to fit the context window, it summarizes detail
                away — but that detail still lives in the memory brain. Once the compaction settles,
                Termpolis re-adds the one-line memory_primer note (not sent automatically) so the
                agent can reload what it lost behind the scenes. Your durable memory is the large
                working set; the model&rsquo;s window only holds the active task.
              </span>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 border border-[#3c3c3c] rounded bg-[#252526]">
            <button
              onClick={() => { const next = !autoIndex; setAutoIndex(next); setAutoIndexEnabled(next) }}
              aria-label="Toggle auto-index everything into memory"
              data-testid="settings-auto-index-toggle"
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors mt-0.5 flex-shrink-0 ${
                autoIndex ? 'bg-[#0078d4]' : 'bg-[#555]'
              }`}
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                autoIndex ? 'translate-x-4.5' : 'translate-x-0.5'
              }`} />
            </button>
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Auto-index everything into memory</span>
              <span className="text-xs text-[#9ca3af] leading-relaxed">
                Keep the memory brain current with no clicks. Your past AI conversations are always
                indexed in the background; with this on, the code of each Git repo you open in a
                terminal is indexed automatically too — once per repo, and content-hash deduped, so
                unchanged code is never re-embedded. Turn it off to index a repo only when you click
                &ldquo;Index this repo&rsquo;s code&rdquo; in the Memory panel.
              </span>
            </div>
          </div>
          <button
            data-testid="settings-open-memory-panel"
            onClick={() => window.dispatchEvent(new CustomEvent('termpolis:openMemory'))}
            className="flex items-center gap-3 p-3 border border-[#22D3EE]/50 rounded bg-[#22D3EE]/10 hover:bg-[#22D3EE]/20 transition-colors text-left w-full cursor-pointer"
          >
            <i className="fa-solid fa-brain text-[#22D3EE] text-lg flex-shrink-0"></i>
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-[#e0e0e0]">
                Open the Memory panel
                <kbd className="ml-2 bg-[#3c3c3c] px-1.5 py-0.5 rounded text-[10px] font-normal text-[#bbb] align-middle">Ctrl+Shift+M</kbd>
              </span>
              <span className="text-xs text-[#9ca3af] leading-relaxed">
                See what Termpolis remembers (how many chunks are stored), search your memory, index
                this repo&apos;s code, inject the most relevant context into the active agent, and set up
                encrypted cross-machine sync (OneDrive, Google Drive, Dropbox…).
              </span>
            </span>
          </button>
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
        </>
      )}

      {activeTab === 'security' && <SecuritySettings />}

      {activeTab === 'voice' && <VoiceSettings />}

      {activeTab === 'keybindings' && <KeybindingsSettings />}

      {activeTab === 'agents' && <AgentRatingsSettings />}

      {activeTab === 'shell' && (
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
      )}
    </div>
  )
}
