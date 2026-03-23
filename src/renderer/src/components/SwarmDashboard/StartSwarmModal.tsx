import React, { useState, useEffect, useCallback, useRef } from 'react'
import { checkClaudeInstalled, startConductor, waitForAuth, sendTask } from '../../lib/conductorManager'

// ---- Component ----

interface StartSwarmModalProps {
  onClose: () => void
  onLaunched: () => void
  projectCwd: string
}

type Step = 'preparing' | 'describe' | 'launching'

export function StartSwarmModal({ onClose, onLaunched, projectCwd }: StartSwarmModalProps) {
  const [step, setStep] = useState<Step>('preparing')
  const [taskDescription, setTaskDescription] = useState('')
  const [statusMessage, setStatusMessage] = useState('Checking Claude Code...')
  const [needsAuth, setNeedsAuth] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [claudeNotInstalled, setClaudeNotInstalled] = useState(false)
  const [launchProgress, setLaunchProgress] = useState('')
  const cwdRef = useRef<string>(projectCwd)
  const abortedRef = useRef(false)

  // Preparation flow on mount
  useEffect(() => {
    let cancelled = false

    async function prepare() {
      // Step 1: Check if Claude Code is installed
      setStatusMessage('Checking Claude Code...')
      const installed = await checkClaudeInstalled()
      if (cancelled || abortedRef.current) return

      if (!installed) {
        setClaudeNotInstalled(true)
        return
      }

      const cwd = cwdRef.current

      // Step 3: Start conductor
      setStatusMessage('Starting conductor...')
      const result = await startConductor(cwd)
      if (cancelled || abortedRef.current) return

      if (!result.success) {
        setError(result.error || 'Failed to start conductor')
        return
      }

      // Step 4: Handle auth
      if (result.needsAuth) {
        setStatusMessage('Waiting for authentication...')
        setNeedsAuth(true)
        const authed = await waitForAuth()
        if (cancelled || abortedRef.current) return

        if (!authed) {
          setError('Authentication timed out. Please try again.')
          setNeedsAuth(false)
          return
        }
        setNeedsAuth(false)
      }

      // Ready — move to describe step
      if (!cancelled && !abortedRef.current) {
        setStep('describe')
      }
    }

    prepare()

    return () => {
      cancelled = true
    }
  }, [onClose])

  // Escape to close (not during launching)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && step !== 'launching') {
        abortedRef.current = true
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, step])

  const handleLaunch = useCallback(async () => {
    if (!taskDescription.trim() || !cwdRef.current) return
    setStep('launching')
    setLaunchProgress('Sending task to conductor...')
    await sendTask(taskDescription, cwdRef.current)
    onLaunched()
  }, [taskDescription, onLaunched])

  const stepIndex = (s: Step): number => {
    return ['preparing', 'describe', 'launching'].indexOf(s)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={step !== 'launching' ? () => { abortedRef.current = true; onClose() } : undefined}>
      <div
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-xl shadow-2xl w-[640px] max-w-[90vw] max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#3c3c3c]">
          <div className="flex items-center gap-3">
            <i className="fa-solid fa-wand-magic-sparkles text-[#22D3EE]"></i>
            <h2 className="text-base font-semibold text-[#d4d4d4]">Start Swarm</h2>
            <div className="flex items-center gap-1.5 ml-2">
              {(['preparing', 'describe', 'launching'] as Step[]).map((s, i) => (
                <React.Fragment key={s}>
                  {i > 0 && <div className="w-4 h-px bg-[#3c3c3c]"></div>}
                  <div
                    className={`w-2 h-2 rounded-full transition-colors ${
                      s === step ? 'bg-[#22D3EE]' : stepIndex(step) > i ? 'bg-[#22D3EE]/50' : 'bg-[#3c3c3c]'
                    }`}
                  ></div>
                </React.Fragment>
              ))}
            </div>
          </div>
          {step !== 'launching' && (
            <button onClick={() => { abortedRef.current = true; onClose() }} className="text-[#6b7280] hover:text-white px-2 py-1 rounded hover:bg-[#37373d]">
              <i className="fa-solid fa-xmark"></i>
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {step === 'preparing' && renderPreparingStep()}
          {step === 'describe' && renderDescribeStep()}
          {step === 'launching' && renderLaunchingStep()}
        </div>

        {/* Footer */}
        {step === 'describe' && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-[#3c3c3c]">
            <button
              onClick={() => { abortedRef.current = true; onClose() }}
              className="px-3 py-1.5 text-xs text-[#999] hover:text-white rounded hover:bg-[#37373d]"
            >
              Cancel
            </button>
            <button
              onClick={handleLaunch}
              disabled={!taskDescription.trim()}
              className={`px-4 py-1.5 text-xs rounded font-medium transition-colors ${
                !taskDescription.trim()
                  ? 'bg-[#3c3c3c] text-[#555] cursor-not-allowed'
                  : 'bg-[#22D3EE] text-[#1e1e1e] hover:bg-[#06b6d4]'
              }`}
            >
              <i className="fa-solid fa-rocket mr-1.5"></i>Launch Swarm
            </button>
          </div>
        )}
        {step === 'preparing' && (claudeNotInstalled || error) && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-[#3c3c3c]">
            <button
              onClick={() => { abortedRef.current = true; onClose() }}
              className="px-3 py-1.5 text-xs text-[#999] hover:text-white rounded hover:bg-[#37373d]"
            >
              Close
            </button>
            <div></div>
          </div>
        )}
      </div>
    </div>
  )

  // ---- Step renderers ----

  function renderPreparingStep() {
    if (claudeNotInstalled) {
      return (
        <div className="space-y-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-full bg-red-500/15 flex items-center justify-center">
              <i className="fa-solid fa-brain text-red-400"></i>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[#d4d4d4]">Claude Code Required</h3>
              <p className="text-xs text-[#6b7280]">The swarm conductor needs Claude Code CLI installed</p>
            </div>
          </div>

          <div className="p-3 bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg">
            <p className="text-xs text-[#bbb] mb-3">
              Termpolis uses a dedicated Claude Code instance as the <span className="text-[#22D3EE]">AI conductor</span> to
              orchestrate your swarm. It analyzes your task, picks the best agents, assigns work, monitors progress, and
              coordinates communication between agents.
            </p>
            <p className="text-xs text-[#888] mb-3">
              This requires the <span className="text-[#d4d4d4]">Claude Code CLI</span> (command-line tool) — not the VS Code
              extension. The VS Code extension is a different product that runs inside VS Code. The CLI runs in any terminal.
            </p>
          </div>

          <div className="p-3 bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg">
            <p className="text-[10px] text-[#6b7280] mb-2 font-semibold uppercase tracking-wider">Install Steps</p>
            <div className="space-y-2">
              <div className="bg-[#2d2d2d] border border-[#3c3c3c] rounded px-3 py-2 font-mono text-xs text-[#d4d4d4] select-all">
                npm install -g @anthropic-ai/claude-code
              </div>
              <div className="bg-[#2d2d2d] border border-[#3c3c3c] rounded px-3 py-2 font-mono text-xs text-[#d4d4d4] select-all">
                claude --version
              </div>
            </div>
            <p className="text-[10px] text-[#555] mt-2">
              Requires Node.js 18+. After installing, restart Termpolis and try Start Swarm again.
            </p>
          </div>

          <div className="flex items-center justify-between">
            <a
              href="https://docs.anthropic.com/en/docs/claude-code"
              onClick={e => { e.preventDefault(); window.open('https://docs.anthropic.com/en/docs/claude-code', '_blank') }}
              className="text-[#22D3EE] hover:underline text-xs flex items-center gap-1"
            >
              <i className="fa-solid fa-arrow-up-right-from-square text-[10px]"></i>
              Claude Code Documentation
            </a>
          </div>
        </div>
      )
    }

    return (
      <div className="flex flex-col items-center justify-center py-12">
        <div className="relative mb-6">
          <div className="w-16 h-16 rounded-full border-2 border-[#22D3EE]/30 border-t-[#22D3EE] animate-spin"></div>
          <i className="fa-solid fa-brain text-[#22D3EE] text-xl absolute inset-0 flex items-center justify-center"></i>
        </div>
        <h3 className="text-sm font-semibold text-[#d4d4d4] mb-2">Preparing Conductor</h3>
        <p className="text-xs text-[#6b7280] text-center max-w-sm mb-4">{statusMessage}</p>
        <p className="text-[11px] text-[#d4d4d4] text-center max-w-md leading-relaxed">
          A swarm lets multiple AI agents work together on the same project simultaneously — one builds, another writes tests, another handles docs. An AI conductor coordinates the work so you just describe what you need.
        </p>
        {needsAuth && (
          <div className="mt-4 p-3 bg-[#1e3a1e] border border-[#2d5a2d] rounded-lg text-xs text-[#A5D6A7] max-w-sm text-center">
            <i className="fa-solid fa-arrow-up-right-from-square mr-1"></i>
            Complete sign-in in your browser. Waiting for authentication...
          </div>
        )}
        {error && (
          <div className="mt-4 p-3 bg-[#3a1e1e] border border-[#5a2d2d] rounded-lg text-xs text-[#E57373] max-w-sm text-center">
            <i className="fa-solid fa-triangle-exclamation mr-1"></i>
            {error}
          </div>
        )}
      </div>
    )
  }

  function renderDescribeStep() {
    return (
      <div>
        <p className="text-sm text-[#bbb] mb-2">What do you want the swarm to work on?</p>
        <p className="text-xs text-[#6b7280] mb-3">
          Just describe what you need in plain language. The AI conductor will figure out how to break it down, which agents to use, and how to coordinate the work.
        </p>
        <textarea
          autoFocus
          value={taskDescription}
          onChange={e => setTaskDescription(e.target.value)}
          placeholder='e.g. "I want a tic-tac-toe game for two players with documentation on how to play"'
          rows={5}
          className="w-full bg-[#2d2d2d] border border-[#3c3c3c] rounded-lg px-4 py-3 text-sm text-[#d4d4d4] placeholder-[#555] focus:border-[#22D3EE] outline-none resize-none"
        />
        <div className="mt-3 p-2.5 bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg">
          <p className="text-[10px] text-[#6b7280] mb-1.5 flex items-center gap-1.5">
            <i className="fa-solid fa-brain text-[#22D3EE]"></i>
            <span className="font-semibold uppercase tracking-wider">AI Conductor</span>
          </p>
          <p className="text-[10px] text-[#555]">
            The conductor analyzes your description, picks the best available agents, breaks the work into tasks, and coordinates everything automatically. You'll see progress updates in the Swarm Dashboard.
          </p>
        </div>
      </div>
    )
  }

  function renderLaunchingStep() {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <div className="relative mb-6">
          <div className="w-16 h-16 rounded-full border-2 border-[#22D3EE]/30 border-t-[#22D3EE] animate-spin"></div>
          <i className="fa-solid fa-rocket text-[#22D3EE] text-xl absolute inset-0 flex items-center justify-center"></i>
        </div>
        <h3 className="text-sm font-semibold text-[#d4d4d4] mb-2">Launching Swarm</h3>
        <p className="text-xs text-[#6b7280] text-center max-w-sm">{launchProgress}</p>
      </div>
    )
  }
}
