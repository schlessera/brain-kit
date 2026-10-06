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
- **[Dismissed](dismissed.md)** — declined for review until their evidence changes
- **[Resolved](resolved.md)** — closed (auto-disappeared or fixed)
- **[Last run](last-run.md)** — most recent run metadata + auto-fixes applied

## How to interact

Review `open.md` periodically. For each issue:
- **Resolve**: move the entry to `resolved.md` with `resolved-by: manual` and `resolved-on: YYYY-MM-DD`. Re-running will not re-add it unless the underlying evidence reappears.
- **Snooze**: `brain hygiene snooze <id> --until <date or date-time> --expect-fingerprint <fp>`, or move to `snoozed.md` and add `until: YYYY-MM-DD`. Returns to open when due if still detected; one snoozed through the CLI also returns as soon as its evidence changes.
- **Dismiss as not-a-problem**: `brain hygiene dismiss <id> --expect-fingerprint <fp>`. It moves to `dismissed.md` and stays there until its evidence changes. `brain validate` still reports it.

## Latest counts

(Updated by the skill on each run that changes state.)
