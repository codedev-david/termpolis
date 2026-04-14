import React, { useState } from 'react'
import { useTerminalStore } from '../../store/terminalStore'

function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 animate-fadeIn">
      <div className="bg-[#252526] rounded-lg shadow-xl border border-[#3c3c3c] w-[560px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#3c3c3c]">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <i className="fa-solid fa-book-open text-[#22D3EE]"></i>
            Quick Start Guide
          </h2>
          <button onClick={onClose} className="text-[#9ca3af] hover:text-white text-lg px-1">&times;</button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-5 text-sm text-[#d4d4d4]">

          {/* Sidebar Icons */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-icons text-xs"></i> Sidebar Icon Bar
            </h3>
            <p className="text-[#bbb] text-xs mb-2">The icons at the top of the sidebar (left to right):</p>
            <ul className="flex flex-col gap-1.5 text-[#bbb] leading-relaxed">
              <li><i className="fa-solid fa-gear text-[#999] w-5 inline-block text-center"></i> <strong>Settings</strong> — open settings panel (default shell, keybindings, shell config editor)</li>
              <li><i className="fa-solid fa-columns text-[#999] w-5 inline-block text-center"></i> <strong>Split View</strong> / <i className="fa-solid fa-bars text-[#999] w-5 inline-block text-center"></i> <strong>Tab View</strong> — toggle between views</li>
              <li><i className="fa-solid fa-message text-[#999] w-5 inline-block text-center"></i> <strong>Prompts</strong> — open prompt templates (<kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+P</kbd>)</li>
              <li><i className="fa-solid fa-cubes text-[#999] w-5 inline-block text-center"></i> <strong>Workflows</strong> — launch pre-built multi-terminal AI workflows</li>
              <li><i className="fa-solid fa-network-wired text-[#999] w-5 inline-block text-center"></i> <strong>Swarm</strong> — open the multi-agent swarm dashboard (<kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+S</kbd>)</li>
              <li><i className="fa-solid fa-chevron-left text-[#999] w-5 inline-block text-center"></i> <strong>Collapse</strong> — collapse the sidebar (<kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+B</kbd>)</li>
            </ul>
          </section>

          {/* Terminals */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-terminal text-xs"></i> Terminals
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><strong>+ Add Terminal</strong> — create a new terminal with custom name, shell, theme, font, and color</li>
              <li><strong>Click a terminal</strong> in the sidebar to switch to it</li>
              <li><strong>Alt+1–9</strong> — jump to a terminal by its number</li>
              <li><strong>Right-click a terminal name</strong> to edit its name, color, theme, and font after creation</li>
              <li><strong>Drag files</strong> onto a terminal to paste their file paths</li>
              <li><strong>Close</strong> with the &times; button or <kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+W</kbd></li>
            </ul>
          </section>

          {/* Split View */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-columns text-xs"></i> Split View
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li>Click <strong>Split View</strong> in the sidebar to see all terminals at once</li>
              <li><strong>Right-click</strong> inside a terminal → <strong>Split Right</strong> or <strong>Split Down</strong></li>
              <li><strong>Drag the dividers</strong> between panes to resize them</li>
              <li>Use the header buttons <i className="fa-solid fa-columns text-[10px]"></i> and <i className="fa-solid fa-grip-lines text-[10px]"></i> to split from the pane header</li>
            </ul>
          </section>

          {/* AI Agents */}
          <section>
            <h3 className="font-semibold text-[#D97706] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-robot text-xs"></i> AI Agents
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><strong>AI Agents</strong> section in the sidebar — one-click launch for Claude Code, Codex, Aider, Copilot</li>
              <li><strong>+</strong> button to add custom AI agent profiles with name, command, shell, and color</li>
              <li><strong>Workflows</strong> button — pre-built multi-terminal layouts (Claude + Shell, Full Stack Dev, Code Review)</li>
              <li><strong>Agent detection</strong> — status bar automatically shows a colored badge when an AI agent is running</li>
              <li><strong>Cost tracking</strong> — parses token usage and costs from AI output, shown next to the agent badge</li>
            </ul>
          </section>

          {/* Command Palette */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-magnifying-glass text-xs"></i> Command Palette
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+K</kbd> — open the command palette</li>
              <li>Type what you want to do: "new terminal", "split right", "launch claude", "open settings"</li>
              <li>Matches commands as you type — Enter to execute, Esc to close</li>
              <li>Works without any API keys — all local pattern matching</li>
            </ul>
          </section>

          {/* Prompt Templates */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-message text-xs"></i> Prompt Templates
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+P</kbd> or click <strong>Prompts</strong> in the sidebar</li>
              <li>Built-in templates: Fix Tests, Code Review, Explain Code, Refactor, Write Tests, Add Docs</li>
              <li>Click a template to insert its text into the active terminal</li>
              <li>Add your own custom templates with the <strong>+</strong> button</li>
            </ul>
          </section>

          {/* Session Recording */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-circle text-xs text-red-500"></i> Session Recording
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><strong>Right-click</strong> → <strong>Start Recording</strong> to record a terminal session</li>
              <li>A red <span className="text-red-400">REC</span> indicator appears in the status bar while recording</li>
              <li><strong>Right-click</strong> → <strong>Stop Recording &amp; Save</strong> to export as a timestamped text log</li>
              <li>Great for documenting AI agent sessions or debugging workflows</li>
            </ul>
          </section>

          {/* Output Pinning */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-thumbtack text-xs"></i> Output Pinning
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li>Select text in the terminal → <strong>Right-click</strong> → <strong>Pin Selection</strong></li>
              <li>Pinned items appear in a collapsible panel at the top of the terminal</li>
              <li>Stays visible as the terminal scrolls — great for keeping AI output visible while testing</li>
            </ul>
          </section>

          {/* Context Panel & Diff Viewer */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-folder-tree text-xs"></i> Context Panel & Diff Viewer
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+E</kbd> — toggle the Smart Context Panel (file tree, git status, recent commits)</li>
              <li>When <code>git diff</code> output is detected, a <strong>View Diff</strong> button appears</li>
              <li>Right-click → <strong>View as Diff</strong> to render any output with syntax-highlighted diff view</li>
            </ul>
          </section>

          {/* Conversation History */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-comments text-xs"></i> Conversation History
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+I</kbd> — search across all AI agent conversations</li>
              <li>Conversations are automatically indexed when an AI agent is detected</li>
              <li>Search by keyword — results grouped by terminal and agent, click to jump</li>
            </ul>
          </section>

          {/* MCP Server */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-plug text-xs"></i> MCP Server & Claude Code Integration
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li>Termpolis runs an MCP server on <strong>localhost:9315</strong> (shown in the bottom bar)</li>
              <li>AI agents can create terminals, run commands, read output, and manage your workspace</li>
              <li><strong>Auto-registers with Claude Code</strong> — on launch, Termpolis adds itself to your Claude Code settings automatically. No manual config needed.</li>
              <li>14 tools: terminal management, file tree, git status, and swarm coordination</li>
              <li>Secured with a 256-bit auth token (rotates every launch, localhost only)</li>
              <li>CLI tool available: <code>termpolis-cli list</code>, <code>termpolis-cli create "Dev"</code>, etc.</li>
            </ul>
          </section>

          {/* Context Handoff */}
          <section>
            <h3 className="font-semibold text-[#D97706] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-arrow-right-arrow-left text-xs"></i> Agent Context Handoff
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li>When an AI agent <strong>runs out of context/tokens</strong>, an amber banner appears automatically</li>
              <li>Click <strong>Switch to Codex</strong>, <strong>Gemini</strong>, or <strong>Aider</strong> to hand off instantly</li>
              <li>Your working context transfers automatically: task description, git branch, modified files, recent commands, and diff summary</li>
              <li>Click <strong>More Options</strong> to preview/edit the handoff prompt before switching</li>
              <li>Choose to keep the old terminal open for reference or close it</li>
            </ul>
          </section>

          {/* Multi-Agent Swarm */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-network-wired text-xs"></i> Multi-Agent Swarm &amp; AI Conductor
            </h3>
            <p className="text-[#bbb] text-xs mb-1.5">The flagship feature — a dedicated Claude Code AI conductor orchestrates a team of AI agents working on the same task simultaneously.</p>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+S</kbd> or the <i className="fa-solid fa-network-wired text-[10px]"></i> sidebar icon opens the <strong>Swarm Dashboard</strong>. You can also click <strong>Swarm Active</strong> in the bottom status bar.</li>
              <li><strong>AI Conductor</strong> — a real Claude Code instance runs as the conductor. It reads your task, reasons about how to break it down, assigns subtasks to agents via MCP, and monitors progress. Not keyword matching — live AI orchestration.</li>
              <li><strong>Agent Command Enforcement</strong> — agents are guaranteed to launch correctly. A programmatic sanitizer enforces the exact approved command for each agent (Claude gets <code className="bg-[#3c3c3c] px-1 rounded">--dangerously-skip-permissions</code>, Codex gets <code className="bg-[#3c3c3c] px-1 rounded">--full-auto</code>). No trust prompts or permission dialogs during swarms.</li>
              <li><strong>Smart Task Routing</strong> — the conductor assigns each subtask to the best agent based on a customizable capability matrix:</li>
              <li className="pl-4 text-xs">Claude Code — strongest at refactoring and code review (default)</li>
              <li className="pl-4 text-xs">Codex — best at test writing (default)</li>
              <li className="pl-4 text-xs">Gemini CLI — leads in documentation and DevOps (default)</li>
              <li className="pl-4 text-xs">Aider + Qwen3 — free local model for bulk tasks (default)</li>
              <li className="pl-4 text-xs"><strong>Customize ratings</strong> in <strong>Settings &gt; Agent Capability Ratings</strong>. Defaults are estimates — adjust based on your experience. The conductor uses ratings as hints but makes its own judgment.</li>
              <li><strong>Live Launch Progress</strong> — the start modal tracks real conductor progress (tasks created, terminals opened) and closes automatically when agents are ready. You land on the Swarm Dashboard to watch agents work.</li>
              <li><strong>Clear Confirmation</strong> — clearing a swarm requires explicit confirmation to prevent accidental loss of in-progress work.</li>
              <li><strong>Swarm Complete dialog</strong> — when all tasks finish, a summary dialog appears showing completed vs failed tasks with results from each agent. Includes "What next?" guidance for iterating.</li>
              <li><strong>Swarm vs Individual Agents</strong> — swarms are best for completing a well-defined task autonomously. For back-and-forth conversations or iterating on details, launch individual agents from the <strong>AI Agents</strong> section in the sidebar. After a swarm finishes, use individual agents to refine the work or start a new swarm.</li>
              <li><strong>Agent Install Status</strong> — the AI Agents sidebar shows <i className="fa-solid fa-circle-check text-green-400 text-[10px]"></i> for installed agents and <i className="fa-solid fa-circle-xmark text-red-400 text-[10px]"></i> for missing ones. Click a missing agent for setup instructions.</li>
              <li><strong>Agent Bridge</strong> — agents without native MCP (e.g., Aider) are bridged automatically. Claude Code, Codex, and Gemini all use MCP natively.</li>
              <li><strong>Dashboard tabs:</strong> Agents (health status) · Tasks (kanban columns) · Messages (chronological log)</li>
              <li><strong>Free option:</strong> Aider + Qwen3-Coder via Ollama — zero API cost, fully local</li>
            </ul>
          </section>

          {/* Git Panel */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-brands fa-git-alt text-xs"></i> Git Panel
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li>Click the <i className="fa-brands fa-git-alt text-[10px]"></i> icon in the sidebar to open the Git Panel</li>
              <li><strong>Auto-detects</strong> git repos from your terminal's directory, or pick any folder manually</li>
              <li>View <strong>current branch</strong>, <strong>staged</strong> and <strong>unstaged</strong> files with status indicators (M/A/D/R/U)</li>
              <li><strong>Stage/Unstage</strong> individual files or all at once with one click</li>
              <li>Type a commit message and press <kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Enter</kbd> to commit</li>
              <li><strong>Pull</strong> and <strong>Push</strong> buttons in the header</li>
              <li>Click any file to view an <strong>inline diff</strong> with syntax highlighting (green = added, red = removed)</li>
              <li>Auto-refreshes every 3 seconds — like VS Code's source control panel</li>
            </ul>
          </section>

          {/* AI Command Suggestions */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-wand-magic-sparkles text-xs"></i> AI Command Suggestions
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li>Type <strong>natural language</strong> in any terminal and get instant shell command suggestions</li>
              <li>Examples: "find large files", "undo last commit", "what's on port 3000", "kill port 8080"</li>
              <li><strong>30+ built-in patterns</strong> — file search, git ops, npm/yarn, Docker, process management, system info, compression, downloads</li>
              <li>Captures values from your input: "kill port 3000" becomes <code className="bg-[#2d2d2d] px-1 rounded">kill $(lsof -t -i:3000)</code></li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Tab</kbd> to accept, <kbd className="bg-[#3c3c3c] px-1 rounded text-xs">↑↓</kbd> to navigate, <kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Esc</kbd> to dismiss</li>
              <li><strong>Zero latency</strong> — all local pattern matching, no API calls</li>
            </ul>
          </section>

          {/* Autocomplete & Auto-Fix */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-bolt text-xs"></i> Autocomplete & Auto-Fix
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li>Start typing — suggestions appear after 2 characters. <kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Tab</kbd> to accept, <kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Esc</kbd> to dismiss</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Space</kbd> to trigger manually</li>
              <li>Mistype a command? Green banner suggests the fix — <kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Enter</kbd> to run, <kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Esc</kbd> to ignore</li>
            </ul>
          </section>

          {/* Workspaces */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-layer-group text-xs"></i> Workspaces
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><strong>+ Save Workspace</strong> — snapshot all terminals (names, shells, themes, directories)</li>
              <li><strong>Click a workspace</strong> to restore it — terminals reopen in their saved directories</li>
              <li>Click the <i className="fa-solid fa-circle-info text-[10px]"></i> icon for more details</li>
            </ul>
          </section>

          {/* Themes */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-palette text-xs"></i> Themes, Fonts & Export
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li>7 themes: Dark, Light, Solarized Dark/Light, Monokai, Dracula, Nord</li>
              <li>Per-terminal theme, font size (8-32px), and font family</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+C</kbd>/<kbd className="bg-[#3c3c3c] px-1 rounded text-xs">V</kbd> for copy/paste</li>
              <li><strong>Right-click</strong> inside any terminal for the full context menu:</li>
              <li className="pl-4 text-xs">Copy · Paste · Select All · Export Full Scrollback · Export Visible Output · Pin Selection · Start/Stop Recording · Split Right/Down · View as Diff</li>
              <li>In split view, each pane header also has export <i className="fa-solid fa-download text-[10px] text-[#999]"></i> and split buttons</li>
            </ul>
          </section>

          {/* Keyboard Shortcuts */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-keyboard text-xs"></i> All Keyboard Shortcuts
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed text-xs">
              <li><kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+K</kbd> Command palette</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Shift+T</kbd> New terminal &nbsp;·&nbsp; <kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Shift+W</kbd> Close terminal</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Tab</kbd> / <kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Shift+Tab</kbd> Next / Previous &nbsp;·&nbsp; <kbd className="bg-[#3c3c3c] px-1 rounded">Alt+1–9</kbd> Jump to terminal</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+B</kbd> Toggle sidebar &nbsp;·&nbsp; <kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Shift+G</kbd> Toggle split view</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Shift+P</kbd> Prompts &nbsp;·&nbsp; <kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Shift+E</kbd> Context panel &nbsp;·&nbsp; <kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Shift+I</kbd> Conversation search</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Shift+S</kbd> Swarm dashboard</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Shift+H</kbd> History search &nbsp;·&nbsp; <kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Space</kbd> Autocomplete</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded">Win+Shift+T</kbd> New terminal (global, works when minimized)</li>
              <li>All customizable in <strong>Settings → Keybindings</strong></li>
            </ul>
          </section>

          {/* Bundled Tools */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-toolbox text-xs"></i> Bundled Tools
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><strong>jq</strong>, <strong>yq</strong>, and <strong>nano</strong> are available out of the box</li>
              <li>If not already on your system, Termpolis ships them automatically</li>
            </ul>
          </section>

          {/* Accessibility */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-universal-access text-xs"></i> Accessibility
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><strong>WCAG AA contrast</strong> — all text meets the 4.5:1 minimum contrast ratio for readability</li>
              <li><strong>Agent install indicators</strong> — clear <i className="fa-solid fa-circle-check text-green-400 text-[10px]"></i> / <i className="fa-solid fa-circle-xmark text-red-400 text-[10px]"></i> icons show install status at a glance</li>
              <li><strong>Confirmation dialogs</strong> — destructive actions (clearing a swarm) require explicit confirmation</li>
              <li><strong>Keyboard accessible</strong> — all major features have keyboard shortcuts (see shortcuts above)</li>
            </ul>
          </section>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-[#3c3c3c]">
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/codedev-david/termpolis"
              onClick={e => { e.preventDefault(); window.open('https://github.com/codedev-david/termpolis', '_blank') }}
              className="text-[#22D3EE] hover:underline text-sm flex items-center gap-1.5"
            >
              <i className="fa-brands fa-github"></i>
              GitHub
            </a>
            <a
              href="https://github.com/sponsors/codedev-david"
              onClick={e => { e.preventDefault(); window.open('https://github.com/sponsors/codedev-david', '_blank') }}
              className="text-[#ea4aaa] hover:underline text-sm flex items-center gap-1.5"
            >
              <i className="fa-solid fa-heart"></i>
              Sponsor this project
            </a>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
          >Close</button>
        </div>
      </div>
    </div>
  )
}

interface StatusBarProps {
  onSwarmClick?: () => void
}

export function StatusBar({ onSwarmClick }: StatusBarProps) {
  const [showHelp, setShowHelp] = useState(false)
  const swarmActive = useTerminalStore((s) => s.swarmActive)
  const swarmAgents = useTerminalStore((s) => s.swarmAgents)

  const runningCount = swarmAgents.filter(a => a.status === 'running').length
  const errorCount = swarmAgents.filter(a => a.status === 'error').length

  return (
    <>
      <div className="flex items-center justify-between px-3 py-1 bg-[#1a1a1a] border-t border-[#3c3c3c] text-[#9ca3af] text-xs select-none shrink-0">
        <span>&copy; {new Date().getFullYear()} Termpolis &middot; MIT License</span>
        <div className="flex items-center gap-3">
          {swarmActive && (
            <button
              onClick={onSwarmClick}
              className="flex items-center gap-1.5 text-[#22D3EE] hover:text-[#67e8f9] transition-colors cursor-pointer"
              title="Open Swarm Dashboard"
            >
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#22D3EE] animate-pulse"></span>
              <i className="fa-solid fa-network-wired text-[10px]"></i>
              Swarm Active
              {swarmAgents.length > 0 && (
                <span className="text-[10px] text-[#9ca3af]">({runningCount}/{swarmAgents.length})</span>
              )}
              {errorCount > 0 && (
                <span className="text-[10px] text-red-400">{errorCount} err</span>
              )}
            </button>
          )}
          <span className="flex items-center gap-1.5 text-[#22D3EE]" title="MCP server for AI agent integration">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#22D3EE]"></span>
            MCP: localhost:9315
          </span>
          <a
            href="https://github.com/sponsors/codedev-david"
            onClick={e => { e.preventDefault(); window.open('https://github.com/sponsors/codedev-david', '_blank') }}
            className="text-[#ea4aaa] hover:text-[#f472b6] transition-colors flex items-center gap-1"
            title="Sponsor this project"
          >
            <i className="fa-solid fa-heart text-[10px]"></i>
            Sponsor
          </a>
          <button
            onClick={() => setShowHelp(true)}
            className="hover:text-[#22D3EE] transition-colors"
          >Help / Support</button>
        </div>
      </div>
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    </>
  )
}
