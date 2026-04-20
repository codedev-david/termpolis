import React, { useState, useEffect, useCallback, useRef } from 'react'
import { checkClaudeInstalled, startConductor, waitForAuth, sendTask, stopConductor, getConductorState } from '../../lib/conductorManager'
import { useTerminalStore } from '../../store/terminalStore'

// ---- Component ----

interface StartSwarmModalProps {
  onClose: () => void
  onLaunched: () => void
  projectCwd: string
}

type Step = 'preparing' | 'describe' | 'launching'

export function StartSwarmModal({ onClose, onLaunched, projectCwd }: StartSwarmModalProps) {
  const [step, setStep] = useState<Step>('preparing')
  const [goal, setGoal] = useState('')
  const [constraints, setConstraints] = useState('')
  const [expectedOutput, setExpectedOutput] = useState('')
  const [failureConditions, setFailureConditions] = useState('')
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
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Cancel: stop the conductor and clean up before closing
  const handleCancel = useCallback(() => {
    abortedRef.current = true
    if (step !== 'launching') {
      stopConductor()
      useTerminalStore.getState().setSwarmActive(false)
    }
    onClose()
  }, [onClose, step])

  // Escape to close (not during launching)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && step !== 'launching') {
        handleCancel()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleCancel, step])

  const buildPromptContract = useCallback(() => {
    let prompt = `## Goal\n${goal.trim()}`
    if (constraints.trim()) prompt += `\n\n## Constraints\n${constraints.trim()}`
    if (expectedOutput.trim()) prompt += `\n\n## Expected Output\n${expectedOutput.trim()}`
    if (failureConditions.trim()) prompt += `\n\n## Failure Conditions\n${failureConditions.trim()}`
    return prompt
  }, [goal, constraints, expectedOutput, failureConditions])

  const handleLaunch = useCallback(async () => {
    if (!goal.trim() || !cwdRef.current) return
    setStep('launching')
    setLaunchProgress('Sending task to conductor...')

    await sendTask(buildPromptContract(), cwdRef.current)
    setLaunchProgress('Conductor is analyzing your task...')

    // Close the modal as soon as we see the conductor is alive (first message,
    // task, or agent terminal). The dashboard shows live progress after that —
    // no reason to trap the user behind a spinner while the LLM thinks.
    const startTime = Date.now()
    const maxWait = 60000

    const pollForAgents = () => new Promise<void>((resolve) => {
      const check = async () => {
        const elapsed = Date.now() - startTime

        try {
          const [taskRes, msgRes] = await Promise.all([
            window.swarmAPI.getTasks(),
            window.swarmAPI.getMessages(),
          ])
          const taskCount = taskRes.success && taskRes.data ? taskRes.data.length : 0
          // The sendTask call itself posts 2 system/conductor messages, so we
          // only count conductor messages as real progress.
          const conductorMsgs = msgRes.success && msgRes.data
            ? msgRes.data.filter((m: any) => m.from === 'conductor' || m.from === 'mcp-client')
            : []
          const agentTerminals = useTerminalStore.getState().terminals.filter(t => t.isSwarm && !t.isConductor && !t.hidden)

          if (agentTerminals.length > 0) {
            setLaunchProgress(`${agentTerminals.length} agent terminal${agentTerminals.length !== 1 ? 's' : ''} opened — handing off to dashboard...`)
          } else if (taskCount > 0) {
            setLaunchProgress(`${taskCount} task${taskCount !== 1 ? 's' : ''} created — handing off to dashboard...`)
          } else if (conductorMsgs.length > 1) {
            setLaunchProgress('Conductor is planning — handing off to dashboard...')
          } else {
            setLaunchProgress('Conductor is analyzing your task...')
          }

          // Close as soon as ANY real progress is visible.
          if (agentTerminals.length > 0 || taskCount > 0 || conductorMsgs.length > 1) {
            resolve()
            return
          }

          // Check if conductor refused the task or errored out
          const conductorState = getConductorState()
          if (conductorState.status === 'error') {
            setLaunchProgress(conductorState.error || 'Conductor encountered an error.')
            setTimeout(resolve, 3000)
            return
          }
        } catch {
          // Swarm API not ready — continue polling
        }

        if (elapsed >= maxWait) {
          resolve()
          return
        }

        setTimeout(check, 1000)
      }
      check()
    })

    await pollForAgents()
    onLaunched()
  }, [goal, buildPromptContract, onLaunched])

  const stepIndex = (s: Step): number => {
    return ['preparing', 'describe', 'launching'].indexOf(s)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={step !== 'launching' ? handleCancel : undefined}>
      <div
        className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-xl shadow-2xl w-[780px] max-w-[92vw] max-h-[90vh] flex flex-col"
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
            <button onClick={handleCancel} className="text-[#9ca3af] hover:text-white px-2 py-1 rounded hover:bg-[#37373d]">
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
              onClick={handleCancel}
              className="px-3 py-1.5 text-xs text-[#999] hover:text-white rounded hover:bg-[#37373d]"
            >
              Cancel
            </button>
            <button
              onClick={handleLaunch}
              disabled={!goal.trim()}
              className={`px-4 py-1.5 text-xs rounded font-medium transition-colors ${
                !goal.trim()
                  ? 'bg-[#3c3c3c] text-[#888] cursor-not-allowed'
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
              onClick={handleCancel}
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
              <p className="text-xs text-[#9ca3af]">The swarm conductor needs Claude Code CLI installed</p>
            </div>
          </div>

          <div className="p-3 bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg">
            <p className="text-xs text-[#bbb] mb-3">
              Termpolis uses a dedicated Claude Code instance as the <span className="text-[#22D3EE]">AI conductor</span> to
              orchestrate your swarm. It analyzes your task, picks the best agents, assigns work, monitors progress, and
              coordinates communication between agents.
            </p>
            <p className="text-xs text-[#aaa] mb-3">
              This requires the <span className="text-[#d4d4d4]">Claude Code CLI</span> (command-line tool) — not the VS Code
              extension. The VS Code extension is a different product that runs inside VS Code. The CLI runs in any terminal.
            </p>
          </div>

          <div className="p-3 bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg">
            <p className="text-[10px] text-[#9ca3af] mb-2 font-semibold uppercase tracking-wider">Install Steps</p>
            <div className="space-y-2">
              <div className="bg-[#2d2d2d] border border-[#3c3c3c] rounded px-3 py-2 font-mono text-xs text-[#d4d4d4] select-all">
                npm install -g @anthropic-ai/claude-code
              </div>
              <div className="bg-[#2d2d2d] border border-[#3c3c3c] rounded px-3 py-2 font-mono text-xs text-[#d4d4d4] select-all">
                claude --version
              </div>
            </div>
            <p className="text-[10px] text-[#888] mt-2">
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
        <p className="text-xs text-[#9ca3af] text-center max-w-sm mb-4">{statusMessage}</p>
        <p className="text-[11px] text-[#d4d4d4] text-center max-w-md leading-relaxed">
          A swarm lets multiple AI agents work together on the same project simultaneously — one builds, another writes tests, another handles docs. Use it to create a <strong className="text-[#d4d4d4]">new project</strong> or to make changes to an <strong className="text-[#d4d4d4]">existing one</strong>. An AI conductor coordinates the work, and when it finishes you can review every hunk and accept only the changes you want.
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
    const fieldClass = "w-full bg-[#2d2d2d] border border-[#3c3c3c] rounded-lg px-4 py-3 text-sm text-[#d4d4d4] placeholder-[#555] focus:border-[#22D3EE] outline-none resize-none"

    return (
      <div className="space-y-4">
        <div>
          <p className="text-sm text-[#bbb] mb-1">Describe what you want built</p>
          <p className="text-xs text-[#9ca3af]">
            Only <strong className="text-[#d4d4d4]">Goal</strong> is required — the more detail you provide, the better the results.
          </p>
        </div>

        {/* Goal */}
        <div>
          <label className="flex items-center gap-1.5 text-xs font-semibold text-[#d4d4d4] mb-1.5">
            <i className="fa-solid fa-bullseye text-[#22D3EE] text-[10px]"></i>
            Goal
            <span className="text-[#E57373] text-[10px]">*</span>

          </label>
          <textarea
            autoFocus
            value={goal}
            onChange={e => setGoal(e.target.value)}
            placeholder={'"Add a contact form to the website with name, email, and message fields. It should validate inputs, send an email on submit, and show a confirmation message."'}
            rows={3}
            className={fieldClass}
          />
        </div>

        {/* Constraints */}
        <div>
          <label className="flex items-center gap-1.5 text-xs font-semibold text-[#d4d4d4] mb-1.5">
            <i className="fa-solid fa-shield-halved text-[#F59E0B] text-[10px]"></i>
            Constraints
            <span className="text-[10px] text-[#9ca3af] font-normal ml-1">optional</span>

          </label>
          <textarea
            value={constraints}
            onChange={e => setConstraints(e.target.value)}
            placeholder={'"Needs to work on Windows and Mac. Should have a simple UI — nothing fancy. Must support iPhone and Android if mobile. Python preferred but not required. No paid services or API keys."'}
            rows={3}
            className={fieldClass}
          />
        </div>

        {/* Expected Output */}
        <div>
          <label className="flex items-center gap-1.5 text-xs font-semibold text-[#d4d4d4] mb-1.5">
            <i className="fa-solid fa-folder-tree text-[#22C55E] text-[10px]"></i>
            Expected Output
            <span className="text-[10px] text-[#9ca3af] font-normal ml-1">optional</span>

          </label>
          <textarea
            value={expectedOutput}
            onChange={e => setExpectedOutput(e.target.value)}
            placeholder={'"A working contact page integrated into the site, with form validation and email delivery. Tests for the form logic and a brief note in the README."'}
            rows={3}
            className={fieldClass}
          />
        </div>

        {/* Failure Conditions */}
        <div>
          <label className="flex items-center gap-1.5 text-xs font-semibold text-[#d4d4d4] mb-1.5">
            <i className="fa-solid fa-triangle-exclamation text-[#E57373] text-[10px]"></i>
            Failure Conditions
            <span className="text-[10px] text-[#9ca3af] font-normal ml-1">optional</span>

          </label>
          <textarea
            value={failureConditions}
            onChange={e => setFailureConditions(e.target.value)}
            placeholder={'"Form submits without validating required fields. Email is sent but no confirmation shown to the user. Page breaks on small screens."'}
            rows={3}
            className={fieldClass}
          />
        </div>

        {/* Info boxes */}
        <div className="space-y-2">
          <div className="p-2.5 bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg">
            <p className="text-[10px] text-[#9ca3af] mb-1.5 flex items-center gap-1.5">
              <i className="fa-solid fa-brain text-[#22D3EE]"></i>
              <span className="font-semibold uppercase tracking-wider">AI Conductor</span>
            </p>
            <p className="text-[11px] text-[#d4d4d4]">
              The conductor reads your contract, picks the best agents, breaks the work into tasks, and coordinates everything. After launching, track progress via the{' '}
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#2d2d2d] border border-[#3c3c3c] text-[#22c55e]">
                <i className="fa-solid fa-network-wired text-[9px]"></i>
                <span className="text-[9px] font-mono">Swarm</span>
              </span>
              {' '}icon in the sidebar.
            </p>
          </div>
          <div className="p-2.5 bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg">
            <p className="text-[10px] text-[#9ca3af] mb-2 flex items-center gap-1.5">
              <i className="fa-solid fa-circle-info text-[#9ca3af]"></i>
              <span className="font-semibold uppercase tracking-wider">Swarm vs individual agents</span>
            </p>
            <div className="text-[11px] text-[#bbb] leading-relaxed space-y-1.5">
              <p>
                <strong className="text-[#22D3EE]">Swarm</strong> — best for completing a well-defined task autonomously. Works for creating a brand new project from scratch or modifying an existing one. Describe what you want built, and the agents do it.
              </p>
              <p>
                <strong className="text-[#22D3EE]">Individual agent terminals</strong> — better for back-and-forth conversations, exploring ideas, or iterating on details. Launch them from the <strong className="text-[#d4d4d4]">AI Agents</strong> section in the sidebar.
              </p>
              <p className="text-[#9ca3af]">
                When a swarm finishes, the Review panel shows every file the swarm touched — accept or reject individual hunks before committing so nothing you don't want sneaks into the repo.
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  function renderLaunchingStep() {
    return (
      <div className="flex flex-col items-center justify-center py-10">
        <div className="relative mb-6">
          <div className="w-16 h-16 rounded-full border-2 border-[#22D3EE]/30 border-t-[#22D3EE] animate-spin"></div>
          <i className="fa-solid fa-rocket text-[#22D3EE] text-xl absolute inset-0 flex items-center justify-center"></i>
        </div>
        <h3 className="text-sm font-semibold text-[#d4d4d4] mb-2">Launching Swarm</h3>
        <p className="text-xs text-[#22D3EE] text-center max-w-sm mb-4 font-medium">{launchProgress}</p>
        <div className="space-y-2 max-w-sm w-full">
          <div className="p-3 bg-[#1e2a3a] border border-[#2d4a5a] rounded-lg text-xs text-[#93c5fd]">
            <div className="flex items-center gap-1.5 mb-1">
              <i className="fa-solid fa-folder-open"></i>
              <span className="font-semibold">Working directory</span>
            </div>
            <p className="text-[#6b8fae] break-all font-mono text-[11px]">
              {cwdRef.current || projectCwd}
            </p>
            <p className="text-[#6b8fae] mt-1.5 leading-relaxed">
              The swarm will work in this folder — all files created or modified by the conductor
              and agents will go here.
            </p>
          </div>
          <div className="p-3 bg-[#1e3a1e] border border-[#2d5a2d] rounded-lg text-xs text-[#A5D6A7]">
            <div className="flex items-center gap-1.5 mb-1">
              <i className="fa-solid fa-clock"></i>
              <span className="font-semibold">The AI conductor is working</span>
            </div>
            <p className="text-[#6b9e6b]">
              The conductor is analyzing your task and creating a plan. This screen will close as soon as
              the first task or message appears. It can take up to <strong className="text-[#A5D6A7]">30 seconds</strong>
              {' '}for tasks to show up in the Swarm Dashboard — the conductor runs in the background via MCP.
            </p>
          </div>
        </div>
      </div>
    )
  }
}
