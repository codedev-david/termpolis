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
