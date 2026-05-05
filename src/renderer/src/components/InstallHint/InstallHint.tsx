import React from 'react'

interface InstallHintProps {
  agentId: string
  agentName: string
  onClose: () => void
}

interface InstallInstructions {
  steps: string[]
  warning?: string
  sections?: Array<{ title: string; lines: string[] }>
  url: string
  pricing: string | null
}

const isWindows = navigator.platform.startsWith('Win')

function getInstallInstructions(agentId: string): InstallInstructions {
  switch (agentId) {
    case 'claude':
      return {
        steps: [
          'npm install -g @anthropic-ai/claude-code',
          'claude --version  (to verify)',
        ],
        warning: 'The Claude Desktop app (GUI) is NOT the same as the Claude Code CLI. Termpolis needs the CLI above — installing only the Desktop app will not work.',
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
    case 'qwen-code':
      return {
        steps: [
          isWindows
            ? 'curl -fsSL -o %TEMP%\\install-qwen.bat https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.bat && %TEMP%\\install-qwen.bat --source qwenchat'
            : 'bash -c "$(curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.sh)" -s --source qwenchat',
          'qwen --version  (to verify)',
        ],
        sections: [
          {
            title: 'Official install page',
            lines: [
              'These commands come from the official Qwen Code site:',
              'https://qwen.ai/qwencode',
            ],
          },
          {
            title: 'Authenticate Qwen Code',
            lines: [
              'On first launch, Qwen prompts for an auth method. Pick one:',
              'Local Ollama / vLLM — free, offline, no account',
              'Alibaba Cloud Coding Plan — subscription, hosted Qwen3-Coder',
              'OpenRouter / Fireworks AI — bring-your-own API key',
              'Any OpenAI / Anthropic / Gemini-compatible endpoint — BYO key',
              'Note: Qwen-OAuth was discontinued April 15, 2026.',
            ],
          },
          {
            title: 'MCP Tools (auto-registered)',
            lines: [
              'Termpolis writes its MCP server entry to ~/.qwen/settings.json on startup.',
              'After install, run "qwen mcp list" — you should see "termpolis" listed as Connected.',
            ],
          },
        ],
        url: 'https://qwen.ai/qwencode',
        pricing: 'Free if pointed at local Ollama / vLLM. Paid tiers: Alibaba Coding Plan (monthly), or pay-per-token via OpenRouter / Fireworks / BYO API key.',
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
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 animate-fadeIn"
      onClick={onClose}
      data-testid="install-hint-backdrop"
    >
      <div
        className="bg-[#252526] rounded-lg p-6 w-96 shadow-xl border border-[#3c3c3c] flex flex-col gap-4 max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
        data-testid="install-hint-modal"
      >
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

        {info.warning && (
          <div
            className="flex items-start gap-2 p-3 bg-[#2a1f1a] border border-[#5a3a2d] rounded-lg"
            data-testid="install-hint-warning"
          >
            <i className="fa-solid fa-circle-info text-[#FFB74D] text-sm mt-0.5"></i>
            <p className="text-xs text-[#FFB74D] leading-relaxed">{info.warning}</p>
          </div>
        )}

        <div className="flex flex-col gap-2" data-testid="install-hint-steps">
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

        {info.sections?.map((section, si) => (
          <div
            key={`section-${si}`}
            className="flex flex-col gap-2 pt-1 border-t border-[#3c3c3c]"
            data-testid={`install-hint-section-${si}`}
          >
            <h3 className="text-xs font-semibold text-[#d4d4d4] uppercase tracking-wide mt-2">
              {section.title}
            </h3>
            {section.lines.map((line, li) => {
              const isCommand = /^(npm|pip|npx|claude|codex|gemini|qwen|setx|sudo|apt|brew)\b/.test(line.trim())
              if (isCommand) {
                return (
                  <div key={li} className="flex items-center gap-1 bg-[#1e1e1e] border border-[#3c3c3c] rounded px-3 py-2">
                    <span className="font-mono text-xs text-[#d4d4d4] flex-1 select-all">{line}</span>
                    <button
                      onClick={() => handleCopy(line, 1000 + si * 100 + li)}
                      className="shrink-0 text-[#9ca3af] hover:text-[#22D3EE] px-1.5 py-0.5 rounded hover:bg-[#37373d] transition-colors"
                      title="Copy to clipboard"
                    >
                      <i className={`fa-solid ${copiedIndex === 1000 + si * 100 + li ? 'fa-check text-green-400' : 'fa-copy'} text-[10px]`}></i>
                    </button>
                  </div>
                )
              }
              return (
                <p key={li} className="text-xs text-[#bbb] leading-relaxed">{line}</p>
              )
            })}
          </div>
        ))}

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
