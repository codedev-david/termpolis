# Publishing Termpolis to Package Managers

## Prerequisites

After each release, download the installers and compute SHA256 hashes:

```powershell
# Windows .exe
certutil -hashfile "Termpolis Setup 1.4.1.exe" SHA256

# macOS .dmg (on Mac)
shasum -a 256 Termpolis-1.4.1.dmg
```

Replace all `REPLACE_WITH_SHA256` placeholders in the manifests below.

---

## Winget (Windows Package Manager)

Users install with: `winget install codedev-david.Termpolis`

### Steps

1. Fork [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs)
2. Create the manifest directory:
   ```
   manifests/c/codedev-david/Termpolis/1.4.1/
   ```
3. Copy `packaging/winget/codedev-david.Termpolis.yaml` there (with SHA256 filled in)
4. Submit a PR to `microsoft/winget-pkgs`
5. Microsoft reviews and merges (typically 1-3 days)

### Updating for new versions

Update the version, URL, and SHA256 in the yaml and submit a new PR.

---

## Chocolatey (Windows)

Users install with: `choco install termpolis`

### First-time setup

1. Create account at [community.chocolatey.org](https://community.chocolatey.org/account/Register)
2. Get your API key from [account page](https://community.chocolatey.org/account)

### Steps

1. Update SHA256 in `packaging/chocolatey/tools/chocolateyinstall.ps1`
2. Update version in `packaging/chocolatey/termpolis.nuspec`
3. Pack and push:
   ```powershell
   cd packaging/chocolatey
   choco pack
   choco push termpolis.1.4.1.nupkg --source https://push.chocolatey.org/ --api-key YOUR_API_KEY
   ```
4. Goes through moderation review (typically 2-7 days)

### Updating for new versions

Update version in `.nuspec`, URL and SHA256 in `chocolateyinstall.ps1`, then pack and push.

---

## Homebrew (macOS)

Users install with: `brew tap codedev-david/tap && brew install --cask termpolis`

### First-time setup

1. Create a public repo: `codedev-david/homebrew-tap`
2. Copy `packaging/homebrew/termpolis.rb` to `Casks/termpolis.rb` in that repo (with SHA256 filled in)
3. Push to the repo

### Updating for new versions

Update version and SHA256 in `Casks/termpolis.rb` and push.

### Getting into homebrew-cask (optional, for `brew install --cask termpolis` without tap)

Once the app has enough users, submit a PR to [Homebrew/homebrew-cask](https://github.com/Homebrew/homebrew-cask). Requirements:
- App must be well-known or have significant GitHub stars
- Must have a stable release history
