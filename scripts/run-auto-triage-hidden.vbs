' Windowless launcher for the Termpolis auto-triage scheduled task.
'
' The scheduled task runs THIS via wscript.exe. WshShell.Run with window style 0
' launches PowerShell completely hidden -- no console window, not even the brief
' flash you get from `powershell -WindowStyle Hidden` (that still spawns conhost
' for a moment). We keep the exact same interactive user context (so gh auth and
' the PATH self-healing in auto-triage.ps1 still work); we ONLY hide the window.
'
' auto-triage.ps1 is resolved relative to this file, so the pair stays portable.

Option Explicit
Dim fso, shell, hereDir, psExe, scriptPath, cmd
Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

hereDir    = fso.GetParentFolderName(WScript.ScriptFullName)
psExe      = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
scriptPath = fso.BuildPath(hereDir, "auto-triage.ps1")

cmd = """" & psExe & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & scriptPath & """"

' 0 = hidden window, False = don't wait for it to finish.
shell.Run cmd, 0, False
