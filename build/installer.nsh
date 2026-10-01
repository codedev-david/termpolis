; Custom NSIS include for Termpolis (wired via build.nsis.include in package.json).
;
; Refresh the Windows icon cache on install. Every Termpolis update rewrites the
; exe at the SAME path, and Windows' per-user icon cache can keep serving a STALE
; taskbar / shortcut icon even though the freshly installed exe embeds the correct
; one (the v1.15.10 generic-icon fix called out exactly this cache caveat). Asking
; the shell to rebuild the icon cache here makes an updated install show the right
; icon immediately, without the user having to clear the cache or re-pin by hand.

!include "x64.nsh"

!macro customInstall
  ; ie4uinit refreshes the current user's icon cache. -ClearIconCache evicts stale
  ; entries (e.g. an old icon cached against the shortcut / AppUserModelID) and -show
  ; asks Explorer to rebuild — running both is the robust combination for making an
  ; updated install show the new taskbar icon. The NSIS installer is 32-bit, so on
  ; 64-bit Windows $SYSDIR (System32) is redirected to SysWOW64 — which has NO
  ; ie4uinit.exe — and the refresh would silently no-op; disable that redirection so
  ; we reach the real System32 copy (harmless no-op on 32-bit Windows). Exec is
  ; fire-and-forget so a slow/blocked shell can never hang the (possibly silent
  ; auto-update) installer; harmless if it does nothing.
  ${DisableX64FSRedirection}
  Exec '"$SYSDIR\ie4uinit.exe" -ClearIconCache'
  Exec '"$SYSDIR\ie4uinit.exe" -show'
  ${EnableX64FSRedirection}
!macroend

; Uninstall removes what Termpolis wrote into Claude Code, Codex and Gemini CLI configs
; (MCP server entries, tool permissions, the SessionStart memory hook, folder trust it
; added). The app does the work itself - `--disconnect-agents` runs the same Disconnect as
; Settings > Agent integration and exits without opening a window - because only the app
; knows which entries are its own.
;
; customUnInit, not customUnInstall: customUnInstall runs after $INSTDIR is deleted, when
; there is no exe left to run. un.onInit has already closed any running Termpolis.
; Skipped on updates: the installer runs the previous version's uninstaller with --updated,
; and an update must leave the user's agent configs connected. (A reinstall started with
; --delete-app-data passes that instead of --updated, so it does disconnect: it also deletes
; Termpolis's record of what it wrote, and nothing could take those entries out later.)
;
; nsExec with a time limit, not ExecWait: ExecWait waits for as long as the app runs, so an
; app that hung (a config file on a drive that stopped answering, a startup error box nobody
; can see) would hang the uninstall with it. nsExec ends the app after 30 seconds without
; output and the uninstall goes on. Its result - the exit code, "error" or "timeout" - is
; dropped and the error flag cleared, so nothing that happens here can stop an uninstall.
; $0 is saved and restored around it.
!macro customUnInit
  ${ifNot} ${isUpdated}
    Push $0
    nsExec::Exec /TIMEOUT=30000 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --disconnect-agents'
    Pop $0
    Pop $0
    ClearErrors
  ${endIf}
!macroend
