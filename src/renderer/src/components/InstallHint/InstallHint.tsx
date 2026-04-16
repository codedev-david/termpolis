import React from 'react'

interface InstallHintProps {
  agentId: string
  agentName: string
  onClose: () => void
}

const isWindows = navigator.platform.startsWith('Win')

function getInstallInstructions(agentId: string): { steps: string[]; url: string; pricing: string | null } {
  switch (agentId) {
    case 'claude':
      return {
        steps: [
          'npm install -g @anthropic-ai/claude-code',
          'claude --version  (to verify)',
        ],
        url: 'https://docs.anthropic.com/en/docs/claude-code',
        pricing: 'Requires an Anthropic API plan or Claude Pro/Max subscription.',
      }
    case 'codex':
      return {
        steps: [
          'npm install -g @openai/codex',
          'codex --version  (to verify)',
        ],
        url: 'https://github.com/openai/codex',
        pricing: 'Requires an OpenAI API key with active billing.',
      }
    case 'gemini':
      return {
        steps: [
          'npm install -g @google/gemini-cli',
          'Or: npx @google/gemini-cli',
          'gemini --version  (to verify)',
        ],
        url: 'https://github.com/google-gemini/gemini-cli',
        pricing: 'Free tier available. Paid Google AI API plan for higher usage.',
      }
    case 'aider-qwen':
      return {
        steps: [
          '1. Install Aider: pip install aider-chat',
          '2. Install Ollama: https://ollama.com',
          ...(isWindows ? [
            '3. Add Ollama to PATH (PowerShell as Admin):',
            '   setx PATH "%PATH%;%LOCALAPPDATA%\\Programs\\Ollama" /M',
            '4. Restart your terminal, then pull a model:',
            '   ollama pull qwen3-coder         (default, 16GB+ RAM)',
            '   ollama pull qwen3-coder-next    (advanced, 64GB+ RAM)',
          ] : [
            '3. Pull a model:',
            '   ollama pull qwen3-coder         (default, 16GB+ RAM)',
            '   ollama pull qwen3-coder-next    (advanced, 64GB+ RAM)',
          ]),
          `${isWindows ? '5' : '4'}. Restart Termpolis to detect the changes`,
          '',
          'To use qwen3-coder-next instead (64GB+ RAM):',
          '  Click + in AI Agents to add a custom profile',
          '  Set command to: aider --model ollama/qwen3-coder-next --no-show-model-warnings',
        ],
        url: 'https://ollama.com',
        pricing: 'Free — runs locally on your machine with no API costs. Default model works with 16GB+ RAM.',
      }
    default:
      return {
        steps: ['Check the documentation for install instructions.'],
        url: 'https://github.com/codedev-david/termpolis',
        pricing: null,
      }
  }
}

export function InstallHint({ agentId, agentName, onClose }: InstallHintProps) {
  const info = getInstallInstructions(agentId)
  const [copiedIndex, setCopiedIndex] = React.useState<number | null>(null)

  const handleCopy = (text: string, index: number) => {
    navigator.clipboard.writeText(text.replace(/^\d+\.\s*/, '').trim())
    setCopiedIndex(index)
    setTimeout(() => setCopiedIndex(null), 2000)
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 animate-fadeIn" onClick={onClose}>
      <div className="bg-[#252526] rounded-lg p-6 w-96 shadow-xl border border-[#3c3c3c] flex flex-col gap-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <i className="fa-solid fa-download text-[#22D3EE]"></i>
            Install {agentName}
          </h2>
          <button onClick={onClose} className="text-[#9ca3af] hover:text-white text-lg px-1">&times;</button>
        </div>

        <p className="text-sm text-[#999]">
          {agentName} is not installed on your system. Run these commands to install it:
        </p>

        <div className="flex flex-col gap-2">
          {info.steps.map((step, i) => (
            <div key={i} className="flex items-center gap-1 bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-2">
              <span className="font-mono text-xs text-[#d4d4d4] flex-1 select-all">{step}</span>
              <button
                onClick={() => handleCopy(step, i)}
                className="shrink-0 text-[#9ca3af] hover:text-[#22D3EE] px-1.5 py-0.5 rounded hover:bg-[#37373d] transition-colors"
                title="Copy to clipboard"
              >
                <i className={`fa-solid ${copiedIndex === i ? 'fa-check text-green-400' : 'fa-copy'} text-[10px]`}></i>
              </button>
            </div>
          ))}
        </div>

        {info.pricing && (
          <div className="flex items-start gap-2 p-2.5 bg-[#1e1e1e] border border-[#3c3c3c] rounded">
            <i className="fa-solid fa-credit-card text-[#F59E0B] text-xs mt-0.5"></i>
            <p className="text-xs text-[#bbb]">{info.pricing}</p>
          </div>
        )}

        <div className="flex items-center gap-2 p-3 bg-[#2a1f1a] border border-[#5a3a2d] rounded-lg">
          <i className="fa-solid fa-triangle-exclamation text-[#FFB74D] text-sm"></i>
          <p className="text-xs text-[#FFB74D] font-medium">
            You must restart Termpolis after installing for the agent to be detected.
          </p>
        </div>

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
