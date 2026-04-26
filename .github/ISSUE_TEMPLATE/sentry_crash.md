---
name: Sentry crash report (auto-created)
about: Template Sentry uses when auto-creating issues from production crashes
title: '[crash] '
labels: bug, sentry, needs-triage
assignees: ''
---

<!--
This template is what Sentry's GitHub integration uses when auto-creating
issues. Sentry will fill in the stack trace, breadcrumbs, and metadata
above this section. Leave the structure intact.
-->

## Sentry context

- **Sentry issue**: <!-- link auto-filled by Sentry -->
- **First seen**: <!-- timestamp -->
- **Affected users**: <!-- count -->
- **Environment**: <!-- production / staging / etc -->
- **Release**: <!-- version, e.g. v1.11.17 -->

## Reproduction

<!-- Sentry breadcrumbs (event log + updater events) live in the linked Sentry
     page. Click through to see what happened in the minutes leading up to
     the crash. -->

## Triage

- [ ] Confirmed reproducible / real bug (vs. user environment)
- [ ] Fix scoped — what file(s)?
- [ ] Tests added or updated
- [ ] Linked PR
