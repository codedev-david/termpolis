import React from 'react'

interface InstallHintProps {
  agentId: string
  agentName: string
  onClose: () => void
}

const isWindows = navigator.platform.startsWith('Win')

function getInstallInstructions(agentId: string): { steps: string[]; url: string } {
  switch (agentId) {
    case 'claude':
      return {
        steps: [
          'npm install -g @anthropic-ai/claude-code',
          'claude --version  (to verify)',
        ],
        url: 'https://docs.anthropic.com/en/docs/claude-code',
      }
    case 'codex':
      return {
        steps: [
          'npm install -g @openai/codex',
          'codex --version  (to verify)',
        ],
        url: 'https://github.com/openai/codex',
      }
    case 'gemini':
      return {
        steps: [
          'npm install -g @google/gemini-cli',
          'Or: npx @google/gemini-cli',
          'gemini --version  (to verify)',
        ],
        url: 'https://github.com/google-gemini/gemini-cli',
      }
    case 'aider':
      return {
        steps: [
          'pip install aider-chat',
          'aider --version  (to verify)',
        ],
        url: 'https://aider.chat/docs/install.html',
      }
    case 'aider-qwen':
      return {
        steps: [
          '1. Install Aider: pip install aider-chat',
          '2. Install Ollama: https://ollama.com',
          ...(isWindows ? [
            '3. Add Ollama to PATH (PowerShell as Admin):',
            '   setx PATH "%PATH%;%LOCALAPPDATA%\\Programs\\Ollama" /M',
            '4. Restart your terminal, then pull the model:',
            '   ollama pull qwen3-coder',
          ] : [
            '3. Pull the model: ollama pull qwen3-coder',
          ]),
          `${isWindows ? '5' : '4'}. Restart Termpolis to detect the changes`,
        ],
        url: 'https://ollama.com',
      }
    default:
      return {
        steps: ['Check the documentation for install instructions.'],
        url: 'https://github.com/codedev-david/termpolis',
      }
  }
}

export function InstallHint({ agentId, agentName, onClose }: InstallHintProps) {
  const info = getInstallInstructions(agentId)

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 animate-fadeIn" onClick={onClose}>
      <div className="bg-[#252526] rounded-lg p-6 w-96 shadow-xl border border-[#3c3c3c] flex flex-col gap-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <i className="fa-solid fa-download text-[#22D3EE]"></i>
            Install {agentName}
          </h2>
          <button onClick={onClose} className="text-[#6b7280] hover:text-white text-lg px-1">&times;</button>
        </div>

        <p className="text-sm text-[#999]">
          {agentName} is not installed on your system. Run these commands to install it:
        </p>

        <div className="flex flex-col gap-2">
          {info.steps.map((step, i) => (
            <div key={i} className="bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-2 font-mono text-xs text-[#d4d4d4] select-all">
              {step}
            </div>
          ))}
        </div>

        <p className="text-xs text-[#6b7280]">
          After installing, restart Termpolis and the agent will be available.
        </p>

        <div className="flex items-center justify-between mt-1">
          <a
            href={info.url}
            onClick={e => { e.preventDefault(); window.open(info.url, '_blank') }}
            className="text-[#22D3EE] hover:underline text-sm flex items-center gap-1"
          >
            <i className="fa-solid fa-arrow-up-right-from-square text-[10px]"></i>
            Documentation
          </a>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
          >Got it</button>
        </div>
      </div>
    </div>
  )
}
