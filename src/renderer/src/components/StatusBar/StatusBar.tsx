import React, { useState } from 'react'

function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#252526] rounded-lg shadow-xl border border-[#3c3c3c] w-[520px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#3c3c3c]">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <i className="fa-solid fa-book-open text-[#4FC3F7]"></i>
            Quick Start Guide
          </h2>
          <button onClick={onClose} className="text-[#6b7280] hover:text-white text-lg px-1">&times;</button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-5 text-sm text-[#d4d4d4]">

          {/* Terminals */}
          <section>
            <h3 className="font-semibold text-[#4FC3F7] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-terminal text-xs"></i> Terminals
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><strong>+ Add Terminal</strong> — create a new terminal with custom name, shell, theme, font, and color</li>
              <li><strong>Click a terminal</strong> in the sidebar to switch to it</li>
              <li><strong>Right-click a terminal name</strong> to edit its name, color, theme, and font after creation</li>
              <li><strong>Close</strong> a terminal with the &times; button or <kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+W</kbd></li>
            </ul>
          </section>

          {/* Split View */}
          <section>
            <h3 className="font-semibold text-[#4FC3F7] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-columns text-xs"></i> Split View
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li>Click <strong>Split View</strong> in the sidebar to see all terminals at once</li>
              <li><strong>Right-click</strong> inside a terminal → <strong>Split Right</strong> or <strong>Split Down</strong> to divide panes</li>
              <li><strong>Drag the dividers</strong> between panes to resize them</li>
              <li>Use the header buttons <i className="fa-solid fa-columns text-[10px]"></i> and <i className="fa-solid fa-grip-lines text-[10px]"></i> to split from the pane header</li>
            </ul>
          </section>

          {/* Autocomplete */}
          <section>
            <h3 className="font-semibold text-[#4FC3F7] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-wand-magic-sparkles text-xs"></i> Autocomplete
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li>Start typing a command — suggestions appear automatically after 2 characters</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Tab</kbd> to accept, <kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Esc</kbd> to dismiss, arrow keys to navigate</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Space</kbd> to trigger manually at any time</li>
              <li>Supports 20+ commands with subcommands and flags (git, docker, npm, kubectl, etc.)</li>
              <li>Toggle on/off in <strong>Settings</strong></li>
            </ul>
          </section>

          {/* Command Auto-Fix */}
          <section>
            <h3 className="font-semibold text-[#4FC3F7] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-wrench text-xs"></i> Command Auto-Fix
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li>Mistype a command? A green banner suggests the fix automatically</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Enter</kbd> to run the fix, <kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Esc</kbd> to ignore</li>
              <li>Detects typos, permission errors, wrong flags, and more</li>
            </ul>
          </section>

          {/* Workspaces */}
          <section>
            <h3 className="font-semibold text-[#4FC3F7] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-layer-group text-xs"></i> Workspaces
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><strong>+ Save Workspace</strong> — snapshot all current terminals (names, shells, themes, directories)</li>
              <li><strong>Click a workspace</strong> to restore it — closes current terminals and reopens the saved set</li>
              <li>Great for switching between projects</li>
            </ul>
          </section>

          {/* Themes & Customization */}
          <section>
            <h3 className="font-semibold text-[#4FC3F7] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-palette text-xs"></i> Themes & Fonts
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li>7 built-in themes: Dark, Light, Solarized, Monokai, Dracula, Nord</li>
              <li>Each terminal can have its own theme, font size (8-32px), and font family</li>
              <li>Change anytime by right-clicking the terminal name in the sidebar</li>
            </ul>
          </section>

          {/* Export & Copy/Paste */}
          <section>
            <h3 className="font-semibold text-[#4FC3F7] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-copy text-xs"></i> Copy, Paste & Export
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+C</kbd> to copy, <kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+V</kbd> to paste</li>
              <li><strong>Right-click</strong> for Copy, Paste, Select All</li>
              <li><strong>Export</strong> terminal output to a text file — full scrollback or visible output</li>
            </ul>
          </section>

          {/* Keyboard Shortcuts */}
          <section>
            <h3 className="font-semibold text-[#4FC3F7] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-keyboard text-xs"></i> Keyboard Shortcuts
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+T</kbd> — New terminal</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+W</kbd> — Close terminal</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Tab</kbd> / <kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+Tab</kbd> — Next / Previous terminal</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+H</kbd> — Search command history</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+B</kbd> — Toggle sidebar</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+G</kbd> — Toggle split view</li>
              <li>All shortcuts are customizable in <strong>Settings → Keybindings</strong></li>
            </ul>
          </section>

          {/* Status Bar */}
          <section>
            <h3 className="font-semibold text-[#4FC3F7] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-info-circle text-xs"></i> Status Bar
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li>Blue bar at the bottom of each terminal shows shell type, current directory, and git branch</li>
              <li>URLs in terminal output are clickable — they open in your default browser</li>
            </ul>
          </section>

          {/* Bundled Tools */}
          <section>
            <h3 className="font-semibold text-[#4FC3F7] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-toolbox text-xs"></i> Bundled Tools
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><strong>jq</strong>, <strong>yq</strong>, <strong>curl</strong>, and <strong>nano</strong> are available out of the box</li>
              <li>If not already on your system, Termpolis ships them automatically</li>
            </ul>
          </section>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-[#3c3c3c]">
          <a
            href="https://github.com/codedev-david/termpolis"
            onClick={e => { e.preventDefault(); window.open('https://github.com/codedev-david/termpolis', '_blank') }}
            className="text-[#4FC3F7] hover:underline text-sm flex items-center gap-1.5"
          >
            <i className="fa-brands fa-github"></i>
            GitHub — Issues, Releases & Source Code
          </a>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm rounded bg-[#0078d4] hover:bg-[#106ebe] text-white"
          >Close</button>
        </div>
      </div>
    </div>
  )
}

export function StatusBar() {
  const [showHelp, setShowHelp] = useState(false)

  return (
    <>
      <div className="flex items-center justify-between px-3 py-1 bg-[#1a1a1a] border-t border-[#3c3c3c] text-[#6b7280] text-xs select-none shrink-0">
        <span>&copy; {new Date().getFullYear()} Termpolis &middot; MIT License</span>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[#4FC3F7]" title="MCP server for AI agent integration">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#4FC3F7]"></span>
            MCP: localhost:9315
          </span>
        <button
          onClick={() => setShowHelp(true)}
          className="hover:text-[#4FC3F7] transition-colors"
        >Help / Support</button>
        </div>
      </div>
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    </>
  )
}
