---
type: context
title: "Content Hygiene Dashboard"
created: <TODAY>
updated: <TODAY>
tags: [hygiene, audit, content-quality, index]
relevance: primary
summary: "Content hygiene scan results — open issues, snoozed items, resolved history"
---

## Overview

The `/content-hygiene` skill scans the brain on demand. Findings live here.

- **[Open issues](open.md)** — needs review
- **[Snoozed](snoozed.md)** — deferred with `until:` dates
- **[Resolved](resolved.md)** — closed (auto-disappeared, dismissed, or fixed)
- **[Last run](last-run.md)** — most recent run metadata + auto-fixes applied

## How to interact

Review `open.md` periodically. For each issue:
- **Resolve**: move the entry to `resolved.md` with `resolved-by: manual` and `resolved-on: YYYY-MM-DD`. Re-running will not re-add it unless the underlying evidence reappears.
- **Snooze**: move to `snoozed.md` and add `until: YYYY-MM-DD`. Will return to open after that date if still detected.
- **Dismiss as not-a-problem**: move to `resolved.md` with `resolved-by: dismissed`.

## Latest counts

(Updated by the skill on each run that changes state.)
