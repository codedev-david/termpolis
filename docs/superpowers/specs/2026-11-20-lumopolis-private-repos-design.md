# Lumopolis: opening private repositories with the computer's own git login

Status: approved by David, 2026-11-20 ("yes lets go with your recommendation"). This is the short design: a small change.

## Intent

David, 2026-11-20: for a private GitHub repo, "is there a way to ask for username and password without storing it in the app but on the machine ... similar to how we use the bash_profile view to edit the bash profile but we are not storing that actual document in the settings."

Today, Lumopolis turns git's login lookup off for its downloads (`src/main/world/gitSource.ts:61-63`: `credential.helper=`, `credential.interactive=false`, `core.askPass=`). A private https repo therefore fails with the "needs you to sign in" message. The goal is for a private repo to open as easily as a public one, while Termpolis never keeps a login.

## Goals and non-goals

**Goals:**
- A repo that `git clone` can already reach from the person's terminal opens in Lumopolis with no extra step.
- A person who is not signed in can sign in from the Lumopolis UI.
- The login is kept by the computer (Git Credential Manager, macOS Keychain, the GitHub CLI), never by Termpolis.

**Non-goals:**
- Accounts, settings or a login screen inside Termpolis.
- Supporting GitHub account passwords: GitHub has not accepted them for git since 2021.

**Anti-goals:**
- A sign-in window that pops up on its own (on a background update or at startup).
- A token stored on disk, written to a log, or placed on a command line.

## Approaches

1. **Use the computer's own git login, with a one-time token as the fallback.** *Chosen.*
   - It works with whatever the person already uses, and nothing is stored by Termpolis.
   - On Windows it is the same activity as any `git push` in a Termpolis terminal.
2. **A token dialog every time:** rejected as the main path. Every update asks again, and Termpolis holds the secret each time. It stays only as the fallback.
3. **No change** (ssh URLs, or clone it yourself): rejected. Private https repos would stay closed.

## Design

**Modes.** `gitSource` takes a login mode per run. `safetyFlags` changes only the three login flags. Every other safety flag stays: no hooks, no symlinks, fsmonitor off, no install or scripts.
- **`none`:** today's flags. Used for everything not listed below.
- **`machine`:** drops the `credential.helper=` override, so git uses the helper from the person's global or system git config. The clone is fresh, so there is no repo-local config to trust. Two cases:
  - When the person explicitly asked (Open repository, or the Sign in button), git may show the helper's own sign-in window. Git Credential Manager opens GitHub's page in the browser.
  - Background updates run with interaction off (`credential.interactive=false`, `GCM_INTERACTIVE=never`, `GIT_TERMINAL_PROMPT=0`). A login they cannot complete becomes a "Sign in needed" notice on the world, never a window.
- **`token`:** the fallback.
  - The token is held in memory for one clone or update only.
  - It is handed to git through the environment by a one-shot askpass that Termpolis ships, never on a command line.
  - It is never written to disk or logs. It is dropped when the run ends, success or failure.
  - The next update asks again.

**Flow.**
1. Open repository runs in `none` for ssh and public URLs, as today. On an https auth failure (the existing `AUTH_RE`), the message gains actions:
   - **Sign in to GitHub** (or "Sign in", for other hosts) when a git login helper is set up. Termpolis checks with `git config --get-all credential.helper`, which reads git config only, never a login store. It retries in `machine` with interaction allowed.
   - **Use a token** when no helper is set up, or as a second choice. A small in-app dialog explains what a token is and links to GitHub's token page. It retries in `token`.
2. Remember per clone that it opened via `machine`, so updates try `machine` non-interactively. A clone opened by token updates only by asking for a token again.

**Copy.** Plain words, no git jargon. The existing message at `gitSource.ts:30` is rewritten to offer the two actions instead of "Lumopolis never asks git for a login."

**Scope rules.**
- https URLs only; ssh is unchanged.
- The helper only ever receives the URL's host (git's own behaviour). URLs keep `stripUrlUserinfo`.

## Testing

- **Unit:**
  - flags for each mode, with the other safety flags proven unchanged;
  - an interactive vs background `machine` run;
  - helper detection: present, absent, or git missing;
  - the token path: never in argv, never persisted, gone after success and after failure, redacted from every error;
  - the auth failure offers the right actions;
  - a remembered `machine` clone updates without a window and shows the notice on failure.
- **Integration and e2e:**
  - a local authenticated git-over-https server fixture (no real GitHub in CI);
  - a fake credential helper proves `machine` opens a private repo and a background update never prompts;
  - the token dialog opens a private repo;
  - runs on Windows, macOS and Linux CI.
- Coverage stays at 100% for the Lumopolis files.

## Left to the builder

- The askpass mechanism detail, within the rules above.
- Where the "Sign in needed" notice sits on the world.
- How the fixture server is built.
