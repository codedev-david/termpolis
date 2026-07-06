# Termpolis blog pipeline

Content-as-code publishing for the Termpolis article series. Articles live here as
Markdown; a weekly GitHub Action publishes the next one to **Substack** (canonical
home) and **Medium** (syndicated, with its canonical URL pointed back at Substack).

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
3. Publishes to Substack first (so its URL becomes the canonical), then Medium.
4. Flips that article to `status: published`, stamps the live URLs + date, and
   commits the change back to `main` — so nothing is ever published twice.

If nothing is `queued`, the run is a clean no-op. If a platform's secrets are
absent, that platform is skipped. If a publish *fails* mid-flight (e.g. an expired
Substack cookie), the article is emailed to you paste-ready as a fallback and its
status is left untouched so next week retries.

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
platforms: [substack, medium]  # where to publish
mediumStatus: public           # public | draft | unlisted (default public)
---
```

## One-time setup: repository secrets

The pipeline is dormant until these are set. From this repo's directory:

```bash
# --- Substack (canonical home) ---
gh secret set SUBSTACK_PUB_URL --body "https://YOURPUB.substack.com"
gh secret set SUBSTACK_COOKIES < cookie.txt   # see below for how to get this

# --- Medium (syndication) ---
gh secret set MEDIUM_TOKEN     --body "YOUR_MEDIUM_INTEGRATION_TOKEN"

# --- Email fallback (optional; reuse existing mail secrets) ---
# MAIL_USERNAME / MAIL_PASSWORD are already set for other Actions.
gh secret set MAIL_TO          --body "engelhart.david.john@gmail.com"
```

**Getting `SUBSTACK_COOKIES`** (no official API — this is a session cookie):
1. Log into your Substack in a browser.
2. Open DevTools → Network, refresh the page.
3. Click any request to `.../api/v1/...`, copy the full **`Cookie`** request-header
   value (it contains `connect.sid`). Save it to `cookie.txt` and run the command
   above. Treat this like a password; rotate it by signing out/in. It typically
   stays valid for weeks–months, and the email fallback covers you if it lapses.

**Getting `MEDIUM_TOKEN`**: Medium → Settings → *Security and apps* →
*Integration tokens* (note: Medium no longer issues new tokens to all accounts;
if you can't create one, drop `medium` from each article's `platforms`).

## Manual controls

- **Preview without publishing:** Actions → *Publish weekly blog article* → *Run
  workflow* → set **dryRun = true**. It reports the target article and does nothing.
- **Publish a specific article now:** Run workflow with **slug =** the article's
  `slug`. Ignores order/status (except it still won't run in dryRun).

## Local smoke test

```bash
pip install -r blog/requirements.txt
DRY_RUN=true python blog/scripts/publish.py      # prints the next target, no writes
```
