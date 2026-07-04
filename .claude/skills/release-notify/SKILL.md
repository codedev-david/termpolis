---
name: release-notify
description: Use when cutting a Termpolis release (bumping the version / pushing a vX.Y.Z tag) or when verifying a release's CI. Covers the direct-to-main + tag flow, watching BOTH the Tests and Release pipelines to fully green via `--json conclusion`, shipping a clean patch release when a pipeline fails, and the automated release email to engelhart.david.john@gmail.com.
---

# Releasing Termpolis (and getting notified)

Termpolis releases go **directly to `main`** (no branches/PRs). A release is:
**bump `package.json` version → commit + push `main` → push a `vX.Y.Z` tag** (the tag
triggers `.github/workflows/release.yml`). The website repo (`termpolis-web`) auto-deploys
on push to its own `main`.

An email to **engelhart.david.john@gmail.com** is sent **automatically** by
`.github/workflows/notify-release-email.yml` when the Release workflow finishes — ✅ on
success (version, asset count, release URL, and both pipelines' conclusions) and ❌ on
failure. You do not send this yourself; you verify it fired.

## The rule: every pipeline must be green

Two workflows run for a release, and **both must pass**:

| Workflow | Trigger | What it gates |
|---|---|---|
| **Tests** (`test.yml`) | push to `main` | lint (`npm run lint`), typecheck/build, unit + e2e-smoke |
| **Release** (`release.yml`) | `vX.Y.Z` tag | unit tests on win+mac, update-metadata validation, build+sign+publish on 3 OSes, homebrew bump |

A published release with a red pipeline is **not** an acceptable end state.

## Procedure

1. **Verify locally before tagging** — this is where the last few releases broke:
   - `npm run lint` — **gate on the full script**, not `npx eslint <file>`. `--report-unused-disable-directives` turns an unused `// eslint-disable*` into a hard **error**, and `no-console` is globally off (`.eslintrc.cjs`), so a stray `eslint-disable-next-line no-console` fails CI even though the file "looks" fine. (Broke v1.18.2 and v1.19.0.)
   - `npm test` (vitest) — full suite. Watch for **nondeterministic / platform-dependent** tests: anything asserting order of *equal-relevance* results, or relying on `Date.now()` advancing between rapid writes, can pass on Windows and fail on macOS CI. Give such tests explicit inputs (e.g. pass `ts:` to `memoryWrite`) instead of leaning on wall-clock. (Broke v1.19.1 — the mnemeAdapt tie-break flake.)
   - Bump `package.json` `version`.

2. **Commit + push + tag:**
   ```bash
   git add -A && git commit -m "vX.Y.Z: <summary>"   # Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
   git push origin main
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

3. **Watch BOTH pipelines to completion — never trust `gh run watch`, it lies.** Poll the real conclusion:
   ```bash
   gh run list --limit 4 --json databaseId,name,status,conclusion,headBranch
   gh run view <id> --json status,conclusion -q '.status + " " + (.conclusion // "")'
   ```
   In Git Bash, avoid `/` inside `-q` jq (MSYS mangles it into a path) — use a space/other separator.

4. **If any pipeline fails:** read `gh run view <id> --log-failed`, find the failing job/step, fix the root cause. Then ship a **clean patch release** (`vX.Y.(Z+1)`) — do not leave the red tag as the release. Precedent: v1.18.2→**v1.18.3**, v1.19.0→v1.19.1→**v1.19.2**.
   - If a **partial** GitHub release published before the failure (electron-builder uploads per-OS as each build finishes), delete it so its incomplete `latest.yml` can't serve a broken auto-update: `gh release delete vX.Y.Z --yes --cleanup-tag` then `git tag -d vX.Y.Z`. Then release the clean patch.

5. **Confirm the outcome:**
   - Release published with the **full asset set** (~15: win `.exe`+blockmap, mac dmg/zip x64+arm64, linux AppImage/deb, and `latest*.yml` manifests): `gh release view vX.Y.Z --json assets -q '.assets | length'`.
   - The **Release Email** workflow ran: `gh run list --workflow "Release Email" --limit 1 --json conclusion`. A green run = David got the email.

## Notes

- Mail is sent via `dawidd6/action-send-mail@v5` → `smtp.gmail.com:465` using the repo
  secrets `MAIL_USERNAME` / `MAIL_PASSWORD` (a Gmail **app password**, not the account
  password). Same secrets power `issue-email.yml` and `notify-auto-triage-pr.yml`.
- There is **no Gmail MCP** connected to this environment — email is a CI concern, not an
  MCP one. (The only email-capable MCP is Microsoft 365 / Outlook, and it needs auth.)
- To test the email path without cutting a release, run the notifier manually:
  `gh workflow run "Release Email"` — it emails the latest release as a success dry-run.
