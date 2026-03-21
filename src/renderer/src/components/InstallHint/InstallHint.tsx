import React from 'react'

interface InstallHintProps {
  agentId: string
  agentName: string
  onClose: () => void
}

const INSTALL_INSTRUCTIONS: Record<string, { steps: string[]; url: string }> = {
  claude: {
    steps: [
      'npm install -g @anthropic-ai/claude-code',
      'claude --version  (to verify)',
    ],
    url: 'https://docs.anthropic.com/en/docs/claude-code',
  },
  codex: {
    steps: [
      'npm install -g @openai/codex',
      'codex --version  (to verify)',
    ],
    url: 'https://github.com/openai/codex',
  },
  gemini: {
    steps: [
      'npm install -g @anthropic-ai/gemini-cli',
      'Or: npx @anthropic-ai/gemini-cli',
      'gemini --version  (to verify)',
    ],
    url: 'https://github.com/google-gemini/gemini-cli',
  },
  aider: {
    steps: [
      'pip install aider-chat',
      'aider --version  (to verify)',
    ],
    url: 'https://aider.chat/docs/install.html',
  },
  'aider-qwen': {
    steps: [
      '1. Install Aider: pip install aider-chat',
      '2. Install Ollama: https://ollama.com',
      '3. Pull model: ollama pull qwen3-coder',
      '4. Launch: aider --model ollama/qwen3-coder',
    ],
    url: 'https://ollama.com',
  },
}

export function InstallHint({ agentId, agentName, onClose }: InstallHintProps) {
  const info = INSTALL_INSTRUCTIONS[agentId] || INSTALL_INSTRUCTIONS['claude']

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
