# Termpolis blog pipeline

Content-as-code publishing for the Termpolis article series. Articles live here as
Markdown; a weekly GitHub Action publishes the next one to **Substack** (canonical
home). **Medium** is handled via a one-click *Import a story* reminder, because
Medium closed its publishing API to new integration tokens in 2025.

## How it works

```
blog/
  content/NNN-slug.md      one article per file, with frontmatter (the queue)
  scripts/publish.py       picks the next queued article + publishes it
  requirements.txt
.github/workflows/publish-weekly.yml   cron: Mondays 14:00 UTC (+ manual trigger)
```

Each Monday the workflow runs `publish.py`, which:

1. Loads every `content/*.md`.
2. Selects the lowest-`order` article whose `status` is `queued`.
3. Publishes to **Substack** (its URL becomes the canonical). Then:
   - If a `MEDIUM_TOKEN` is set, it also API-publishes to Medium (canonical →
     Substack).
   - Otherwise it emails you a one-click **Import a story** link so you can mirror
     the post on Medium in ~10 seconds with the canonical preserved.
4. Flips that article to `status: published`, stamps the live URLs + date, and
   commits the change back to `main` — so nothing is ever published twice.

If nothing is `queued`, the run is a clean no-op. If a publish *fails* mid-flight
(e.g. an expired Substack cookie), the article is emailed to you paste-ready and
its status is left untouched so next week retries.

## Article lifecycle

Set the `status` field in each file's frontmatter:

| status      | meaning                                            |
|-------------|----------------------------------------------------|
| `draft`     | not ready — the pipeline ignores it                |
| `queued`    | ready — eligible to publish, lowest `order` wins   |
| `published` | already live (set automatically; do not hand-edit) |

Articles 002–008 ship as `draft` outlines. Flesh one out, change its `status` to
`queued`, and it becomes the next post to go live.

### Frontmatter reference

```yaml
---
title: "Meet Termpolis: One Terminal for All Your AI Coding Agents"
subtitle: "One-line hook shown under the title."
slug: meet-termpolis          # stable id; used by FORCE_SLUG
order: 1                       # publish order among queued articles
status: queued                 # draft | queued | published
tags: [AI, Developer Tools]    # Medium uses up to 5
platforms: [substack, medium]  # medium is skipped w/o a token (import reminder instead)
mediumStatus: public           # public | draft | unlisted (default public)
---
```

## One-time setup: repository secrets

The pipeline is dormant until Substack is configured. From this repo's directory:

```bash
# --- Substack (required, canonical home) ---
gh secret set SUBSTACK_PUB_URL --body "https://YOURPUB.substack.com"
gh secret set SUBSTACK_COOKIES < cookie.txt   # see below for how to get this

# --- Email (reused for reminders + failure fallback) ---
# MAIL_USERNAME / MAIL_PASSWORD already exist for other Actions.
gh secret set MAIL_TO --body "engelhart.david.john@gmail.com"   # optional
```

**Getting `SUBSTACK_COOKIES`** (no official API — this is a session cookie):
1. Log into your Substack in a browser.
2. Open DevTools (F12) → Network, refresh the page.
3. Click any request to `.../api/v1/...`, right-click → **Copy → Copy as fetch
   (Node.js)**, and grab the full string assigned to the `cookie` header (it
   contains `connect.sid`). Save it to `cookie.txt` and run the command above.
   Treat it like a password; rotate by signing out/in. It usually lasts weeks–
   months, and the email fallback covers you if it lapses.

### Medium (optional — most accounts can't)

Medium stopped issuing integration tokens in 2025. **If Settings → Security and
apps has no "Integration tokens" section, that's expected — you can't get one.**
Leave `MEDIUM_TOKEN` unset: each week, after Substack publishes, you'll get an
email with a one-click <https://medium.com/p/import> link (paste the Substack URL,
click Publish — the canonical link is preserved). If you *do* have an old pre-2025
token, set it and Medium auto-publishes via API instead:

```bash
gh secret set MEDIUM_TOKEN --body "OLD_PRE_2025_TOKEN"
```

Don't want Medium at all? Turn the reminder off:

```bash
gh variable set MEDIUM_IMPORT_REMINDER --body "false"
```

## Manual controls

- **Preview without publishing:** Actions → *Publish weekly blog article* → *Run
  workflow* → set **dryRun = true**. It reports the target article and does nothing.
- **Publish a specific article now:** Run workflow with **slug =** the article's
  `slug`. Ignores order/status (still won't run in dryRun).

## Local smoke test

```bash
pip install -r blog/requirements.txt
DRY_RUN=true python blog/scripts/publish.py      # prints the next target, no writes
```
