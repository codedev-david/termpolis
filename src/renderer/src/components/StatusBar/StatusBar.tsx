import { useState, useEffect } from 'react'
import { useTerminalStore } from '../../store/terminalStore'
import { ReportProblemModal } from './ReportProblemModal'
import { resetOnboarding } from '../Onboarding/OnboardingModal'
import { ContextPressureIndicator } from './ContextPressureIndicator'
import { useLiveContextPressure } from '../../hooks/useLiveContextPressure'

function HelpModal({ onClose, onReportProblem, onShowTour, appVersion }: { onClose: () => void; onReportProblem: () => void; onShowTour: () => void; appVersion: string }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 animate-fadeIn">
      <div className="bg-[#252526] rounded-lg shadow-xl border border-[#3c3c3c] w-[560px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#3c3c3c]">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <i className="fa-solid fa-book-open text-[#22D3EE]"></i>
            Quick Start Guide
            {appVersion && (
              <span data-testid="help-app-version" className="text-xs text-[#9ca3af] font-normal ml-2">
                v{appVersion}
              </span>
            )}
          </h2>
          <button onClick={onClose} className="text-[#9ca3af] hover:text-white text-lg px-1">&times;</button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-5 text-sm text-[#d4d4d4]">

          {/* What's New */}
          <section>
            <h3 className="font-semibold text-[#D97706] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-star text-xs"></i> What&apos;s New{appVersion ? ` in v${appVersion}` : ''}
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><strong>Vector memory (int8)</strong> — see what your embeddings actually cost the main thread, and store them as <code className="bg-[#3c3c3c] px-1 rounded">int8</code> for <strong>4&times; less RAM</strong> if it would help. It is willing to tell you it <em>won&apos;t</em> (<strong>Settings → Memory &amp; Learning</strong>)</li>
              <li><strong>Fixed: your private GnuPG keyring was never flagged</strong> — <code className="bg-[#3c3c3c] px-1 rounded">secring.gpg</code> had been grouped into the watcher rule&apos;s own <em>exclusion</em> list, so the rule that exists to catch it could never fire</li>
              <li><strong>Fixed: a <code className="bg-[#3c3c3c] px-1 rounded">NaN</code> limit returned the entire audit log</strong> — <code className="bg-[#3c3c3c] px-1 rounded">typeof NaN</code> is <code className="bg-[#3c3c3c] px-1 rounded">&apos;number&apos;</code>, and <code className="bg-[#3c3c3c] px-1 rounded">Math.min</code>/<code className="bg-[#3c3c3c] px-1 rounded">Math.max</code> <em>propagate</em> NaN rather than clamping it, so the 2,000-entry cap was defeated</li>
              <li><strong>Fixed: Commit Shield claimed PROTECTED after the hooks were gone</strong> — repo paths were compared with a bare <code className="bg-[#3c3c3c] px-1 rounded">!==</code>, so installing via the folder picker and uninstalling via the working directory never matched</li>
              <li><strong>Fixed: the Gemini strict-mode refusal never showed on Windows</strong> — it shelled out to <code className="bg-[#3c3c3c] px-1 rounded">printf</code>, which cmd.exe and PowerShell do not have. The <strong>block</strong> always worked; the <strong>message</strong> did not</li>
              <li><strong>Fixed: the Memory dashboard over-counted vector recalls</strong> — a search that had fallen back to keyword was still booked as a <em>vector</em> recall</li>
              <li><strong>Test coverage</strong> — 96.6% statements / 93.3% branches / 96.0% functions / 97.8% lines, with the CI gates raised to <strong>95/92/95/96</strong>. Every fix above was found by writing a test against code nobody had tested</li>
            </ul>
          </section>

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

          {/* Terminal top-bar buttons: Voice / Past AI Sessions / Model / Second Opinion */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-sliders text-xs"></i> Terminal buttons (top-right of an AI terminal)
            </h3>
            <p className="text-[#bbb] text-xs mb-1.5">These appear at the top-right of any <strong>AI terminal</strong> — an agent you launched there, or an AI CLI (<code>claude</code>, <code>codex</code>, <code>agy</code>…) you started in a plain shell.</p>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><strong><i className="fa-solid fa-microphone text-[10px]"></i> Voice</strong> — dictate into the terminal. <strong>Tap</strong> to start, tap again to stop; or <strong>hold</strong> the push-to-talk hotkey and release to send. (Enable it in <strong>Settings → Voice</strong>.)</li>
              <li><strong><i className="fa-solid fa-clock-rotate-left text-[10px]"></i> Past AI Sessions</strong> — browse every past Claude Code session on this machine and resume any one in a new terminal at its original folder.</li>
              <li><strong>Model…</strong> — switch this Claude agent's model <strong>mid-session</strong> (Fable · Opus · Sonnet · Haiku). Takes effect on the next message; cheaper models save tokens. <em>(Claude terminals only.)</em></li>
              <li><strong>Second Opinion…</strong> — have a <strong>different</strong> installed agent review the terminal's most recent answer. Pick <strong>Codex, Gemini, or Qwen</strong>, or a nested <strong>Claude</strong> model (e.g. run Opus but ask <strong>Fable</strong>). Its concise feedback is pasted back as an <strong>unsent block</strong> — send it to your agent or clear it. Only installed agents appear.</li>
            </ul>
          </section>

          {/* AI Agents */}
          <section>
            <h3 className="font-semibold text-[#D97706] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-robot text-xs"></i> AI Agents
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><strong>AI Agents</strong> section in the sidebar — one-click launch for Claude Code, Codex, Gemini CLI, Qwen Code</li>
              <li><strong>+</strong> button to add custom AI agent profiles with name, command, shell, and color</li>
              <li><strong>Workflows</strong> button — pre-built multi-terminal layouts (Claude + Shell, Full Stack Dev, Code Review)</li>
              <li><strong>Agent badge</strong> — the per-terminal status bar shows a colored badge for the agent you launched (Claude Code, Codex, Gemini, Qwen)</li>
              <li><strong>Context gauge</strong> — the bottom bar shows a live <code>ctx %</code> pill of how full the focused agent's context window is (real token counts for Claude), so you can see compaction coming</li>
              <li><strong>Agent terminals are named by default after the agent type</strong> (e.g., "Claude Code", "Codex", "Qwen Code") — <strong>right-click the terminal tab</strong> to rename it to anything you like (plus change color, theme, or font) while keeping the underlying agent intact.</li>
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

          {/* Past AI Sessions */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-clock-rotate-left text-xs"></i> Past AI Sessions
            </h3>
            <p className="text-[#bbb] text-xs mb-1.5">Browse every Claude Code session ever recorded on this machine — handy for digging up an old prompt or reusing a working approach.</p>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li>Open from the <strong>AI Agents</strong> section in the sidebar (clock-rotate-left icon)</li>
              <li>Sessions are loaded asynchronously — opening hundreds of sessions no longer freezes the app</li>
              <li>Click any session to inspect its full transcript and copy/inject pieces into a live agent</li>
            </ul>
          </section>

          {/* Live Observability Panels */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-gauge-high text-xs"></i> Live AI Observability
            </h3>
            <p className="text-[#bbb] text-xs mb-1.5">Four side-panels that surface what your agents are actually doing in real time:</p>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+A</kbd> <strong>Activity Feed</strong> — chronological log of every tool call, prompt, and response across all agent terminals</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+B</kbd> <strong>Context Pins</strong> — surface the files, snippets, and notes most relevant to your current cwd</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+D</kbd> <strong>Redundancy / Duplicate-Work</strong> — flags when two agents are about to do the same thing</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+Y</kbd> <strong>Efficiency</strong> — token + cost breakdown per agent so you can see who's burning the most</li>
              <li>All four run locally — no data leaves your machine to feed them</li>
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
              <li>33 tools: terminal management, file tree, git status, swarm coordination, shared memory (search, related-entry traversal, knowledge-graph link + walk, write, list, audit, and the background primer), and the code graph (search, locate, callers, callees, explore, impact)</li>
              <li>Secured with a 256-bit auth token (rotates every launch, localhost only)</li>
              <li>CLI tool available: <code>termpolis-cli list</code>, <code>termpolis-cli create "Dev"</code>, etc.</li>
            </ul>
          </section>

          {/* AI Security Center */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-shield-halved text-xs"></i> AI Security Center
            </h3>
            <p className="text-[#bbb] text-xs mb-1.5">Open <strong>Settings → AI Security</strong>. Layered defenses for hosted-model use — everything runs locally on your machine.</p>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><strong>Prompt watch</strong> <em>(always on — there is no toggle)</em> — every prompt you send to an AI terminal is scanned against 97 patterns (AWS / GitHub / OpenAI keys, JWTs, private keys, <code className="bg-[#3c3c3c] px-1 rounded">.env</code> / JSON / YAML assignments, and even &ldquo;here is the api key: &hellip;&rdquo;). Your text is <strong>forwarded untouched</strong> — nothing is withheld or rewritten. A hit is <strong>recorded, not blocked</strong>: by the time you press Enter the agent already holds the text, so nothing can un-send it. The audit log names <strong>what</strong> leaked (<code className="bg-[#3c3c3c] px-1 rounded">DB_PASSWORD</code>) so you know what to rotate — and <strong>never stores the value</strong>. See <strong>Settings → AI Security → Open the audit log</strong>.</li>
              <li><strong>Commit Shield</strong> <em>(on by default)</em> — the same engine at the <strong>git boundary</strong>: a <code className="bg-[#3c3c3c] px-1 rounded">git commit</code> is blocked when the <strong>staged diff</strong> carries a secret, and a <code className="bg-[#3c3c3c] px-1 rounded">git push</code> is blocked when any <strong>unpushed commit</strong> does — so a key an agent wrote to disk never lands in your history.</li>
              <li><strong>Commit Shield git hooks</strong> — the toggle alone only covers git run <em>through Termpolis</em> (the Git panel, Swarm Review). <strong>Settings → AI Security → Protect a repository</strong> installs <code className="bg-[#3c3c3c] px-1 rounded">pre-commit</code> / <code className="bg-[#3c3c3c] px-1 rounded">pre-push</code> hooks so a secret is caught <strong>however you commit</strong> — terminal, IDE, or script. They run a standalone scanner that keeps working <strong>even with Termpolis closed</strong>, <strong>chain</strong> an existing hook (husky, lint-staged) instead of overwriting it, and <strong>fail open</strong> so git is never wedged. <code className="bg-[#3c3c3c] px-1 rounded">--no-verify</code> bypasses any git hook. <em>(v1.25.6 — the protected-repo list compared paths with a bare <code className="bg-[#3c3c3c] px-1 rounded">!==</code>, so a repo added with the folder picker and removed by its working directory never matched, and it kept reporting as <strong>PROTECTED</strong> after its hooks were already gone. A control that claims to be armed when it is not is worse than one that admits it is off. It is keyed on a canonical path now — so re-check any repo you protected before 1.25.6.)</em></li>
              <li><strong>Memory scrub</strong> <em>(on by default)</em> — secrets are redacted out of a memory <em>before</em> it is hashed, embedded, or written to disk, so nothing sensitive reaches the brain in the first place.</li>
              <li><strong>Sensitive-file watcher</strong> — alerts when an agent reads <code>.env</code>, PEM, cloud-credential, or SSH-directory files. ~17 conservative rules tuned to avoid false positives on normal source code. <em>(v1.25.6 — the GnuPG rule could never fire: <code className="bg-[#3c3c3c] px-1 rounded">secring.gpg</code>, your <strong>private</strong> keyring, had been grouped into the rule's own exclusion list beside the public ones, so a read of it was never flagged. Only the <code className="bg-[#3c3c3c] px-1 rounded">pubring.*</code> entries are excluded now.)</em></li>
              <li><strong>Egress Guard</strong> <em>(on by default)</em> — flags agent network traffic to any host <strong>outside the known AI-provider allowlist</strong>, so a call to an unexpected endpoint surfaces instead of passing quietly.</li>
              <li><strong>Per-agent egress audit</strong> — every outbound network connection an agent makes is logged with host + count, viewable in <strong>Settings → AI Security → Egress Audit</strong>. JSONL log on disk for forensics.</li>
              <li><strong>Audit log</strong> <em>(on by default)</em> — security events are appended to <code className="bg-[#3c3c3c] px-1 rounded">ai-security-audit.jsonl</code> in the Termpolis user-data folder. Append-only, rotated, and wipeable from Settings.</li>
              <li><strong>ToS drift watcher</strong> — flags Anthropic / OpenAI / Google / Alibaba ToS changes that affect how your prompts are stored or used for training.</li>
              <li><strong>Strict Mode (Gemini)</strong> — auto-detects when Gemini drops to the free OAuth tier (which trains on your prompts) and blocks calls until you switch to a paid API key. <em>(v1.25.6 — the refusal <strong>message</strong> never rendered on Windows: it was written to the terminal as a typed <code className="bg-[#3c3c3c] px-1 rounded">printf</code> command, which cmd.exe and PowerShell do not have, so you saw <code className="bg-[#3c3c3c] px-1 rounded">&apos;printf&apos; is not recognized</code> instead of the explanation. The <strong>block</strong> always worked; it now says why.)</em></li>
              <li><strong>Code-chunk + env-dump detection</strong> — extra heuristics that catch obfuscated secrets and wholesale environment dumps the regex scanner alone might miss.</li>
            </ul>
          </section>

          {/* Safe Import */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-file-import text-xs"></i> Safe Import
            </h3>
            <p className="text-[#bbb] text-xs mb-1.5">Open <strong>Settings → General</strong>. Import a third-party <strong>skill, plugin, or MCP server</strong> — a few files nobody diffs, which your agent then trusts like your own words. Safe Import reads them first.</p>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><strong>Scanned before anything is installed</strong> — 41 rules over every file: outbound network calls, shell/<code className="bg-[#3c3c3c] px-1 rounded">eval</code> execution, credential and <code className="bg-[#3c3c3c] px-1 rounded">~/.ssh</code> access, obfuscated payloads, and <strong>prompt-injection hidden in the instructions</strong> (a poisoned <code className="bg-[#3c3c3c] px-1 rounded">SKILL.md</code> needs no dangerous API call — the prose <em>is</em> the exploit).</li>
              <li><strong>Red / yellow / green report</strong> — you see the exact file, line, and reason for every finding, then decide. <strong>Red can never be installed</strong>: if it can exfiltrate data or execute code, the button is gone, not just discouraged.</li>
              <li><strong>Approvals are hash-pinned</strong> — trust is keyed to the artifact's contents, so an update that quietly swaps in a credential stealer re-prompts you instead of inheriting the old yes.</li>
              <li><strong>On approval it is wired in for you</strong> — into Claude, Codex, Gemini, and/or Qwen, whichever you pick.</li>
              <li><strong>It is a static review aid, not a sandbox</strong> — Termpolis reads the artifact, it never runs it to find out what it does. A determined attacker can obfuscate past any static check, so treat a green report as "nothing obvious found", not as proof of safety.</li>
            </ul>
          </section>

          {/* Memory auto-recall */}
          <section>
            <h3 className="font-semibold text-[#D97706] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-brain text-xs"></i> Memory Auto-Recall
            </h3>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><strong>Claude Code</strong> launches with the recall instruction in its <strong>system prompt</strong> (via <code className="bg-[#3c3c3c] px-1 rounded">--append-system-prompt-file</code>) — nothing is typed into the terminal at all. Codex, Gemini, and Qwen get a <strong>short one-line note</strong> pointing them at the <code className="bg-[#3c3c3c] px-1 rounded">memory_primer</code> MCP tool. Either way the agent loads your saved memory <strong>behind the scenes</strong>, with no wall of text</li>
              <li><strong>This repo/directory first</strong> — memories for the current project (past conversations leading) take the top slots; cross-project context follows, clearly labeled</li>
              <li><strong>Background only</strong> — the agent holds the memory as context and waits for your instruction; it will not start acting on past work by itself</li>
              <li><strong>Signal, not noise</strong> — recall is relevance-gated (with a floor so it never starves), de-duplicated, and search-first, so it injects the memories that matter without bloating the context window. Writes are content-addressed too: identical information is never stored — or embedded — twice, in the vector store or on disk.</li>
              <li><strong>It learns the connections</strong> — beyond storing facts, the brain builds a <strong>knowledge graph</strong>: <code className="bg-[#3c3c3c] px-1 rounded">memory_related</code> follows similarity links, <code className="bg-[#3c3c3c] px-1 rounded">memory_link</code> records typed connections (e.g. <em>bug → solved-by → fix</em>), and <code className="bg-[#3c3c3c] px-1 rounded">memory_graph</code> walks those chains. Curated memories auto-link to their neighbours, so the graph gets denser — and the agents get faster at reusing what you've already solved — the more you use it.</li>
              <li>After Claude Code <strong>compacts</strong> its conversation, the pointer is re-injected so the agent can recover the detail it summarized away</li>
              <li>Both behaviors are opt-out in <strong>Settings → AI Memory</strong>; seeding only happens when relevant memory actually exists for the project</li>
            </ul>
          </section>

          {/* Memory Panel */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-brain text-xs"></i> The Memory Panel
            </h3>
            <p className="text-[#bbb] text-xs mb-1.5">Your window into what Termpolis remembers. Open it with <kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+M</kbd>, or from <strong>Settings → AI Memory → Open the Memory panel</strong>.</p>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><strong>See what's stored</strong> — the count of remembered chunks (and how many are in the fast in-RAM "hot" window).</li>
              <li><strong>Search your memory</strong> — type what you're working on and hit <strong>Search</strong> to semantically pull up matching past conversations and code, newest/closest first.</li>
              <li><strong>Inject primer</strong> — the token-saver: type a topic and click it to paste the most relevant memories straight into the <em>active agent's</em> terminal, so it starts already knowing the context and you don't re-explain it.</li>
              <li><strong>Index this repo's code</strong> — pull the current project's git-tracked files into memory on demand (<code className="bg-[#3c3c3c] px-1 rounded">.env</code>/keys are always skipped). Conversations index themselves automatically; code is opt-in per repo.</li>
              <li><strong>Cross-machine sync</strong> — point it at a folder you already sync (<strong>OneDrive, Google Drive, Dropbox, iCloud, Syncthing…</strong>) and the same brain follows you to every machine, with <strong>no Termpolis server</strong>. Turn on a passphrase to encrypt it at rest so the cloud provider only ever sees ciphertext — use the <em>same passphrase on every device</em>.</li>
            </ul>
          </section>

          {/* Memory & Learning dashboard */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-chart-line text-xs"></i> Memory &amp; Learning Dashboard
            </h3>
            <p className="text-[#bbb] text-xs mb-1.5">Open <strong>Settings → Memory &amp; Learning</strong>. Receipts for what the brain has actually learned — not a promise that it did.</p>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><strong>Vector memory</strong> <em>(int8 — off by default)</em> — the panel at the top. Your embeddings live in the <strong>main process</strong>, the same thread that echoes your keystrokes, so at multi-GB their RAM means GC pauses on the one thread whose stalls you feel as <strong>typing lag</strong>. Storing them as <code className="bg-[#3c3c3c] px-1 rounded">int8</code> instead of exact floats uses <strong>4&times; less vector RAM</strong>.</li>
              <li><strong>It is a decision aid, not a bare switch</strong> — nobody can answer <em>&ldquo;should I enable int8 quantization?&rdquo;</em> in the abstract, so the panel polls live and shows the numbers that actually decide it <em>on your machine</em>: the vector count and their <strong>real RAM</strong>, your <strong>main-thread stall</strong> (event-loop delay p99), <strong>GC pauses</strong>, and the vectors' <strong>share of the process</strong> — then gives a recommendation computed from those.</li>
              <li><strong>It is willing to tell you the toggle won't help you</strong> — <em>&ldquo;your main thread is stalling, but the vectors are only 4% of this process; freeing them would not fix it, and you would lose exactness for nothing.&rdquo;</em> A control that only ever markets itself is an upsell, not a tool. At a typical corpus (~100k vectors, ~160&nbsp;MB) it simply says <strong>not needed</strong>.</li>
              <li><strong>Safe to try, safe to undo</strong> — recall parity against the exact-float baseline is <strong>benchmarked and CI-gated</strong> (recall@10 identical), and it is <strong>losslessly reversible</strong>: the copy on disk <em>always</em> keeps exact floats, so int8 is purely an in-RAM representation, never a data migration. Turn it off and full precision comes back — nothing is ever destroyed.</li>
              <li><strong>Code connections</strong> — the <strong>structural</strong> code graph (symbols, plus caller/callee edges) now sits alongside the <strong>semantic</strong> memory graph, so you can see both how your code is wired and how your memories relate.</li>
              <li><strong>Self-competence learns from real work</strong> — a <strong>landed commit</strong> or a <strong>passing/failing test run</strong> feeds the per-domain calibration, so the track record comes from outcomes rather than from the agent's own say-so.</li>
              <li><strong>Recall counts say what actually ran</strong> — a search that had fallen back to keyword (because the embedder was down) used to be booked as a <em>vector</em> recall, over-counting them. A proof dashboard that flatters itself is worse than no dashboard.</li>
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
              <li className="pl-4 text-xs">Qwen Code — Alibaba Gemini-CLI fork, strong on bulk tasks (default)</li>
              <li className="pl-4 text-xs"><strong>Customize ratings</strong> in <strong>Settings &gt; Agent Capability Ratings</strong>. Defaults are estimates — adjust based on your experience. The conductor uses ratings as hints but makes its own judgment.</li>
              <li><strong>Live Launch Progress</strong> — the start modal tracks real conductor progress and closes automatically when the first task or message appears. It can take up to <strong>30 seconds</strong> for tasks to show up after launch.</li>
              <li><strong>Agents run in the background</strong> — swarm-spawned agent terminals are <em>hidden</em> from the sidebar. The conductor drives all work via MCP tools (creating files, running commands, coordinating agents) and posts progress to the dashboard. You never need to watch individual agent terminals.</li>
              <li><strong>Dashboard tabs:</strong> <strong>Tasks</strong> (kanban — Pending · In Progress · Completed · Failed) and <strong>Messages</strong> (chronological log of conductor and agent activity). The previous Agents tab was removed — per-agent status rows were misleading because the conductor does most work itself via its own native tools.</li>
              <li><strong>Clear Confirmation</strong> — clearing a swarm requires explicit confirmation to prevent accidental loss of in-progress work.</li>
              <li><strong>Swarm Complete dialog</strong> — when all tasks finish, a summary dialog appears showing completed vs failed tasks with results. Includes "What next?" guidance for iterating.</li>
              <li><strong>Swarm vs Individual Agents</strong> — swarms are best for completing a well-defined task autonomously (all agents run hidden). For back-and-forth conversations or iterating on details, launch individual agents from the <strong>AI Agents</strong> section in the sidebar — those terminals appear in the sidebar and work exactly as before.</li>
              <li><strong>Agent Install Status</strong> — the AI Agents sidebar shows <i className="fa-solid fa-circle-check text-green-400 text-[10px]"></i> for installed agents and <i className="fa-solid fa-circle-xmark text-red-400 text-[10px]"></i> for missing ones. Click a missing agent for setup instructions.</li>
              <li><strong>MCP-native swarm</strong> — every supported agent (Claude Code, Codex, Gemini, Qwen Code) talks to Termpolis via MCP. A bridge proxies non-MCP-native agents into the same protocol so the conductor's tool surface is uniform.</li>
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
              <li><kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Shift+A</kbd> Activity feed &nbsp;·&nbsp; <kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Shift+B</kbd> Context pins &nbsp;·&nbsp; <kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Shift+D</kbd> Redundancy &nbsp;·&nbsp; <kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Shift+Y</kbd> Efficiency</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Shift+S</kbd> Swarm dashboard &nbsp;·&nbsp; <kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+/</kbd> Shortcuts panel</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Shift+H</kbd> History search &nbsp;·&nbsp; <kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Space</kbd> Autocomplete</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Shift+Space</kbd> Keyboard select / copy mode (arrows move · Shift extends · Ctrl=word · a=all · Enter copies · Esc exits)</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+Shift+L</kbd> Voice dictation — tap to start/stop, or hold to talk (enable first in Settings → Voice)</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded">Ctrl+1–4</kbd> Launch first four AI agents (Claude / Codex / Gemini / Qwen)</li>
              <li><kbd className="bg-[#3c3c3c] px-1 rounded">Win+Shift+T</kbd> New terminal (global, works when minimized)</li>
              <li>All customizable — plus add your own snippet macros — in <strong>Settings → Keybindings</strong></li>
            </ul>
          </section>

          {/* Voice Dictation */}
          <section>
            <h3 className="font-semibold text-[#22D3EE] mb-1.5 flex items-center gap-2">
              <i className="fa-solid fa-microphone text-xs"></i> Voice Dictation
            </h3>
            <p className="text-[#bbb] text-xs mb-1.5">Talk instead of type. Transcription uses Groq's cloud Whisper API — your recorded audio is sent to Groq (opt-in, off by default).</p>
            <ul className="flex flex-col gap-1 text-[#bbb] leading-relaxed">
              <li><strong>Turn it on first</strong> in <strong>Settings → Voice</strong> — it's off by default — then <strong>Connect Groq</strong> (paste a free Groq API key). The key is validated and stored encrypted in your OS keychain; it never touches settings or logs.</li>
              <li><strong>Tap <kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Ctrl+Shift+L</kbd> to start and tap again to stop — or hold it to talk and release to send.</strong> Both work on the same key by default (tap-or-hold). Pure hold, tap-to-toggle, and tap-then-send-key modes are selectable under <strong>Activation</strong>, and both the hotkey and the send key are rebindable.</li>
              <li><strong>Wait for the "Listening…" badge, then speak normally.</strong> Groq's Whisper model is tuned for <strong>English</strong>. If the mic catches no speech you'll see <strong>"No speech detected"</strong> — hold the key, speak, and release again (Termpolis never injects a guessed phrase, and never sends silence to Groq).</li>
              <li><strong>In an AI-agent terminal</strong> (Claude · Codex · Gemini · Qwen) your words are <strong>sent straight to the agent as a prompt</strong> — it absorbs minor mis-hearings, so just talk naturally.</li>
              <li><strong>In a plain shell</strong> the transcript is <em>inserted but never run automatically</em> — you review it and press <kbd className="bg-[#3c3c3c] px-1 rounded text-xs">Enter</kbd> yourself (a mis-heard command is never executed for you).</li>
              <li><strong>When dictation ends the caret returns to the terminal</strong> — keep typing or start another dictation right away, no clicking back in.</li>
              <li><strong>Privacy</strong> — only the few seconds you dictate are sent, and only to Groq. By default Groq does not train on or retain it; for the hardened setup, enable <strong>Zero Data Retention</strong> in your Groq console (the Connect dialog links you there). Free tier covers everyday use; paid is ~$0.04/hr of audio.</li>
              <li>If transcription fails, check your <strong>Groq API key</strong> in <strong>Settings → Voice</strong> and your internet connection — the red error bar will say what went wrong.</li>
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
            <button
              onClick={onReportProblem}
              className="text-[#D97706] hover:underline text-sm flex items-center gap-1.5"
              data-testid="help-report-problem"
            >
              <i className="fa-solid fa-bug"></i>
              Report a problem
            </button>
            <button
              onClick={onShowTour}
              className="text-[#22D3EE] hover:underline text-sm flex items-center gap-1.5"
              data-testid="help-show-tour"
            >
              <i className="fa-solid fa-route"></i>
              Show tour again
            </button>
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
  const [showReport, setShowReport] = useState(false)
  const [appVersion, setAppVersion] = useState<string>('')
  const swarmActive = useTerminalStore((s) => s.swarmActive)
  const swarmAgents = useTerminalStore((s) => s.swarmAgents)
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId)
  const contextPressure = useLiveContextPressure(activeTerminalId)

  useEffect(() => {
    window.termpolis.getAppVersion?.().then(res => {
      if (res?.success && res.data) setAppVersion(res.data.version)
    }).catch(() => {})
  }, [])

  const runningCount = swarmAgents.filter(a => a.status === 'thinking' || a.status === 'working').length
  const errorCount = swarmAgents.filter(a => a.status === 'errored').length

  return (
    <>
      <div className="flex items-center justify-between px-3 py-1 bg-[#1a1a1a] border-t border-[#3c3c3c] text-[#9ca3af] text-xs select-none shrink-0">
        <span>
          &copy; {new Date().getFullYear()} Termpolis &middot; Apache 2.0 License
          {appVersion && (
            <span data-testid="footer-app-version" className="ml-2 text-[#6b7280]">
              &middot; v{appVersion}
            </span>
          )}
        </span>
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
          <ContextPressureIndicator pressure={contextPressure} />
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
            title="Open Help & Keyboard Shortcuts (Ctrl+/)"
          >Help / Support</button>
        </div>
      </div>
      {showHelp && (
        <HelpModal
          onClose={() => setShowHelp(false)}
          onReportProblem={() => { setShowHelp(false); setShowReport(true) }}
          onShowTour={() => {
            resetOnboarding()
            setShowHelp(false)
            window.dispatchEvent(new CustomEvent('termpolis:reopenOnboarding'))
          }}
          appVersion={appVersion}
        />
      )}
      {showReport && <ReportProblemModal onClose={() => setShowReport(false)} />}
    </>
  )
}
