---
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-react": minor
---

Show durable decisions and a read-only Queue in the existing Actions destination (#684).

- `@schlessera/brain-ui-kit` adds `EffectPreview` (the exact tool, path and full input of a stored effect, with a 12-line reveal gate and a raw-text fallback for a malformed effect) and `DispositionBar` (commit, Later and Dismiss with 44px floors and a `Recording…` state), an optional `ActionCard.footLink`, and an optional `Button.ariaLabel`.
- `@schlessera/brain-ui-react` subscribes to the durable Actions and Queue views when the host advertises them, and renders open decisions in the `needs you` lens after live approvals, grouped by thread in priority order, with notices after them and snoozed items under `Later`. FYIs are filed under `done › Notes`. Nothing changes on a tap until the server confirms it; refusals reconcile from a fresh snapshot and nothing is resent automatically.
- The Actions badge now counts live approvals plus open, non-FYI durable decisions. Run notices keep their own count in the list and no longer badge.
- A pruned run's detail now reads "Trace pruned · this run's rollup is kept."
