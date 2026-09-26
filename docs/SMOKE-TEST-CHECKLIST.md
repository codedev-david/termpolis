# Termpolis Release Smoke Test Checklist

> **How to use:** Copy this checklist into a new GitHub issue (or print it) before each release. Work through every item with real agents and real shell sessions -- not mocks. Check each box as you go. If any item fails, file a bug and block the release until resolved. Mark items N/A if the feature or platform is not available in your test environment.

---

## Pre-flight

- [ ] Clean install: delete `session.json`, start fresh
- [ ] Verify app launches without errors
- [ ] Welcome screen appears

## Agent Launch (test with each installed agent)

- [ ] Launch **Claude Code** from sidebar -- directory picker opens, trust prompt auto-confirms, agent starts
- [ ] Launch **Codex** from sidebar -- trust prompt appears, agent starts
- [ ] Launch **Gemini CLI** from sidebar -- slower startup expected, agent starts
- [ ] Loading overlay appears and dismisses for each agent
- [ ] Agent detection: status bar shows correct agent badge for each running agent
- [ ] Not-installed agent: InstallHint modal appears with correct install instructions

## Terminal Features

- [ ] Create terminal via Add Terminal modal
- [ ] Copy/paste works (Ctrl+Shift+C / Ctrl+Shift+V)
- [ ] Context menu appears on right-click with expected actions
- [ ] Command autocomplete: type `git`, see suggestions
- [ ] Command fix: type `gti` instead of `git`, see correction banner
- [ ] Export terminal output to file
- [ ] Drag a file onto the terminal -- path is pasted
- [ ] Clickable URLs in terminal output open in browser
- [ ] Output pinning works
- [ ] Command history search (Ctrl+Shift+H) opens and filters correctly
- [ ] Command palette (Ctrl+K) opens and commands execute

## View Switching

- [ ] Switch to split view -- all terminals visible in grid layout
- [ ] Switch back to tabs -- correct content displayed per tab
- [ ] No "confused tabs" bug (each tab shows its own terminal content)
- [ ] Close a terminal in split view -- remaining terminals reflow correctly
- [ ] Close a terminal in tab view -- next tab activates
- [ ] Rapid toggle between split/tab view (5x) -- no freeze or visual corruption

## Swarm

- [ ] Open swarm dashboard (Ctrl+Shift+S)
- [ ] Wizard opens: select 2+ agents, describe task, review routing
- [ ] Launch swarm -- agents receive task prompts, split panes are created
- [ ] Dashboard shows agents, tasks, and messages updating
- [ ] Clear swarm works and cleans up all panes

## Session & Workspaces

- [ ] Save workspace with 2+ terminals
- [ ] Restore workspace -- all terminals reopen at correct directories
- [ ] Close app with agent terminals running, reopen -- agents re-launch at correct cwd
- [ ] Session restore shows Welcome screen during loading

## Settings & Themes

- [ ] All 7 themes apply correctly (visual check)
- [ ] Font size change takes effect immediately
- [ ] Keybinding customization works and persists
- [ ] Default shell change persists across restart
- [ ] Settings → Processes scans on open ("N processes scanned at …"); Termpolis and its own shells are not listed
- [ ] Processes (Windows): in a PowerShell terminal run `Start-Process "C:\Program Files\Git\bin\bash.exe" -ArgumentList '-c "sleep 999"' -WindowStyle Hidden`, close that terminal, wait 5 minutes, **Refresh** — it is under Leftover shells & tools, "parent exited", STUCK, with child processes; **Kill selected** → confirm → it is gone after the re-scan
- [ ] Processes (Windows): the same with `'-c "python -m http.server 8000"'` shows "serving port 8000" and no STUCK badge; kill it afterwards
- [ ] Processes (Windows): in a Git Bash terminal run `sleep 999 | cat`, wait 5 minutes, **Refresh** — nothing from that pipeline is listed; Ctrl+C it afterwards
- [ ] Processes (Windows): in a PowerShell terminal run `Start-Process cmd -ArgumentList '/c','claude'`, close that terminal, wait 5 minutes, **Refresh** — neither the Claude Code session nor its MCP servers are listed; exit it afterwards

## MCP Server

- [ ] MCP status indicator shows in status bar (localhost:9315)
- [ ] Claude Code can discover and use Termpolis MCP tools (run a tool call end-to-end)

## Cross-platform (if available)

- [ ] **Windows:** all features above work
- [ ] **macOS:** all features above work
- [ ] **Linux:** all features above work

## Sign-off

- [ ] Version number is correct in About / title bar
- [ ] No console errors visible in DevTools (Ctrl+Shift+I)
- [ ] All automated tests passing (`npm test`)

---

**Tested by:** ___________________
**Date:** ___________________
**Version:** ___________________
**Result:** PASS / FAIL
