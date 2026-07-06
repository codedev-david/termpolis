#!/usr/bin/env python3
"""
Weekly auto-publisher for the Termpolis blog series.

Picks the next `status: queued` article (lowest `order`) from ``blog/content/*.md``
and publishes it to Substack (the canonical home) and Medium (syndication, with
its canonical URL pointed back at the Substack post). Idempotent: on success it
flips the article to ``status: published`` and records the live URLs, so a given
article is never published twice.

Resilience: each platform is independent. If Substack fails (expired cookie,
endpoint drift) Medium still publishes, and you get a paste-ready email fallback.
Status is only flipped to ``published`` when at least one platform succeeded.

Environment (all provided as GitHub Actions secrets):
  SUBSTACK_COOKIES   full Cookie header string incl. connect.sid  (required: Substack)
  SUBSTACK_PUB_URL   https://yourpub.substack.com                 (required: Substack)
  MEDIUM_TOKEN       Medium integration token                     (required: Medium)
  MAIL_USERNAME      SMTP user for the email fallback             (optional)
  MAIL_PASSWORD      SMTP password/app-password                   (optional)
  MAIL_TO            fallback recipient (defaults to MAIL_USERNAME)
  MAIL_HOST/MAIL_PORT SMTP server (defaults smtp.gmail.com:587)
  DRY_RUN            "true" => select + report, do not publish
  FORCE_SLUG         publish this slug regardless of order/status
"""

from __future__ import annotations

import glob
import json
import os
import smtplib
import sys
from datetime import datetime, timezone
from email.mime.text import MIMEText

import frontmatter
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
CONTENT_DIR = os.path.normpath(os.path.join(HERE, "..", "content"))
DRY_RUN = os.getenv("DRY_RUN", "false").strip().lower() == "true"
FORCE_SLUG = os.getenv("FORCE_SLUG", "").strip()


class NotConfigured(Exception):
    """A platform's required secrets are absent -- skip it quietly."""


def log(msg: str) -> None:
    print(f"[publish] {msg}", flush=True)


def load_articles():
    items = []
    for path in sorted(glob.glob(os.path.join(CONTENT_DIR, "*.md"))):
        items.append((path, frontmatter.load(path)))
    return items


def pick_target(articles):
    if FORCE_SLUG:
        for path, post in articles:
            if post.get("slug") == FORCE_SLUG:
                return path, post
        log(f"FORCE_SLUG '{FORCE_SLUG}' not found among {len(articles)} articles")
        return None
    queued = [(p, a) for (p, a) in articles if str(a.get("status")).lower() == "queued"]
    queued.sort(key=lambda pa: pa[1].get("order", 9999))
    return queued[0] if queued else None


def publish_substack(post) -> str:
    cookies = os.getenv("SUBSTACK_COOKIES", "").strip()
    pub_url = os.getenv("SUBSTACK_PUB_URL", "").strip().rstrip("/")
    if not cookies or not pub_url:
        raise NotConfigured("SUBSTACK_COOKIES / SUBSTACK_PUB_URL not set")

    from substack import Api
    from substack.post import Post

    api = Api(cookies_string=cookies, publication_url=pub_url)
    user_id = api.get_user_id()

    sp = Post(
        title=post["title"],
        subtitle=post.get("subtitle", ""),
        user_id=user_id,
        audience="everyone",
    )
    sp.from_markdown(post.content, api=api)

    draft = api.post_draft(sp.get_draft())
    draft_id = draft.get("id")
    api.prepublish_draft(draft_id)
    result = api.publish_draft(draft_id) or {}

    slug = result.get("slug") or draft.get("slug")
    return f"{pub_url}/p/{slug}" if slug else pub_url


def publish_medium(post, canonical_url) -> str:
    token = os.getenv("MEDIUM_TOKEN", "").strip()
    if not token:
        raise NotConfigured("MEDIUM_TOKEN not set")

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    me = requests.get("https://api.medium.com/v1/me", headers=headers, timeout=30)
    me.raise_for_status()
    author_id = me.json()["data"]["id"]

    body = {
        "title": post["title"],
        "contentFormat": "markdown",
        "content": f"# {post['title']}\n\n{post.content}",
        "tags": (post.get("tags") or [])[:5],
        "publishStatus": post.get("mediumStatus", "public"),
    }
    if canonical_url:
        body["canonicalUrl"] = canonical_url

    resp = requests.post(
        f"https://api.medium.com/v1/users/{author_id}/posts",
        headers=headers,
        data=json.dumps(body),
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()["data"]["url"]


def email_fallback(post, reason: str) -> None:
    user = os.getenv("MAIL_USERNAME", "").strip()
    pw = os.getenv("MAIL_PASSWORD", "").strip()
    if not (user and pw):
        log(f"no MAIL_* creds; cannot send fallback ({reason})")
        return
    to = os.getenv("MAIL_TO", "").strip() or user
    host = os.getenv("MAIL_HOST", "smtp.gmail.com").strip()
    port = int(os.getenv("MAIL_PORT", "587").strip() or "587")

    md = (
        f"{reason}\n\n"
        f"Title: {post['title']}\n"
        f"Subtitle: {post.get('subtitle', '')}\n\n"
        f"--- paste-ready markdown below ---\n\n{post.content}"
    )
    msg = MIMEText(md, "plain", "utf-8")
    msg["Subject"] = f"[Termpolis blog] Paste-ready fallback: {post['title']}"
    msg["From"] = user
    msg["To"] = to
    try:
        with smtplib.SMTP(host, port, timeout=30) as s:
            s.starttls()
            s.login(user, pw)
            s.sendmail(user, [to], msg.as_string())
        log(f"emailed paste-ready fallback to {to}")
    except Exception as e:  # noqa: BLE001 - a failing fallback must never crash the run
        log(f"email fallback failed: {e}")


def notify_medium_import(post, substack_url: str) -> None:
    """Nudge a manual Medium cross-post via 'Import a story'.

    Medium closed its publishing API to new integration tokens in 2025, so most
    accounts can't auto-publish. Importing from the Substack URL is the supported
    alternative and keeps the canonical link pointed back at Substack. Set
    MEDIUM_IMPORT_REMINDER=false to silence this.
    """
    if (os.getenv("MEDIUM_IMPORT_REMINDER") or "true").strip().lower() in ("false", "0", "no", "off"):
        return
    user = os.getenv("MAIL_USERNAME", "").strip()
    pw = os.getenv("MAIL_PASSWORD", "").strip()
    if not (user and pw):
        log("no MAIL_* creds; skipping medium-import reminder")
        return
    to = os.getenv("MAIL_TO", "").strip() or user
    host = os.getenv("MAIL_HOST", "smtp.gmail.com").strip()
    port = int(os.getenv("MAIL_PORT", "587").strip() or "587")

    body = (
        f"Published to Substack: {substack_url}\n\n"
        f"To mirror it on Medium (keeps the canonical link -> Substack):\n"
        f"  1. Open https://medium.com/p/import\n"
        f"  2. Paste this URL: {substack_url}\n"
        f"  3. Review, then Publish.\n"
    )
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = f"[Termpolis blog] Cross-post to Medium: {post['title']}"
    msg["From"] = user
    msg["To"] = to
    try:
        with smtplib.SMTP(host, port, timeout=30) as s:
            s.starttls()
            s.login(user, pw)
            s.sendmail(user, [to], msg.as_string())
        log(f"medium-import reminder emailed to {to}")
    except Exception as e:  # noqa: BLE001
        log(f"medium-import reminder failed: {e}")


def main() -> int:
    articles = load_articles()
    if not articles:
        log(f"no articles found in {CONTENT_DIR}")
        return 0

    target = pick_target(articles)
    if not target:
        log("nothing queued -- no-op (set `status: queued` on the next article)")
        return 0

    path, post = target
    platforms = post.get("platforms") or ["substack", "medium"]
    log(f"target: {post.get('slug')} (order {post.get('order')}) -> {platforms}")
    log(f"title: {post['title']}")

    if DRY_RUN:
        log(f"DRY_RUN: would publish {len(post.content)} chars to {platforms}; no changes made")
        return 0

    results = {}
    canonical = None
    attempted_failure = False

    if "substack" in platforms:
        try:
            surl = publish_substack(post)
            results["substack"] = surl
            canonical = surl if "/p/" in surl else None
            log(f"substack published: {surl}")
        except NotConfigured as e:
            log(f"substack skipped -- {e}")
        except Exception as e:  # noqa: BLE001
            attempted_failure = True
            log(f"substack FAILED: {e}")
            email_fallback(post, f"Automated Substack publish failed: {e}")

    if "medium" in platforms:
        try:
            murl = publish_medium(post, canonical)
            results["medium"] = murl
            log(f"medium published: {murl}")
        except NotConfigured as e:
            log(f"medium skipped -- {e}")
        except Exception as e:  # noqa: BLE001
            attempted_failure = True
            log(f"medium FAILED: {e}")
            email_fallback(post, f"Automated Medium publish failed: {e}")

    if results.get("substack") and not results.get("medium"):
        notify_medium_import(post, results["substack"])

    if not results:
        if attempted_failure:
            log("all publish attempts failed -- see errors above")
            return 1
        log("no platform configured yet -- dormant no-op (set secrets to arm)")
        return 0

    post["status"] = "published"
    post["urls"] = results
    post["publishedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(frontmatter.dumps(post))
    log(f"marked published: {os.path.basename(path)} -> {results}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
