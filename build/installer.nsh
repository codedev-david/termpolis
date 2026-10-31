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

; Close a running Termpolis before its files are replaced, without listing processes.
;
; electron-builder's own check (allowOnlyOneInstallerInstance.nsh) runs PowerShell's
; Get-CimInstance Win32_Process, or tasklist, on every install, uninstall and auto-update. On a
; monitored work computer that process query, started under Termpolis.exe, reads as discovery to
; endpoint security. This asks Windows a narrower question instead: can Termpolis.exe be opened
; for writing? Windows refuses that while anything runs from the file - the app, or a helper run
; from it as Node (ELECTRON_RUN_AS_NODE, how Termpolis starts its MCP adapter when there is no
; Node) - so the answer covers exactly what would block the update, in this install only.
;
; Something is running: it is asked to close (taskkill without /F sends its windows a close),
; then made to (taskkill /F), by name and for this user only, as electron-builder does. An update
; first gets 5 seconds to let the quitting app finish on its own. Kept honest by
; tests/electron/installerNsh.test.ts (no process query in here) and the Tests workflow's
; installer-update job (updates over a running Termpolis on every build).
;
; Defined in this include, which electron-builder reads before its own, so its check and the
; variable only that check uses are left out.

; Leaves 1 in _OUT while Termpolis.exe is in use, 0 when it is not, or not installed yet.
; Uses $R9, which customCheckAppRunning saves.
!macro termpolisExeInUse _OUT
  StrCpy ${_OUT} 0
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ClearErrors
    FileOpen $R9 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" a
    ${If} ${Errors}
      StrCpy ${_OUT} 1
    ${Else}
      FileClose $R9
    ${EndIf}
  ${EndIf}
!macroend

!macro customCheckAppRunning
  Push $R0
  Push $R1
  Push $R2
  Push $R9
  ${If} $EXEFILE != "${APP_EXECUTABLE_FILENAME}"
    !insertmacro termpolisExeInUse $R0
    ${If} $R0 == 1
    ${AndIf} ${isUpdated}
      StrCpy $R1 0
      ${DoWhile} $R0 == 1
        ${If} $R1 >= 10
          ${ExitDo}
        ${EndIf}
        Sleep 500
        IntOp $R1 $R1 + 1
        !insertmacro termpolisExeInUse $R0
      ${Loop}
    ${EndIf}
    ${If} $R0 == 1
      ${IfNot} ${isUpdated}
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +2
        Quit
      ${EndIf}
      DetailPrint "$(appClosing)"
      ExpandEnvStrings $R2 "%USERNAME%"
      StrCpy $R1 0
      ${DoWhile} $R0 == 1
        ${If} $R1 == 0
          nsExec::Exec `"$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq $R2"`
        ${Else}
          nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq $R2"`
        ${EndIf}
        Pop $R9
        Sleep 1000
        IntOp $R1 $R1 + 1
        !insertmacro termpolisExeInUse $R0
        ${If} $R0 == 1
        ${AndIf} $R1 >= 6
          ; Still in use after six tries: most likely running elevated, out of this user's reach.
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY +2
          Quit
          StrCpy $R1 1
        ${EndIf}
      ${Loop}
    ${EndIf}
  ${EndIf}
  Pop $R9
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
