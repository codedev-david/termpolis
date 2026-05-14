<!--
  Template body for the per-release Microsoft Defender FP submission issue.
  Placeholders are replaced by .github/workflows/fp-submission-helper.yml:
    __TAG__            - e.g. v1.11.57
    __VERSION__        - e.g. 1.11.57
    __ASSET_NAME__     - Termpolis.Setup.__VERSION__.exe
    __ASSET_URL__      - direct GitHub release download URL
    __ASSET_SIZE__     - human-readable size, e.g. "108 MB"
    __SHA256__         - sha256 of the signed installer
-->
A new release (__TAG__) has shipped. Submit it to Microsoft for false-positive review so the new hash plus our publisher reputation continue to accrue.

## One-click portal

https://www.microsoft.com/en-us/wdsi/filesubmission

Choose **Submit a file for malware analysis** → category **Software developer** → action **This software should not be detected as malware**.

## File to upload

[`__ASSET_NAME__`](__ASSET_URL__) (__ASSET_SIZE__)

**SHA256:** `__SHA256__`

If you don't have a copy of the installer locally:

```powershell
Invoke-WebRequest -Uri "__ASSET_URL__" -OutFile "__ASSET_NAME__"
Get-FileHash "__ASSET_NAME__" -Algorithm SHA256
```

## Pre-filled form fields — paste verbatim

**Detection name** (substitute whatever Defender currently reports — rotates between `Cinjo.O!cl`, `Wacatac.B!ml`, `Sabsik.FL.B!ml`, etc.):

```
Trojan:Win32/Cinjo.O!cl
```

**Engine + signature versions** (run on a Defender-equipped Windows box and paste both):

```powershell
Get-MpComputerStatus | Select-Object AntivirusSignatureVersion, AMEngineVersion
```

**Software publisher / contact:** David Engelhart — david.engelhart@msimga.com
**Product:** Termpolis (https://termpolis.com)
**Submission category:** Software developer

**Justification (paste verbatim into the "Additional Information" box):**

> Termpolis is a code-signed multi-agent AI terminal application (https://github.com/codedev-david/termpolis) — an Electron app that orchestrates Claude Code, OpenAI Codex, Gemini CLI, and Qwen Code as user-launched subprocess terminals. Architecturally equivalent to Warp, Cursor, and the Claude Code CLI — same AI-provider→shell flow that the well-known peer ecosystem uses. The signed `Termpolis.exe` legitimately receives text from AI provider APIs (api.anthropic.com, api.openai.com, etc.) and executes shell commands the user has approved through the UI; this is the standard AI-terminal workflow, not a remote-attacker channel.
>
> The installer (`__ASSET_NAME__`, SHA256 `__SHA256__`) is signed with our SSL.com OV code-signing certificate (CN=David Engelhart, thumbprint `43025637A49BD023DED20645127D834D697D060B`). `Get-AuthenticodeSignature` reports `Valid` before Defender quarantines it.
>
> Defender's cloud-ML classifier has flagged `Termpolis.exe` (and our shortcut targets) as `Trojan:Win32/Cinjo.O!cl` ("This program is dangerous and executes commands from an attacker"). The `!cl` suffix indicates a runtime classifier judgement, not a signature match. The Cinjo family signature appears triggered by the legitimate AI-agent network→shell flow that every AI terminal exhibits. The binary has no obfuscation, packing, or unusual entry-point logic — it's a standard electron-builder NSIS package. We have no persistence beyond the user-approved NSIS shortcut creation, no auto-elevation, and no telemetry that runs without explicit opt-in (verifiable in `src/main/sentry.ts` in the public repo).
>
> Reproduction:
>   1. Download from https://github.com/codedev-david/termpolis/releases/tag/__TAG__
>   2. Run on a freshly-updated Windows 11 box with Defender enabled
>   3. Within ~60 seconds of install, Defender quarantines `%LOCALAPPDATA%\Programs\Termpolis\Termpolis.exe` and all shortcuts
>
> Happy to provide the public build pipeline (`.github/workflows/release.yml`), the v1.11.56 hardening commit (`b10c830`), or any other artifacts on request.

## After submission

- Microsoft typically replies within **24–72 hours** via `wdsisupport@microsoft.com`
- A confirmed FP triggers a cloud-definitions update that propagates to all Defender installs within hours
- Close this issue once you've received their reply

## Why per-release?

Defender's cloud-ML scores per-binary hash. Each new build starts from zero reputation until our publisher (the SSL.com OV cert) accumulates enough benign-tagged builds. After ~3–5 successful submissions, future builds typically inherit publisher reputation and stop getting flagged in the first place — at which point this workflow can be retired.
