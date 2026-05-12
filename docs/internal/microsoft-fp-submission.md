# Microsoft Defender False-Positive Submission — Termpolis

Submit at: <https://www.microsoft.com/en-us/wdsi/filesubmission>

Pick: **"Submit a file for malware analysis"** → category **"Software developer"** → action **"This software should not be detected as malware."**

## Files to upload

For each release that hits the FP, upload **both** the installer and the unpacked binary:

| Path | Note |
| --- | --- |
| `dist-electron-builder/Termpolis.Setup.<ver>.exe` (or release asset) | NSIS installer, signed |
| `<install-root>/Termpolis.exe` (unpacked) | The actual file Defender quarantines |

Get a clean copy of the unpacked binary by installing on a Defender-disabled VM, or by restoring the quarantined file with `MpCmdRun.exe -Restore` then copying it out before re-enabling protection.

## Form fields — copy/paste

**Detection name:** `Trojan:Win32/Cinjo.O!cl`
(Substitute whatever Defender reports for the current build — they cycle through `Wacatac.B!ml`, `Cinjo.O!cl`, `Sabsik.FL.B!ml`, etc.)

**Definition version (engine):**
On a Defender-equipped Windows box run:
```powershell
Get-MpComputerStatus | Select AntivirusSignatureVersion,AMEngineVersion
```
…and paste both numbers.

**Submission category:** Software developer
**Software publisher / contact:** David Engelhart — david.engelhart@msimga.com
**Product:** Termpolis (https://termpolis.com)
**Justification / additional information** (paste this verbatim, updating the version):

> Termpolis is an open-source, code-signed multi-agent terminal application (https://github.com/codedev-david/termpolis) — an Electron 38 app that orchestrates Claude Code, OpenAI Codex, Gemini CLI, and Qwen Code as subprocess terminals. It contains no networking code other than what users explicitly initiate through those CLIs, and no installer-side persistence beyond the NSIS shortcuts.
>
> The installer (`Termpolis.Setup.<VERSION>.exe`) is signed with our SSL.com OV code-signing certificate (CN=David Engelhart). The unpacked `Termpolis.exe` inherits that signature unmodified — `Get-AuthenticodeSignature` reports `Valid` before Defender quarantines it.
>
> Defender's cloud ML classifier has flagged `Termpolis.exe` (and our shortcut targets) as `<DETECTION NAME>` on the v<VERSION> release. The `!cl` / `!ml` suffix indicates this is a runtime classifier judgement, not a signature match. The binary has no obfuscation, packing, or unusual entry-point logic — it's a standard `electron-builder` NSIS package. We believe this is a reputation/false-positive issue typical of newly-released Electron apps that haven't yet accumulated SmartScreen telemetry, and would appreciate a review.
>
> Reproduction:
>   1. Download the v<VERSION> installer from https://github.com/codedev-david/termpolis/releases/tag/v<VERSION>
>   2. Run on a freshly-updated Windows 11 box with Defender enabled
>   3. Within ~60 seconds of install, Defender quarantines `%LOCALAPPDATA%\Programs\Termpolis\Termpolis.exe` and all shortcuts under that detection name
>
> Happy to provide the build pipeline (`.github/workflows/release.yml` in the public repo) and any other artifacts on request.

## After submission

- Microsoft typically replies in **24–72 hours** via email (`wdsisupport@microsoft.com`).
- A confirmed FP triggers a cloud definitions update that propagates to all Defender installs within ~hours.
- They sometimes ask for additional samples — keep the quarantined binary around.

## Stronger long-term remediation

1. **Submit early, submit each release.** Reputation is per-build for Defender's ML model — every new binary starts from zero until the cloud model has telemetry. Auto-submit each tag's `.exe` as part of the release workflow.
2. **EV code-signing certificate** (~$300–500/yr from DigiCert, SSL.com, or Sectigo). EV certs are hardware-token-backed and grant immediate SmartScreen reputation — Defender's ML classifier almost never overrides an EV signature. This is the single most effective change.
3. **Submit to other AV vendors too** if/when users report FPs elsewhere:
   - Kaspersky: <https://opentip.kaspersky.com/>
   - ESET: samples@eset.com
   - Bitdefender: <https://www.bitdefender.com/consumer/support/answer/29358/>
   - Sophos: <https://support.sophos.com/support/s/filesubmission>
4. **Reduce heuristic surface** — ensure full PE metadata (CompanyName, ProductName, FileDescription, LegalCopyright) is set. Currently relying on `electron-builder` defaults; explicitly set `win.legalTrademarks`, `win.publisherName`, `win.fileVersion` and verify with `(Get-Item .exe).VersionInfo` against a fresh build before shipping.
