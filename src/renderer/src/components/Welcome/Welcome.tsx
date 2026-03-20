import React from 'react'

interface WelcomeProps {
  onNewTerminal: () => void
  onLaunchAgent: () => void
  onImportWorkspace: () => void
}

export function Welcome({ onNewTerminal, onLaunchAgent, onImportWorkspace }: WelcomeProps) {
  return (
    <div className="flex items-center justify-center h-full w-full select-none">
      <div className="flex flex-col items-center gap-8 max-w-xl px-6">
        {/* Logo / Icon */}
        <div className="w-16 h-16 rounded-2xl bg-[#22D3EE]/10 border border-[#22D3EE]/20 flex items-center justify-center">
          <i className="fa-solid fa-terminal text-[#22D3EE] text-2xl"></i>
        </div>

        {/* Title */}
        <div className="text-center">
          <h1 className="text-xl font-semibold text-[#d4d4d4] mb-1">Welcome to Termpolis</h1>
          <p className="text-sm text-[#6b7280]">The AI-native terminal for developers</p>
        </div>

        {/* Action Cards */}
        <div className="grid grid-cols-3 gap-3 w-full">
          <button
            onClick={onNewTerminal}
            className="flex flex-col items-center gap-2 p-4 rounded-lg border border-[#3c3c3c] bg-[#252526] hover:bg-[#2a2d2e] hover:border-[#22D3EE]/40 transition-colors text-center group"
          >
            <div className="w-10 h-10 rounded-lg bg-[#37373d] group-hover:bg-[#22D3EE]/10 flex items-center justify-center transition-colors">
              <i className="fa-solid fa-terminal text-[#22D3EE]"></i>
            </div>
            <span className="text-sm font-medium text-[#d4d4d4]">New Terminal</span>
            <span className="text-[10px] text-[#6b7280] leading-tight">Create a terminal with custom shell and theme</span>
          </button>

          <button
            onClick={onLaunchAgent}
            className="flex flex-col items-center gap-2 p-4 rounded-lg border border-[#3c3c3c] bg-[#252526] hover:bg-[#2a2d2e] hover:border-[#D97706]/40 transition-colors text-center group"
          >
            <div className="w-10 h-10 rounded-lg bg-[#37373d] group-hover:bg-[#D97706]/10 flex items-center justify-center transition-colors">
              <i className="fa-solid fa-robot text-[#D97706]"></i>
            </div>
            <span className="text-sm font-medium text-[#d4d4d4]">Launch AI Agent</span>
            <span className="text-[10px] text-[#6b7280] leading-tight">Start Claude Code, Codex, or Gemini CLI</span>
          </button>

          <button
            onClick={onImportWorkspace}
            className="flex flex-col items-center gap-2 p-4 rounded-lg border border-[#3c3c3c] bg-[#252526] hover:bg-[#2a2d2e] hover:border-[#A5D6A7]/40 transition-colors text-center group"
          >
            <div className="w-10 h-10 rounded-lg bg-[#37373d] group-hover:bg-[#A5D6A7]/10 flex items-center justify-center transition-colors">
              <i className="fa-solid fa-layer-group text-[#A5D6A7]"></i>
            </div>
            <span className="text-sm font-medium text-[#d4d4d4]">Import Workspace</span>
            <span className="text-[10px] text-[#6b7280] leading-tight">Load a saved workspace to restore your setup</span>
          </button>
        </div>

        {/* Feature Highlights */}
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[11px] text-[#555]">
          <span>Ctrl+K Command Palette</span>
          <span className="text-[#3c3c3c]">·</span>
          <span>Split Panes</span>
          <span className="text-[#3c3c3c]">·</span>
          <span>Autocomplete</span>
          <span className="text-[#3c3c3c]">·</span>
          <span>Session Recording</span>
          <span className="text-[#3c3c3c]">·</span>
          <span>MCP Server</span>
        </div>

        {/* Hint */}
        <p className="text-[11px] text-[#555]">
          Press <kbd className="bg-[#3c3c3c] px-1 py-0.5 rounded text-[10px] text-[#999]">Ctrl+K</kbd> to open the command palette, or click <strong className="text-[#6b7280]">+ Add Terminal</strong> in the sidebar
        </p>
      </div>
    </div>
  )
}
